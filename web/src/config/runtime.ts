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
import { BrowserFS, fs as browserNodeFs } from '@codeblitzjs/ide-sumi-core/lib/server/node';
import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { getFileSystemService, recordSyncedHash } from '../service/fs';

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

  /** 清空 writable InMemory 缓存: 外部文件变更后调用, 让 OverlayFS stat/readdir
   *  fallback 到 readable (DynamicRequest → opencode 真实数据), 否则 InMemory 里
   *  旧目录树 (挂载/展开时写入) 优先, explorer 看到过期列表. 已保存内容在服务器, 无丢失. */
  clearCache(): void {
    (this as any).store?.clear?.();
  }

  static Create(opts: unknown, cb: (err: Error | null, fs?: WriteSyncFS) => void): void {
    const inst = new WriteSyncFS();
    registerWriteSyncFS(inst);
    cb(null, inst);
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
      // 断循环: 记录自己写的内容 hash, watcher 事件对比一致 skip 不 fire.
      // await 保证 hash 先于 watcher 防抖对比写入 (否则 fire-and-forget 竞态 → 还是 fire)
      await recordSyncedHash(rel, content);
      console.log(`[bfs] write → opencode: ${rel}`, JSON.stringify(content.slice(0, 40)));
    } catch (e) {
      console.warn('[bfs] sync write failed:', rel, e);
    }
  }

  private async syncMkdir(rel: string): Promise<void> {
    try {
      await getFileSystemService().mkdirp(rel);
      // 记录"自己建过" (watcher rename 事件对比 skip, 不断循环)
      recordSyncedHash(rel, null);
      console.log(`[bfs] mkdir → opencode: ${rel}`);
    } catch (e) {
      console.warn('[bfs] sync mkdir failed:', rel, e);
    }
  }

  private async syncRm(rel: string): Promise<void> {
    try {
      await getFileSystemService().rm(rel);
      // 记录"自己删过" → watcher 事件 readPathHash 返 null, 对比一致 skip
      recordSyncedHash(rel, null);
      console.log(`[bfs] rm → opencode: ${rel}`);
    } catch (e) {
      console.warn('[bfs] sync rm failed:', rel, e);
    }
  }

  private async syncMove(from: string, to: string): Promise<void> {
    try {
      await getFileSystemService().move(from, to);
      // 记录"自己移过": 源已不存在 (null), 目标新内容未知 → 记 null 让 watcher 跳过 rename 事件
      recordSyncedHash(from, null);
      recordSyncedHash(to, null);
      console.log(`[bfs] move → opencode: ${from} → ${to}`);
    } catch (e) {
      console.warn('[bfs] sync move failed:', from, to, e);
    }
  }
}

// 注册 WriteSyncFS 为 BrowserFS 后端 (挂载前, 模块加载时)
BrowserFS.addFileSystemType(WriteSyncFS.Name, WriteSyncFS as any);

/** 全局持有 WriteSyncFS 实例 (挂载后由 codeblitz 创建, 供 fs.ts 外部变更后 clearCache) */
const WRITE_FS_KEY = '__APP_WRITE_SYNC_FS__';
export function registerWriteSyncFS(fs: WriteSyncFS | null): void {
  (window as any)[WRITE_FS_KEY] = fs;
}

/** 重置 BrowserFS readable (DynamicRequest) 的 FileIndex 缓存:
 *  外部文件变更后调用, 让 stat/readdir 重新从后端拉真实目录 (否则 entriesLoaded 缓存旧列表). */
export function resetBrowserFSCache(): void {
  try {
    const root = (browserNodeFs as any).getRootFS?.();
    // 收集所有可重置的 fs (根 OverlayFS / MountableFileSystem 挂载点的 OverlayFS)
    const candidates: any[] = [];
    if (root?._readable || root?._writable) {
      candidates.push(root);
    }
    // MountableFileSystem: mntMap / _mntMap (path → fs)
    const mnt = root?.mntMap || root?._mntMap || root?._mnts;
    if (mnt) {
      for (const k of Object.keys(mnt)) {
        const fs = mnt[k] || mnt.get?.(k);
        if (fs) candidates.push(fs);
      }
    }
    for (const fs of candidates) {
      // 递归清 (嵌套 OverlayFS: Mountable → OverlayFS(_fs) → UnlockedOverlayFS(_readable/_writable))
      const clearOne = (f: any): void => {
        if (!f) return;
        // 注意: 不清 writable InMemory (WriteSyncFS) — 目录树被清后 OverlayFS 写文件 EBUSY.
        // 只重置 readable (DynamicRequest) 的 entriesLoaded.
        const readable = (f as any)._readable || (f as any)._fs;
        if (readable?._index) {
          // 只清根目录 inode 的 entriesLoaded (保留树结构): 下次 loadEntry 重新 readDirectory 拉最新.
          // 不能整体重置 _index (explorer root 节点依赖, 清空会崩树).
          try {
            const idx = readable._index._index || {};
            let cleared = 0;
            for (const p of Object.keys(idx)) {
              const inode = idx[p];
              if (inode && typeof inode === 'object' && 'entriesLoaded' in inode && inode.entriesLoaded) {
                inode.entriesLoaded = false;
                cleared++;
              }
            }
            if (cleared > 0) console.log('[bfs-reset] entriesLoaded reset:', cleared);
          } catch { /* ignore */ }
        }
        // 嵌套: OverlayFS._fs / _mu 也可能是 OverlayFS
        clearOne((f as any)._fs);
        clearOne((f as any)._mu);
        clearOne((f as any)._readable);
        clearOne((f as any)._writable);
      };
      clearOne(fs);
    }
  } catch (e) {
    console.warn('[bfs-reset] fail:', e);
  }
}

/** 暴露 resetBrowserFSCache 到全局 (fs.ts 避免循环 import 直接读) */
(window as any).__RESET_BFS_CACHE__ = resetBrowserFSCache;

/** 从 OverlayFS deletionLog 恢复指定路径 (文件真实存在时不能标记"已删"):
 *  历史残留/误删标记会让 OverlayFS 一直认为文件不存在, 挡住 explorer/编辑器, 甚至触发反向删除远程. */
export function restoreFromDeletionLog(relPath: string): void {
  try {
    const key = relPath.startsWith('/') ? relPath : `/${relPath}`;
    const root = (browserNodeFs as any).getRootFS?.();
    const mnt = root?.mntMap || root?._mntMap;
    const visit = (f: any): void => {
      if (!f) return;
      const overlay = f._readable?.constructor?.name === 'UnlockedOverlayFS'
        ? f._readable
        : (f._fs?.constructor?.name === 'UnlockedOverlayFS' ? f._fs : null);
      if (overlay?._deletedFiles && overlay._deletedFiles[key] === true) {
        delete overlay._deletedFiles[key];
        // 重建 deletionLog (只保留仍删除的路径)
        const newLog = Object.keys(overlay._deletedFiles)
          .filter((k) => overlay._deletedFiles[k])
          .map((k) => `d${k}\n`)
          .join('');
        overlay._deleteLog = newLog;
        try { overlay._writable?.writeFileSync?.('/.browserfs_deletedFiles.log', newLog, 'utf8', 'w', 420); } catch { /* ignore */ }
        console.log('[bfs-restore] deletionLog restored:', key);
      }
      visit(f._fs); visit(f._mu); visit(f._readable); visit(f._writable);
    };
    if (mnt) for (const k of Object.keys(mnt)) visit(mnt[k]);
    visit(root);
  } catch { /* ignore */ }
}
(window as any).__RESTORE_DELETION_LOG__ = restoreFromDeletionLog;

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
            // 不提供 stat: DynamicRequest 官方设计 (stat 可选, 缺省 size=-1, open 读文件时自动回填真实 buffer 长度).
            // 提供 stat 会与 readFile 产生 size 不一致: stat 走 FsPty (磁盘真实字节, 含末尾换行),
            // readFile 走 SDK (文本内容 strip 末尾换行) → 差 1 字节 → PreloadFile 校验 EINVAL
            //   (实测 index.html 磁盘 23465 = "</html>\n", SDK 读回 23464)
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
