/**
 * service/state/state.service.ts
 *
 * StateServiceImpl — DI 单例.
 * 维护 codeblitz 状态 (workspace / recent / workspace 切换).
 *
 * 持久化: localStorage via ./persistence.ts. 后续重设计用 IndexedDB 时只换 persistence.ts.
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { getWorkspace, emitWorkspaceChanged } from '../../infra/url';
import { normalizeCwdPath } from '../../infra/path';

import type { IStateService, WorkspaceState } from './state.interface';
import { StateToken } from './state.interface';
import { loadRecent, saveRecent } from './persistence';

@Injectable()
export class StateServiceImpl implements IStateService {
  /** 当前 workspace (workspace + recent). 内存缓存 + 持久化. */
  private _workspace: WorkspaceState;

  constructor() {
    this._workspace = {
      workspace: getWorkspace(),
      recent: loadRecent(),
    };
  }

  getWorkspace(): WorkspaceState {
    this._workspace.workspace = getWorkspace();
    return { ...this._workspace };
  }

  pushRecent(workspace: string): void {
    if (!workspace) return;
    const list = this._workspace.recent.filter((c) => c !== workspace);
    list.unshift(workspace);
    if (list.length > 10) list.length = 10;
    this._workspace.recent = list;
    saveRecent(list);
  }

  setWorkspace(dir: string): void {
    if (!dir) return;
    const norm = normalizeCwdPath(dir);
    if (!norm) return;
    const prev = getWorkspace();
    if (prev === norm) return;
    // 唯一 source: URL `?directory=` (replaceState 不刷新)
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('directory', norm);
      window.history.replaceState(null, '', u.toString());
    } catch { /* ignore */ }
    this.pushRecent(norm);
    emitWorkspaceChanged(norm, prev);
    // 刷新: 让 FileTreeService 等重建
    window.location.reload();
  }

  subscribeWorkspace(cb: (next: string, prev: string) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ next: string; prev: string }>).detail;
      if (detail) cb(detail.next, detail.prev);
    };
    window.addEventListener('workspace:changed', handler);
    return () => window.removeEventListener('workspace:changed', handler);
  }
}

@Injectable()
export class StateModule extends BrowserModule {
  providers = [
    { token: StateToken, useClass: StateServiceImpl },
    StateServiceImpl,
  ];
}