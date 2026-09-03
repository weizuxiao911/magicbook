/**
 * service/state/state.interface.ts
 *
 * codeblitz 状态契约: 当前工作空间 / slot 记忆 / editor tab / AI session 等.
 *
 * 当前实现: 见 ./state.service.ts (DI 单例).
 * 持久化: 见 ./persistence.ts (localStorage adapter, 后续可换 IndexedDB).
 */

export interface WorkspaceState {
  /** 当前工作空间路径 */
  workspace: string;
  /** 最近用过的工作空间列表 (新 → 旧) */
  recent: string[];
}

export interface IStateService {
  /** 当前 workspace 状态 (实时读, 不存过期) */
  getWorkspace(): WorkspaceState;
  /** 加 recent (最近用的 workspace) */
  pushRecent(workspace: string): void;
  /** 切换 workspace: 写 URL `?directory=` + 同步 APP_CWD + 派 workspace:changed + reload.
   *  唯一变更入口. */
  setWorkspace(dir: string): void;
  /** 订阅 workspace 变更 (返回 unsubscribe) */
  subscribeWorkspace(cb: (next: string, prev: string) => void): () => void;
}

export const StateToken: symbol = Symbol('IStateService');