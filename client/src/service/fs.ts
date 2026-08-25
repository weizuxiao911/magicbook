/**
 * filesystem 实现 — service/fs.ts
 *
 * implements core/commands/fs 的 IFileSystem（相对路径 + 简单方法）:
 *   - list / read / write / rm / mkdirp / move / find
 *   - 对接 server /fs/*（fs_base_url 由 sandbox 返回, 含 /fs 前缀）
 *   - 单实例: BrowserFS backend（core/config/bfs.ts, RemoteFS）内部调用本实例,
 *     opensumi 容器与业务代码共用同一文件系统实例
 *
 * 路径: 一律 IDE 相对路径（/foo）, server 在 cwd 下操作.
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { Domain, CommandService, FileChangeType, URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { WorkbenchEditorService, EditorOpenType } from '@opensumi/ide-editor';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';

import type { FsEntry, FileMeta, IFileSystem } from '../core/commands/fs';
import { FsToken } from '../core/commands/fs';

/** 服务地址（从 appBaseUrl 拼接 /fs） */
function fsBaseUrl(): string {
  const base = ((window as any).__APP_CONFIG__?.appBaseUrl || '').replace(/\/+$/, '');
  return base ? `${base}/fs` : '';
}

/** 从 registry metadata 构建 customEditor 映射: 文件扩展名 → viewType（如 {'.html':'htmlPreview', '.paper':'paperEditor'}） */
function buildCustomEditorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const meta: any[] = (window as any).__APP_REGISTRY_METADATA__ || [];
  for (const m of meta) {
    const ces = m?.packageJSON?.contributes?.customEditors;
    if (!Array.isArray(ces)) continue;
    for (const ce of ces) {
      const viewType = ce?.viewType;
      if (typeof viewType !== 'string') continue;
      for (const sel of Array.isArray(ce?.selector) ? ce.selector : []) {
        const pat = sel?.filenamePattern;
        if (typeof pat === 'string' && pat.startsWith('*.')) {
          map[pat.slice(1)] = viewType; // '*.html' → '.html'
        }
      }
    }
  }
  return map;
}

/** uri 匹配 customEditor → 返回 viewType（无匹配返回空） */
function matchCustomEditor(uri: string, map: Record<string, string>): string {
  for (const ext of Object.keys(map)) {
    if (uri.endsWith(ext)) return map[ext];
  }
  return '';
}

/** 当前 cwd → base64 header 值 */
function cwdHeader(): string | undefined {
  const cwd = localStorage.getItem('APP_CWD');
  return cwd ? btoa(unescape(encodeURIComponent(cwd))) : undefined;
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const cwd = cwdHeader();
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(cwd ? { 'X-Current-Cwd': cwd } : {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`fs API ${res.status}: ${url}`);
  }
  return res.json() as Promise<T>;
}

/** 字节 → base64（浏览器端, 分块避免栈溢出） */
function bytesToBase64(input: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < input.length; i += chunk) {
    bin += String.fromCharCode(...input.subarray(i, i + chunk));
  }
  return btoa(bin);
}

@Injectable()
@Domain(ClientAppContribution)
export class FileSystemServiceImpl implements IFileSystem {
  static instance: FileSystemServiceImpl | null = null;

  @Autowired(CommandService)
  private readonly commandService!: CommandService;

  @Autowired(IFileServiceClient)
  private readonly fileService!: IFileServiceClient;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  private eventSource: EventSource | null = null;

  /** 容器启动: 挂全局单例 + 订阅 fs SSE（宿主机工作目录变更 → fs:changed 事件） */
  onStart(): void {
    (window as any).__APP_FS__ = this;
    console.log('[filesystem] service ready, fsBaseUrl:', fsBaseUrl() || '(unset)');
    // runtime 就绪（fsUrl 注入）→ 连接事件 + 刷新 explorer 重读
    window.addEventListener('runtime-ready', () => {
      this.connectEvents();
      void this.verifyOpensumiLink();
      void this.refreshExplorer();
      this.watchEditorState();
      this.restoreOpenedEditors();
    });
    if (fsBaseUrl()) this.connectEvents();
  }

  /** 验证 opensumi IFileServiceClient → BrowserFS → server fs 链路（拓展读文件的通道） */
  private async verifyOpensumiLink(): Promise<void> {
    try {
      const stat = await this.fileService.getFileStat('file:///workspace');
      console.log('[filesystem] opensumi 链路验证: file:///workspace stat =', {
        isDirectory: stat?.isDirectory,
        children: stat?.children?.map((c) => ({ name: c.uri.split('/').pop(), isDirectory: c.isDirectory })),
      });
    } catch (e) {
      console.warn('[filesystem] opensumi 链路验证失败:', e);
    }
  }

  /**
   * 恢复上次打开的编辑器 tab（与 explorer 加载解耦: 异步 500ms 延后, 互不影响）.
   * 持久化由 watchEditorState 维护（打开自动加、关闭自动移除）; 这里只消费同一个
   * runtime-ready 事件后各自工作.
   * 恢复时并行校验文件存在（被删/不存在的跳过, 并从持久化自愈移除）, 避免反复
   * 尝试打开已删除文件（404 / INVALID tab 污染恢复流程）.
   */
  private restoreOpenedEditors(): void {
    try {
      const uris: string[] =
        (window as any).__SAVED_EDITOR_URIS__ ||
        (() => {
          const raw = localStorage.getItem('editor.restore.uris');
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        })();
      // 上次激活的 tab（刷新后定位回到它）; 排除非文件（welcome 等）
      const activeUri: string =
        (window as any).__SAVED_EDITOR_ACTIVE_URI__ ||
        localStorage.getItem('editor.restore.activeUri') ||
        '';
      if (!uris.length) return;
      console.log('[filesystem] 恢复编辑器 tab:', uris.length, uris, 'active:', activeUri);
      setTimeout(() => {
      const alive: string[] = [];
      // 模仿 opensumi restoreState: backend 先建 tab（只建容器不加载内容, 无竞态）→
      // 再 open(activeUri) 激活加载渲染（直接完整打开会因懒加载空 tab + 二次 open 不重载而不渲染）
      void Promise.all(
        uris.map((uri) =>
          this.fileService
            .getFileStat(uri)
            .then((stat) => {
              if (!stat || stat.isDirectory) return;
              alive.push(uri);
              return this.editorService
                .open(URI.parse(uri), { backend: true, preview: false, deletedPolicy: 'skip' })
                .then(() => console.log('[filesystem] 恢复建 tab:', uri))
                .catch((e) => console.warn('[filesystem] 恢复建 tab 失败:', uri, e));
            })
            .catch(() => {}),
        ),
      ).then(async () => {
        if (alive.length !== uris.length) {
          localStorage.setItem('editor.restore.uris', JSON.stringify(alive));
          console.log('[filesystem] 恢复状态自愈:', uris.filter((u) => !alive.includes(u)), '已从持久化移除');
        }
        const target =
          activeUri && alive.includes(activeUri) && !activeUri.startsWith('welcome:')
            ? activeUri
            : alive[alive.length - 1];
        // customEditor 文件（html/paper 等）: 恢复后强制以 customEditor 打开.
        // backend 只建容器不触发扩展 resolve, 且 findSuitableOpenType 会沿用 prev 打开类型
        // （html 曾被文本编辑器打开 → 恢复落回文本, webview 不渲染）; 用 forceOpenType 组件
        // 强制 viewType → 触发扩展 resolve. 串行避免 tab 竞态.
        const customEditorMap = buildCustomEditorMap();
        for (const uri of alive) {
          const viewType = matchCustomEditor(uri, customEditorMap);
          if (!viewType) continue;
          try {
            await this.editorService.open(URI.parse(uri), {
              forceOpenType: {
                type: EditorOpenType.component,
                componentId: `vscode_customEditor-${viewType}`,
              },
              preview: false,
            } as any);
            console.log('[filesystem] 恢复 customEditor 打开:', uri, '→', viewType);
          } catch (e) {
            console.warn('[filesystem] 恢复 customEditor 打开失败:', uri, e);
          }
        }
        // 激活上次的 tab（backend 只建容器, 这里 open 触发内容加载渲染; customEditor 文件同样
        // 带 forceOpenType, 避免 target open 又把之前 customEditor 打开覆盖回文本编辑器）
        if (target) {
          const targetViewType = matchCustomEditor(target, customEditorMap);
          void this.editorService
            .open(URI.parse(target), {
              focus: true,
              preview: false,
              ...(targetViewType ? { forceOpenType: { type: EditorOpenType.component, componentId: `vscode_customEditor-${targetViewType}` } } : {}),
            } as any)
            .then(() => {
              console.log('[filesystem] 恢复激活当前 tab:', target);
              // target 是 customEditor 文件: 恢复时扩展可能尚未激活完成（组件渲染早于扩展
              // activate → resolve 未执行, webview 不渲染）; 等扩展就绪后延迟重试触发渲染
              if (targetViewType) {
                [2000, 5000].forEach((delay) => {
                  setTimeout(() => {
                    void this.editorService
                      .open(URI.parse(target), {
                        focus: true,
                        forceOpenType: { type: EditorOpenType.component, componentId: `vscode_customEditor-${targetViewType}` },
                        preview: false,
                      } as any)
                      .then(() => console.log('[filesystem] 恢复 customEditor 重试激活:', target, '→', targetViewType))
                      .catch(() => {});
                  }, delay);
                });
              }
            })
            .catch((e) => console.warn('[filesystem] 恢复激活失败:', target, e));
        }
      });
      }, 500);
    } catch { /* ignore */ }
  }
  /**
   * 监听编辑器 tab 变化（打开/关闭/切换）→ 把当前打开的 uris 持久化.
   * 打开自动加入 state, 关闭自动从 state 移除（读当前真实状态写入, 不残留已关闭 tab）.
   */
  private watchEditorState(): void {
    try {
      // tab 变化事件（实现类上）在 _restoringState 等场景会跳过, 不可靠;
      // 组合: 资源/组变化事件即时同步 + 定时轮询兜底（任何打开/关闭/切换都记录, 不遗漏）
      this.editorService.onActiveResourceChange(() => this.syncPersistedUris());
      this.editorService.onDidEditorGroupsChanged(() => this.syncPersistedUris());
      (this.editorService as any).onDidEditorGroupTabChanged?.(() => this.syncPersistedUris());
      setInterval(() => this.syncPersistedUris(), 2000);
    } catch { /* ignore */ }
  }

  private syncPersistedUris(): void {
    try {
      const uris = this.editorService.getAllOpenedUris().map((u) => u.toString());
      const next = JSON.stringify(uris);
      const active = this.editorService.currentEditorGroup?.currentResource?.uri.toString() || '';
      // 变化才写（uris 或当前激活 tab 任一变化）
      if (next === localStorage.getItem('editor.restore.uris') && active === localStorage.getItem('editor.restore.activeUri')) {
        return;
      }
      localStorage.setItem('editor.restore.uris', next);
      if (active) localStorage.setItem('editor.restore.activeUri', active);
    } catch { /* ignore */ }
  }

  /** 刷新 explorer 文件树（runtime 就绪后触发 OverlayFS 重读: fireFilesChange 让 file-tree 重载） */
  private async refreshExplorer(): Promise<void> {
    try {
      // 派发文件变化事件 → file-tree 重读受影响节点（触发 OverlayFS readDirectory 重新拉取）
      this.fileService.fireFilesChange({ changes: [{ uri: 'file:///workspace', type: 1 }] });
      console.log('[filesystem] explorer 已刷新 (fireFilesChange)');
    } catch (e) {
      console.warn('[filesystem] explorer 刷新失败:', e);
    }
  }

  /** 订阅 /fs/events SSE, 收到变更后: 转 opensumi 文件变化事件(explorer 刷新 + 编辑器自动 revert) + 派发 fs:changed */
  private connectEvents(): void {
    const base = fsBaseUrl();
    if (!base || this.eventSource) return;
    const es = new EventSource(`${base}/events`);
    this.eventSource = es;
    const typeMap: Record<string, FileChangeType> = {
      add: FileChangeType.ADDED,
      change: FileChangeType.UPDATED,
      unlink: FileChangeType.DELETED,
    };
    es.onmessage = (msg) => {
      try {
        const change = JSON.parse(msg.data);
        const rel = change.path || '/';
        // server 事件 → opensumi 文件变化事件: file-editor-doc 监听后自动重读内容, file-tree 自动刷新
        const uri = `file://${WORKSPACE_ROOT}${rel}`;
        console.log('[filesystem] fs event:', change.type, rel, '→ fireFilesChange', uri);
        this.fileService.fireFilesChange({
          changes: [{ uri, type: typeMap[change.type] ?? FileChangeType.UPDATED }],
        });
        window.dispatchEvent(new CustomEvent('fs:changed', {
          detail: { ...change, path: rel },
        }));
      } catch {
        /* ignore bad frame */
      }
    };
    es.onerror = () => {
      console.warn('[filesystem] fs events 断线, 等待重连');
    };
    console.log('[filesystem] fs events subscribed:', `${base}/events`);
  }

  private api(path: string): string {
    const base = fsBaseUrl();
    if (!base) throw new Error('fs base url not ready (sandbox runtime 未应用)');
    return `${base}/${path}`;
  }

  // ---- 相对路径接口（OverlayFS 对接）----

  async list(idePath: string): Promise<FsEntry[]> {
    return http<FsEntry[]>(`${this.api('dir')}?path=${encodeURIComponent(idePath)}`);
  }

  async exists(idePath: string): Promise<boolean> {
    try {
      await http<any>(`${this.api('stat')}?path=${encodeURIComponent(idePath)}`);
      return true;
    } catch {
      return false;
    }
  }

  async meta(idePath: string): Promise<FileMeta> {
    return http<FileMeta>(`${this.api('stat')}?path=${encodeURIComponent(idePath)}`);
  }

  async read(idePath: string): Promise<string> {
    const cwd = cwdHeader();
    const res = await fetch(`${this.api('file')}?path=${encodeURIComponent(idePath)}`, {
      headers: { ...(cwd ? { 'X-Current-Cwd': cwd } : {}) },
    });
    if (!res.ok) throw new Error(`fs read ${res.status}`);
    return res.text();
  }

  async readBinary(idePath: string): Promise<Uint8Array> {
    const cwd = cwdHeader();
    const res = await fetch(`${this.api('file')}?path=${encodeURIComponent(idePath)}&binary=1`, {
      headers: { ...(cwd ? { 'X-Current-Cwd': cwd } : {}) },
    });
    if (!res.ok) throw new Error(`fs readBinary ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(idePath: string, content: string | { base64: string }): Promise<boolean> {
    const body = typeof content === 'string' ? { content } : { base64: content.base64 };
    try {
      await http(`${this.api('file')}?path=${encodeURIComponent(idePath)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return true;
    } catch {
      return false;
    }
  }

  async rm(idePath: string): Promise<boolean> {
    try {
      await http(`${this.api('file')}?path=${encodeURIComponent(idePath)}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(idePath: string): Promise<boolean> {
    try {
      await http(`${this.api('dir')}?path=${encodeURIComponent(idePath)}`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }

  async move(from: string, to: string): Promise<boolean> {
    try {
      await http(`${this.api('move')}`, {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async find(idePath: string, pattern = '*'): Promise<string[]> {
    return http<string[]>(`${this.api('search')}?path=${encodeURIComponent(idePath)}&pattern=${encodeURIComponent(pattern)}`);
  }
}

/** 模块级单例 getter */
export function getFileSystemService(): IFileSystem {
  return FileSystemServiceImpl.instance || (FileSystemServiceImpl.instance = new FileSystemServiceImpl());
}

@Injectable()
export class FileSystemModule extends BrowserModule {
  providers = [
    { token: FsToken, useFactory: () => getFileSystemService() },
    FileSystemServiceImpl,
  ];

  contributionProvider = ClientAppContribution;
}

/** 安装全局单例 */
export function installFileSystemService(): void {
  (window as any).__APP_FS__ = getFileSystemService();
  console.log('[filesystem] service installed');
}