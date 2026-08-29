/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统: OverlayFS = DynamicRequest(读: 对接 service/fs → opencode) + InMemory(写: 本地暂存).
 *   - explorer/编辑器读: DynamicRequest → readDirectory/readFile/stat 回调 → service/fs → opencode
 *   - 编辑器保存: OverlayFS 写 InMemory (本地立即成功) → SavedEvent → onDidSaveTextDocument → service/fs 推服务器
 *   - explorer 删除: onDidDeleteFiles → service/fs 删服务器
 *   - baseContent 读自 overlay 本地层 → 保存前后内容一致 → 无 md5 对比误报
 */

import fs from '@codeblitzjs/ide-browserfs/lib/core/node_fs';
import { FileType } from '@codeblitzjs/ide-browserfs/lib/core/node_fs_stats';
import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { getFileSystemService } from '../service/fs';

/** BrowserFS 路径 → IDE 相对路径（去 /workspace 前缀） */
function workspaceRel(path: string): string {
  const p = path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;
  return p || '/';
}

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
        // 写侧: InMemory 本地暂存, 保存立即成功; 由 onDidSaveTextDocument 单推服务器
        writable: {
          fs: 'InMemory',
          options: {},
        },
      },
    },
    // 写: 编辑器保存 → 直接落盘 opencode (BrowserFS 只读, 写侧单推)
    onDidSaveTextDocument: async ({ filepath, content }) => {
      const fsApi = getFileSystemService();
      const rel = workspaceRel(filepath);
      try {
        await fsApi.write(rel, content);
        console.log(`[runtime] sync write → opencode: ${rel}`, JSON.stringify(content.slice(0, 40)));
      } catch (err) {
        console.warn('[runtime] sync write failed:', filepath, err);
      }
    },
    // 建: explorer 新建目录/文件 → BrowserFS 本地 stat 判类型 → 目录 mkdirp 落服务器;
    //     文件由保存 (onDidSaveTextDocument) 推, 这里不动 (避免空文件覆盖)
    onDidCreateFiles: (files) => {
      (files || []).forEach(async (f) => {
        const rel = workspaceRel(f);
        // 本地 overlay 里 stat 判类型 (新建的目录/文件都在 writable InMemory)
        let isDir = false;
        try {
          const browserPath = f.startsWith(WORKSPACE_ROOT) ? f : `${WORKSPACE_ROOT}${f.startsWith('/') ? '' : '/'}${f}`;
          isDir = fs.statSync(browserPath).isDirectory();
        } catch (e) {
          console.warn('[runtime] sync create stat failed:', f, e);
          return;
        }
        if (!isDir) return; // 文件: 等保存推
        const fsApi = getFileSystemService();
        try {
          await fsApi.mkdirp(rel);
          console.log(`[runtime] sync mkdir → opencode: ${rel}`);
        } catch (err) {
          console.warn('[runtime] sync mkdir failed:', f, err);
        }
      });
    },
    // 注意: onDidChangeFiles 由 IFileServiceClient.onFilesChanged 驱动,
    // 而 onFilesChanged 会收到我们 fireFilesChange 的"外部变化"事件 → 写回旧内容/覆盖新建, 形成循环。
    // 读侧走 DynamicRequest, 写侧走本钩子单推, 无需这些钩子。
    onDidChangeTextDocument: (_args) => {
      // 实时变更不即时同步 (防抖由保存触发)
    },
    // 删: explorer 删除 → 落盘 opencode
    onDidDeleteFiles: (files) => {
      (files || []).forEach(async (f) => {
        const fsApi = getFileSystemService();
        const rel = workspaceRel(f);
        try {
          await fsApi.rm(rel);
          console.log(`[runtime] sync delete → opencode: ${rel}`);
        } catch (err) {
          console.warn('[runtime] sync delete failed:', f, err);
        }
      });
    },
  },
} as any;
