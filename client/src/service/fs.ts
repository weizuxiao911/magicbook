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
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';

import type { FsEntry, FileMeta, IFileSystem } from '../core/commands/fs';
import { FsToken } from '../core/commands/fs';

/** fs_base_url（sandbox 返回, 含 /fs 前缀） */
function fsBaseUrl(): string {
  return ((window as any).__APP_CONFIG__?.fsUrl || '').replace(/\/+$/, '');
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
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
   * 恢复上次打开的编辑器 tab.
   * 容器初始化时 fsUrl 未就绪（登录前）恢复打开失败; 登录后（runtime-ready）按文件系统
   * 校验保存的 workbench grid uris（存在才打开）.
   */
  private restoreOpenedEditors(): void {
    try {
      // 优先用渲染前暂存（容器初始化失败会清空 storage）; 兜底读 storage
      const uris: string[] =
        (window as any).__SAVED_EDITOR_URIS__ ||
        (() => {
          const raw = localStorage.getItem('scoped:/workspace/:/workbench');
          if (!raw) return [];
          const state = JSON.parse(raw) as { grid?: string };
          const grid = JSON.parse(state.grid || '{}') as { editorGroup?: { uris?: string[] } };
          return grid?.editorGroup?.uris || [];
        })();
      if (uris.length) console.log('[filesystem] 恢复编辑器 tab:', uris.length, uris);
      uris.forEach((uri) => {
        void this.fileService
          .getFileStat(uri)
          .then((stat) => {
            if (stat && !stat.isDirectory) {
              // 主线程 editor.openUri（无扩展命令的 URI.from 转换）
              void this.commandService
                .executeCommand('editor.openUri', URI.parse(uri), { preview: false })
                .then(() => console.log('[filesystem] 恢复打开成功:', uri))
                .catch((e) => console.warn('[filesystem] 恢复打开失败:', uri, e));
            }
          })
          .catch(() => {});
      });
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
    const res = await fetch(`${this.api('file')}?path=${encodeURIComponent(idePath)}`);
    if (!res.ok) throw new Error(`fs read ${res.status}`);
    return res.text();
  }

  async readBinary(idePath: string): Promise<Uint8Array> {
    const res = await fetch(`${this.api('file')}?path=${encodeURIComponent(idePath)}&binary=1`);
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