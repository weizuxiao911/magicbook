/**
 * 系统机制初始化 — core/config/app.ts
 *
 * 模块加载时（App 渲染前, index.tsx import）完成全局机制挂载:
 *   - window.__APP_CONFIG__: 编译期注入配置（opencode/registry 地址, 其余协议地址由 agent runtime 注入）
 */

import { APP_CHAT_CONFIG } from './brand';

declare const __APP_BASE_URL__: string;
declare const __APP_REGISTRY_BASE_URL__: string;
declare const __APP_DEPLOY_ENV__: string;

export interface AppConfig {
  appBaseUrl: string;
  registryBaseUrl: string;
  deployEnv: string;
  workspaceDir: string;
  theme: string;
  chatConfig: typeof APP_CHAT_CONFIG;
}

function buildAppConfig(): AppConfig {
  return {
    appBaseUrl: __APP_BASE_URL__ || '',
    registryBaseUrl: __APP_REGISTRY_BASE_URL__ || '',
    deployEnv: __APP_DEPLOY_ENV__ || 'development',
    workspaceDir: '/workspace',
    theme: 'opensumi-design-dark-theme',
    chatConfig: APP_CHAT_CONFIG,
  };
}

(window as any).__APP_CONFIG__ = buildAppConfig();