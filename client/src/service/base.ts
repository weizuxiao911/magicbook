/**
 * 全局配置读取 — client/src/service/base.ts
 *
 * 纯浏览器: 所有服务地址从 window.__APP_CONFIG__ 读取（webapp 容器启动期注入）.
 * 前端只配置 APP_BASE_URL（统一 server 入口）, 其他协议地址由 server 返回后动态设置.
 */

/** 从全局配置读取服务地址 */
export function getBaseUrlFromConfig(key: string): string {
  const config = (window as any).__APP_CONFIG__;
  return config?.[key] || '';
}

/** 统一 server 入口（.env 唯一配置项） */
export function appBaseUrl(): string {
  return getBaseUrlFromConfig('appBaseUrl');
}

/**
 * 登录身份请求头 — 所有 service 请求统一注入 X-User-Id
 * （server 据此定位用户 cwd, Local 模式 cwd = workspace）.
 * 来源: service/auth（登录态单一事实源）.
 */
export function authHeaders(): Record<string, string> {
  const auth = (window as any).__APP_AUTH__;
  const user = auth?.getUsername?.() || 'default';
  return {
    'X-User-Id': user,
  };
}

/**
 * cwd 根（sandbox runtime 返回的相对路径, 如 /workspace 或 /）.
 * opensumi 文件 URI 根 = file://{cwd}; opencode 在同一 cwd 下工作.
 */
export function cwdRoot(): string {
  const rt = (window as any).__APP_SANDBOX__?.getRuntime?.();
  const cwd = rt?.cwd || '/';
  return cwd.startsWith('/') ? cwd : `/${cwd}`;
}

/** 相对路径 → opensumi 文件 URI（file://{cwd}/{path}） */
export function toFileUri(path: string): string {
  const root = cwdRoot();
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `file://${root}${clean === '/' ? '' : clean}`;
}