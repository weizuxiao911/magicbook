/**
 * 系统配置 — core/config/app.ts
 *
 * 模块加载时挂载全局系统配置（window.__APP_CONFIG__）.
 * 编译期注入: __APP_BASE_URL__ / __APP_DEPLOY_ENV__（webpack DefinePlugin）.
 * 协议地址由 sandbox 返回后设置（applyRuntime 写入）.
 */

import { APP_CHAT_CONFIG } from './brand';

declare const __APP_BASE_URL__: string;
declare const __APP_DEPLOY_ENV__: string;

export interface AppConfig {
  appBaseUrl: string;
  deployEnv: string;
  workspaceDir: string;
  theme: string;
  chatConfig: typeof APP_CHAT_CONFIG;
}

function buildAppConfig(): AppConfig {
  return {
    appBaseUrl: __APP_BASE_URL__ || '',
    deployEnv: __APP_DEPLOY_ENV__ || 'development',
    workspaceDir: '/workspace',
    theme: 'opensumi-design-dark-theme',
    chatConfig: APP_CHAT_CONFIG,
  };
}

(window as any).__APP_CONFIG__ = buildAppConfig();