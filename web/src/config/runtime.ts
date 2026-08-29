/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统: OverlayFS = DynamicRequest(读: 对接 service/fs → opencode) + WriteSyncFS(写: InMemory 本地 + 同步服务器).
 *   - 读: DynamicRequest.readDirectory/readFile/stat 回调 → service/fs → opencode
 *   - 写: WriteSyncFS 继承 SyncKeyValueFileSystem (InMemory 存储, 完整目录树/stat/读语义),
 *         覆写 sync 版写方法: 本地落盘后 fire-and-forget 推服务器 (service/fs → opencode).
 *         所有 BrowserFS 写操作 (编辑器保存/PDF setContent/explorer 新建删除) 最终都汇聚到
 *         _syncSync / mkdirSync / unlinkSync / rmdirSync / renameSync → 天然全覆盖, 无需事件钩子
 *   - 读优先 writable (InMemory 本地改过), 未改 fallback readable (DynamicRequest → 服务器)
 *
 * 为什么继承 InMemory 语义而不是纯透传: OverlayFS.createParentDirectoriesAsync 会 stat writable
 *   父目录判根 (EBUSY: root does not exist), 纯透传后端无目录树 → 崩. InMemory 自带根 + 目录结构.
 * 为什么继承 SyncKeyValueFileSystem 而不是 InMemory: InMemory 构造函数 private, 基类 public 可继承.
 */

import { FileType } from '@codeblitzjs/ide-browserfs/lib/core/node_fs_stats';
import Stats from '@codeblitzjs/ide-browserfs/lib/core/node_fs_stats';
import { InMemoryStore } from '@codeblitzjs/ide-browserfs/lib/backend/InMemory';
import { SyncKeyValueFileSystem } from '@codeblitzjs/ide-browserfs/lib/generic/key_value_filesystem';
import { BrowserFS } from '@codeblitzjs/ide-sumi-core/lib/server/node';
import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { getFileSystemService } from '../service/fs';

/** BrowserFS 路径 → IDE 相对路径（去 /workspace 前缀） */
function workspaceRel(path: string): string {
  const p = path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;
  return p || '/';
}

// ---- WriteSyncFS: InMemory 存储 + 写操作同步服务器 ----

export class WriteSyncFS extends SyncKeyValueFileSystem {
  static readonly Name = 'WriteSyncFS';
  static readonly Options = {};

  constructor() {
    super({ store: new InMemoryStore() });
  }

  static Create(opts: unknown, cb: (err: Error | null, fs?: WriteSyncFS) => void): void {
    cb(null, new WriteSyncFS());
  }

  static isAvailable(): boolean {
    return true;
  }

  getName(): string {
    return WriteSyncFS.Name;
  }

  /** 写文件 (最终汇聚点: open+write+close / writeFile / appendFile 都到这) */
  override _syncSync(p: string, data: Buffer, stats: Stats): void {
    super._syncSync(p, data, stats);
    void this.syncWrite(workspaceRel(p), data);
  }

  override mkdirSync(p: string, mode: number): void {
    super.mkdirSync(p, mode);
    void this.syncMkdir(workspaceRel(p));
  }

  override unlinkSync(p: string): void {
    super.unlinkSync(p);
    void this.syncRm(workspaceRel(p));
  }

  override rmdirSync(p: string): void {
    super.rmdirSync(p);
    void this.syncRm(workspaceRel(p));
  }

  override renameSync(oldPath: string, newPath: string): void {
    super.renameSync(oldPath, newPath);
    void this.syncMove(workspaceRel(oldPath), workspaceRel(newPath));
  }

  // ---- 服务器同步 (fire-and-forget, 失败仅告警不阻塞本地) ----

  private async syncWrite(rel: string, data: Buffer): Promise<void> {
    try {
      const content = data.toString('utf8');
      await getFileSystemService().write(rel, content);
      console.log(`[bfs] write → opencode: ${rel}`, JSON.stringify(content.slice(0, 40)));
    } catch (e) {
      console.warn('[bfs] sync write failed:', rel, e);
    }
  }

  private async syncMkdir(rel: string): Promise<void> {
    try {
      await getFileSystemService().mkdirp(rel);
      console.log(`[bfs] mkdir → opencode: ${rel}`);
    } catch (e) {
      console.warn('[bfs] sync mkdir failed:', rel, e);
    }
  }

  private async syncRm(rel: string): Promise<void> {
    try {
      await getFileSystemService().rm(rel);
      console.log(`[bfs] rm → opencode: ${rel}`);
    } catch (e) {
      console.warn('[bfs] sync rm failed:', rel, e);
    }
  }

  private async syncMove(from: string, to: string): Promise<void> {
    try {
      await getFileSystemService().move(from, to);
      console.log(`[bfs] move → opencode: ${from} → ${to}`);
    } catch (e) {
      console.warn('[bfs] sync move failed:', from, to, e);
    }
  }
}

// 注册 WriteSyncFS 为 BrowserFS 后端 (挂载前, 模块加载时)
BrowserFS.addFileSystemType(WriteSyncFS.Name, WriteSyncFS as any);

export const runtimeConfig: IAppRendererProps['runtimeConfig'] = {
  workspace: {
    filesystem: {
      fs: 'OverlayFS',
      options: {
        readable: {
          fs: 'DynamicRequest',
          options: {
            // 列目录: BrowserFS 路径 → IDE 相对路径 → service.list → FileEntry [name, FileType]
            readDirectory: async (p) => {
              const entries = await getFileSystemService().list(workspaceRel(p));
              return entries.map((e): [string, FileType] => [
                e.name,
                e.type === 'directory' ? FileType.DIRECTORY : FileType.FILE,
              ]);
            },
            // 读文件: 返回 Uint8Array (service.read 对齐 vscode API)
            readFile: async (p) => getFileSystemService().read(workspaceRel(p)),
            // stat: service.meta → FileStat (size; 无 stat 时 DynamicRequest 读文件回填)
            stat: async (p) => {
              const meta = await getFileSystemService().meta(workspaceRel(p));
              return { size: meta.size };
            },
          },
        },
        // 写侧: WriteSyncFS (InMemory + 写同步服务器) — 所有写操作 fs 层自动同步, 无需事件钩子
        writable: {
          fs: WriteSyncFS.Name,
          options: {},
        },
      },
    },
  },
} as any;
