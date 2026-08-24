/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统: OverlayFS (InMemory 可写 + DynamicRequest 只读)
 *   - writable: InMemory      内存可写层 (浏览器侧编辑/镜像占位)
 *   - readable: DynamicRequest 远程只读层 (经 service/filesystem 拉取)
 *
 * 路径映射: BrowserFS 以 WORKSPACE_ROOT (/workspace) 为挂载根,
 *   sandboxRel() 去前缀 → IDE 相对路径 → IFileSystem 操作.
 *
 * 读写同步钩子: 保存/变更/创建/删除 → 同步宿主机 (service/filesystem).
 */

import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { FILE_TYPE_DIR, FILE_TYPE_FILE } from '../commands/fs';
import { getFileSystemService } from '../../service/filesystem';

function sandboxRel(path: string): string {
  const p = path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;
  return p || '/';
}

/** DynamicRequest readDirectory 回调 */
async function sandboxReadDirectory(path: string): Promise<Array<[string, number]>> {
  const entries = await getFileSystemService().readdir(sandboxRel(path));
  return entries.map((e) => [e.name, e.type === 'directory' ? FILE_TYPE_DIR : FILE_TYPE_FILE]);
}

/** DynamicRequest readFile 回调 */
async function sandboxReadFile(path: string): Promise<Uint8Array> {
  const text = await getFileSystemService().readFile(sandboxRel(path));
  const str = typeof text === 'string' ? text : new TextDecoder().decode(text);
  return new TextEncoder().encode(str || '');
}

/** 保存/删除 → 同步宿主机 */
function syncToSandbox(op: 'write' | 'delete', filepath: string, content?: string): void {
  void (async () => {
    try {
      const fsApi = getFileSystemService();
      if (op === 'write' && typeof content === 'string') {
        await fsApi.writeFile(filepath, content);
      } else if (op === 'delete') {
        await fsApi.rm(filepath);
      }
    } catch (err) {
      console.warn('[runtime] sync to sandbox failed:', op, filepath, err);
    }
  })();
}

function relToUri(filepath: string): string {
  return `file://${WORKSPACE_ROOT}/${filepath}`;
}

/** 查询浏览器侧是否为目录 */
async function isDirOnBrowser(filepath: string): Promise<boolean> {
  try {
    const fileService = (window as any).__APP_FILE_SERVICE__;
    if (!fileService) return false;
    const stat = await fileService.getFileStat(relToUri(filepath));
    return !!stat?.isDirectory;
  } catch {
    return false;
  }
}

export const runtimeConfig: IAppRendererProps['runtimeConfig'] = {
  workspace: {
    filesystem: {
      fs: 'OverlayFS',
      options: {
        writable: { fs: 'InMemory' },
        readable: {
          fs: 'DynamicRequest',
          options: {
            readDirectory: sandboxReadDirectory,
            readFile: sandboxReadFile,
          },
        },
      },
    },
    onDidSaveTextDocument: ({ filepath, content }) => {
      syncToSandbox('write', filepath, content);
    },
    onDidChangeFiles: (files) => {
      (files || []).forEach((f) => {
        if (f?.filepath && typeof f.content === 'string') {
          syncToSandbox('write', f.filepath, f.content);
        }
      });
    },
    onDidChangeTextDocument: (_args) => {
      // 实时变更不即时同步 (防抖由保存触发)
    },
    onDidCreateFiles: (files) => {
      (files || []).forEach((f) => {
        void (async () => {
          try {
            const isDir = await isDirOnBrowser(f);
            if (isDir) {
              await getFileSystemService().mkdir(f);
            } else {
              await getFileSystemService().writeFile(f, '');
            }
          } catch (err) {
            console.warn('[runtime] create sync failed:', f, err);
          }
        })();
      });
    },
    onDidDeleteFiles: (files) => {
      (files || []).forEach((f) => syncToSandbox('delete', f));
    },
  },
} as any;