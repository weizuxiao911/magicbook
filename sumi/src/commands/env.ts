/**
 * IEnvService 接口定义 — core/commands/env
 *
 * 全局协议/接口定义（内核）: 运行环境能力契约.
 * 实现: service/…（implements IEnvService, 对接 server）.
 *
 * 使用方通过 useInjectable(EnvToken) 注入.
 */

/** 平台类型 */
export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

/** 环境能力接口 */
export interface IEnvService {
  getPlatform(): Platform;
  isWindows(): boolean;
  isMac(): boolean;
  getCwd(): Promise<string>;
  getCwdSync(): string | null;
}

/** Env Token（全局定义） */
export const EnvToken: symbol = Symbol('IEnvService');