/**
 * ISandbox 接口定义 — core/commands/sandbox
 *
 * 全局协议/接口定义（内核）: 运行时沙箱管理能力契约.
 * 实现: service/sandbox（implements ISandbox, 对接 server /sandbox/*）.
 *
 * 使用方通过 useInjectable(SandboxToken) 注入.
 */

/** 运行时沙箱信息（server 返回, snake_case） */
export interface SandboxRuntime {
  runtimeId: string;
  cwd: string;
  opencode_base_url: string;
  fs_base_url: string;
  registry_url: string;
  /** 运行模式: local（免登录直连）| cluster（需登录） */
  mode: 'local' | 'cluster';
}

/** 沙箱事件（SSE 推流） */
export type SandboxEvent =
  | { type: 'creating'; runtimeId: string }
  | { type: 'ready'; runtimeId: string; payload: SandboxRuntime }
  | { type: 'error'; runtimeId: string; message: string }
  | { type: 'terminating'; runtimeId: string };

/** 运行时沙箱管理能力接口 */
export interface ISandbox {
  /** 获取运行时沙箱（已存在则返回） */
  get(): Promise<SandboxRuntime>;
  /** 创建运行时沙箱 */
  create(): Promise<SandboxRuntime>;
  /** 订阅沙箱事件（SSE）, 返回取消函数 */
  onEvents(runtimeId: string, handler: (e: SandboxEvent) => void): () => void;
  /** 取当前激活运行时 */
  getRuntime(): SandboxRuntime | null;
  /** 取运行模式（server 返回: local | cluster） */
  getMode(): 'local' | 'cluster' | null;
  /** 应用运行时（由 server 返回的完整地址驱动各协议 baseUrl） */
  applyRuntime(rt: SandboxRuntime): void;
}

/** Sandbox Token（全局定义） — service/sandbox 局部实现 */
export const SandboxToken: symbol = Symbol('ISandbox');