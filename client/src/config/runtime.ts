/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 文件系统: RemoteFS（core/config/bfs.ts, BrowserFS backend, 读写全透传 opencode）
 *   - opensumi 容器（explorer/编辑器）经 BrowserFS 访问, 内部调 service/fs 单实例
 *     （业务代码经 useInjectable(FsToken) 访问同一实例 → 单实例统一）
 *   - 读写全直连 opencode /api/fs/*（无缓存: 外部修改立即可见, 保存/创建/删除立即落盘, 无循环写回）
 *
 * 保存同步: onDidSaveTextDocument → write（backend 已直落 opencode, 此处幂等兜底）
 */

import { WORKSPACE_ROOT, type IAppRendererProps } from '@codeblitzjs/ide-core';

import { getFileSystemService } from '../service/fs';

/** BrowserFS 路径 → IDE 相对路径（去 /workspace 前缀） */
function workspaceRel(path: string): string {
  const p = path.startsWith(WORKSPACE_ROOT) ? path.slice(WORKSPACE_ROOT.length) : path;
  return p || '/';
}

/** 保存 → 同步 opencode fs（backend 已直落, 此处幂等兜底） */
function syncToFs(op: 'write' | 'delete', filepath: string, content?: string): void {
  void (async () => {
    try {
      const fsApi = getFileSystemService();
      const rel = workspaceRel(filepath);
      if (op === 'write' && typeof content === 'string') {
        await fsApi.write(rel, content);
        console.log(`[runtime] sync write → opencode: ${rel}`, JSON.stringify(content.slice(0, 40)));
      } else if (op === 'delete') {
        await fsApi.rm(rel);
        console.log(`[runtime] sync delete → opencode: ${rel}`);
      }
    } catch (err) {
      console.warn('[runtime] sync to opencode failed:', op, filepath, err);
    }
  })();
}

export const runtimeConfig: IAppRendererProps['runtimeConfig'] = {
  workspace: {
    filesystem: {
      fs: 'RemoteFS',
      options: {},
    },
    onDidSaveTextDocument: ({ filepath, content }) => {
      syncToFs('write', filepath, content);
    },
    // 注意: onDidChangeFiles / onDidCreateFiles 由 IFileServiceClient.onFilesChanged 驱动,
    // 而 onFilesChanged 会收到我们 fireFilesChange 的"外部变化"事件 → 写回旧内容/覆盖新建, 形成循环。
    // backend 已把浏览器侧读写直落 opencode, 无需这些钩子; 保存由 onDidSaveTextDocument 兜底。
    onDidChangeTextDocument: (_args) => {
      // 实时变更不即时同步 (防抖由保存触发)
    },
    onDidDeleteFiles: (files) => {
      (files || []).forEach((f) => syncToFs('delete', f));
    },
  },
} as any;