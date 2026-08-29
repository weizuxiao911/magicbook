/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统 (读侧): DynamicRequest 对接 service/fs 单实例 → opencode.
 *   - explorer/编辑器读文件: BrowserFS DynamicRequest → readDirectory/readFile/stat 回调 → service/fs
 *   - 写侧: 不挂可写 BrowserFS backend, 由 onDidSaveTextDocument (写) / onDidDeleteFiles (删) 单推 opencode
 *   - 删除的 readdir 手动实现: DynamicRequest 内部会用 readDirectory 构建索引, 无需手写 readdir
 */

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
    // 注意: onDidChangeFiles / onDidCreateFiles 由 IFileServiceClient.onFilesChanged 驱动,
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
