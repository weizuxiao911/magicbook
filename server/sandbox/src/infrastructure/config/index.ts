/**
 * 配置加载 — infrastructure/config/index.ts
 *
 * 从环境变量读取服务端配置, 提供类型安全配置对象.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 启动模式: local（接入宿主）| cluster（docker/k8s 调度沙箱） */
export type ServerMode = 'local' | 'cluster';

export interface ServerConfig {
  /** HTTP 监听端口（默认 7780） */
  port: number;
  /** 启动模式 */
  mode: ServerMode;
  /** 沙箱工作区根目录（fs 与 opencode 共享同一 cwd） */
  workspaceRoot: string;
  /** 上游 opencode 地址（本地模式直连） */
  opencodeBaseUrl: string;
  /** 沙箱 TTL（毫秒, 集群模式闲置回收） */
  sandboxTtlMs: number;
}

/** 本仓库根（magicbook/）— 从 config 模块文件位置推导（server/sandbox/src/infrastructure/config → 上五级） */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

export function loadConfig(): ServerConfig {
  const mode = (process.env.SERVER_MODE || 'local') as ServerMode;
  const root = process.env.MAGICBOOK_ROOT || REPO_ROOT;

  return {
    port: Number(process.env.SERVER_PORT || 7780),
    mode,
    workspaceRoot: process.env.WORKSPACE_ROOT || path.join(root, 'workspace'),
    opencodeBaseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:24096',
    sandboxTtlMs: Number(process.env.SANDBOX_TTL_MS || 30 * 60 * 1000),
  };
}