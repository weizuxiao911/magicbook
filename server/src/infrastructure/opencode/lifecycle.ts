/**
 * opencode 生命周期管理 — infrastructure/opencode/lifecycle.ts
 *
 * Local 模式: 探活 opencode 服务, 不存在则自动启动.
 *   - 探活: HTTP GET {baseUrl}/health（或根路径, opencode 返回 200 即存活）
 *   - 启动: spawn `opencode serve --port <port> --hostname 0.0.0.0`, cwd=workspaceRoot
 *   - 单例: 已启动的进程句柄缓存, 避免重复 spawn
 *
 * Cluster 模式由 K8s 编排（本期占位, 不在此实现）.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { ServerConfig } from '../config';

let processHandle: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

/** 解析 opencodeBaseUrl 的 host/port（http://127.0.0.1:24096 → {host, port}） */
function parseBase(base: string): { host: string; port: number } {
  const u = new URL(base);
  return { host: u.hostname, port: Number(u.port || 24096) };
}

/** 探活: opencode 是否存活（GET /health, 200 即存活; 连接拒绝即未起） */
export function isOpencodeAlive(base: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const { host, port } = parseBase(base);
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 启动 opencode serve（cwd=workspaceRoot, 端口从 base 解析） */
function spawnOpencode(config: ServerConfig): Promise<boolean> {
  const { port } = parseBase(config.opencodeBaseUrl);
  return new Promise((resolve) => {
    const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '0.0.0.0'], {
      cwd: config.workspaceRoot,
      stdio: 'ignore',
      detached: false,
    });
    processHandle = child;
    child.on('error', (err) => {
      console.error('[opencode] 启动失败:', err.message);
      processHandle = null;
      resolve(false);
    });
    child.on('exit', (code) => {
      if (processHandle === child) processHandle = null;
      console.log(`[opencode] 进程退出 code=${code}`);
    });
    // 启动后等待就绪
    const poll = async (n: number): Promise<void> => {
      if (await isOpencodeAlive(config.opencodeBaseUrl)) {
        console.log(`[opencode] 就绪: ${config.opencodeBaseUrl} (pid=${child.pid})`);
        resolve(true);
        return;
      }
      if (n <= 0) {
        console.warn('[opencode] 启动后探活超时');
        resolve(false);
        return;
      }
      setTimeout(() => void poll(n - 1), 500);
    };
    setTimeout(() => void poll(10), 500);
  });
}

/** 确保 opencode 就绪（探活 → 未起则启动）; 幂等 */
export async function ensureOpencode(config: ServerConfig): Promise<boolean> {
  if (await isOpencodeAlive(config.opencodeBaseUrl)) return true;
  if (starting) return starting;
  starting = spawnOpencode(config).finally(() => { starting = null; });
  return starting;
}