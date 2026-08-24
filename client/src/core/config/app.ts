/**
 * 系统配置 — core/config/app.ts
 *
 * 模块加载时挂载全局系统配置（window.__APP_CONFIG__）.
 * 编译期注入（webpack DefinePlugin 从 .env 读取）:
 *   __APP_SANDBOX_BASE_URL__   沙箱调度服务 URL
 *   __APP_REGISTRY_BASE_URL__  拓展分发服务 URL
 * 其余协议地址（opencode/fs）由 sandbox 返回后设置（applyRuntime 写入）.
 */

import { APP_CHAT_CONFIG } from './brand';

declare const __APP_SANDBOX_BASE_URL__: string;
declare const __APP_REGISTRY_BASE_URL__: string;
declare const __APP_DEPLOY_ENV__: string;

export interface AppConfig {
  sandboxBaseUrl: string;
  registryBaseUrl: string;
  deployEnv: string;
  workspaceDir: string;
  theme: string;
  chatConfig: typeof APP_CHAT_CONFIG;
}

function buildAppConfig(): AppConfig {
  return {
    sandboxBaseUrl: __APP_SANDBOX_BASE_URL__ || '',
    registryBaseUrl: __APP_REGISTRY_BASE_URL__ || '',
    deployEnv: __APP_DEPLOY_ENV__ || 'development',
    workspaceDir: '/workspace',
    theme: 'opensumi-design-dark-theme',
    chatConfig: APP_CHAT_CONFIG,
  };
}

(window as any).__APP_CONFIG__ = buildAppConfig();