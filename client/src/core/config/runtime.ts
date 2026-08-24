/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统: OverlayFS (InMemory 可写 + DynamicRequest 只读)
 *   - writable: InMemory      内存可写层 (浏览器侧编辑/镜像占位)
 *   - readable: DynamicRequest 远程只读层 (经 service/filesystem 拉取)
 *
 * 路径: file:// URI → IFileSystem（opensumi IFileService 标准）:
 *   - readDirectory → getFileStat(uri).children
 *   - readFile      → resolveContent(uri)
 *   - write         → setContent / createFile
 *   - delete        → delete(uri)
 *   - create        → createFile / createFolder
 */

import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { getFileSystemService } from '../../service/filesystem';
import { toFileUri } from '../../service/base';

/** 相对路径 → file:// URI（根 = sandbox cwd） */
function relToUri(filepath: string): string {
  return toFileUri(filepath);
}

/** DynamicRequest readDirectory 回调 */
async function sandboxReadDirectory(path: string): Promise<Array<[string, number]>> {
  const uri = path.startsWith('file://') ? path : relToUri(path);
  const stat = await getFileSystemService().getFileStat(uri);
  const entries = stat?.children || [];
  return entries.map((e) => {
    const name = e.uri.split('/').pop() || '';
    return [name, e.isDirectory ? 2 : 1];
  });
}

/** DynamicRequest readFile 回调 */
async function sandboxReadFile(path: string): Promise<Uint8Array> {
  const uri = path.startsWith('file://') ? path : relToUri(path);
  const { content } = await getFileSystemService().resolveContent(uri);
  return new TextEncoder().encode(content || '');
}

/** 保存/删除 → 同步宿主机 */
function syncToSandbox(op: 'write' | 'delete', filepath: string, content?: string): void {
  void (async () => {
    try {
      const fsApi = getFileSystemService();
      const uri = relToUri(filepath);
      if (op === 'write' && typeof content === 'string') {
        const stat = await fsApi.getFileStat(uri);
        if (stat) {
          await fsApi.setContent(stat, content);
        } else {
          await fsApi.createFile(uri, { content });
        }
      } else if (op === 'delete') {
        await fsApi.delete(uri);
      }
    } catch (err) {
      console.warn('[runtime] sync to sandbox failed:', op, filepath, err);
    }
  })();
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
            const uri = relToUri(f);
            if (await isDirOnBrowser(f)) {
              await getFileSystemService().createFolder(uri);
            } else {
              await getFileSystemService().createFile(uri, { content: '' });
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