/**
 * 系统机制初始化 — core/config/app.ts
 *
 * 模块加载时（App 渲染前, index.tsx import）完成全局机制挂载:
 *   - window.__APP_CONFIG__: 编译期注入配置（sandbox/registry 地址, 其余协议地址由 sandbox 返回）
 *   - BrowserFS backend 注册: RemoteFS（core/config/bfs.ts, 读写全透传 server fs, 调 service/fs 单实例）;
 *     runtime.ts workspace.filesystem 按 fs: RemoteFS.Name 创建, 必须在渲染前注册
 */

import { BrowserFS } from '@codeblitzjs/ide-sumi-core/lib/server/node';
import { APP_CHAT_CONFIG } from './brand';
import { RemoteFS } from './bfs';

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

// 文件系统机制: 注册 RemoteFS 为 BrowserFS backend（opensumi 容器经 BrowserFS 访问 service/fs 单实例）
BrowserFS.addFileSystemType(RemoteFS.Name, RemoteFS as any);

(window as any).__APP_CONFIG__ = buildAppConfig();