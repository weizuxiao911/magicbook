/**
 * IAuth 接口定义 — core/commands/auth
 *
 * 全局协议/接口定义（内核）: 登录态 / 会话 / 运行时就绪能力契约.
 * 实现: service/auth（implements IAuth, 对接 login 状态 + sandbox runtime）.
 *
 * 使用方通过 useInjectable(AuthToken) 注入, 不直接调 login 拓展内部.
 */

/** 登录态变化事件 */
export type AuthEvent = 'logined' | 'logout' | 'runtime-ready' | 'runtime-lost';

/** 登录与会话能力接口 */
export interface IAuth {
  /** 是否已登录 */
  isLoggedIn(): boolean;
  /** 当前用户名（未登录返回 null） */
  getUsername(): string | null;
  /** 沙箱运行时是否就绪（sandbox 获取成功, 各协议地址已应用） */
  isRuntimeReady(): boolean;
  /** 唤起登录面板（跨拓展统一入口, 内部走命令） */
  showLogin(): void;
  /** 关闭登录面板 */
  hideLogin(): void;
  /** 退出登录（清 cookie + 回登录态） */
  logout(): void;
  /** 订阅登录态变化, 返回取消订阅函数 */
  onAuthEvent(handler: (e: AuthEvent) => void): () => void;
  /** 登录成功（login 拓展调用: 写 cookie + 广播 logined） */
  loginSucceed(user: string): void;
  /** runtime 就绪/丢失（sandbox 应用后调用） */
  runtimeChanged(ready: boolean): void;
}

/** Auth Token（全局定义） — service/auth 局部实现 */
export const AuthToken: symbol = Symbol('IAuth');

/** 登录相关全局命令 ID（跨拓展调用唯一通道） */
export const AUTH_CMD = {
  SHOW_LOGIN: 'auth.showLogin',
  HIDE_LOGIN: 'auth.hideLogin',
} as const;