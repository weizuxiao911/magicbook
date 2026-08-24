/**
 * fs 服务生命周期管理 — infrastructure/fs/lifecycle.ts
 *
 * 与 opencode 同级: 探活 fs 服务（:24097）, 不存在则自动启动.
 *   - 探活: HTTP GET {fsBaseUrl}/health
 *   - 启动: spawn `npx tsx src/main.ts`（server/fs, FS_PORT + WORKSPACE_ROOT 注入）
 *   - 单例: 已启动的进程句柄缓存
 *
 * 未来容器化: fs 服务与 opencode 一起内置沙箱容器（24097 与 24096 并列）, 生命周期由容器编排.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '../config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 本仓库根（magicbook/）— infrastructure/fs → 上四级 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let processHandle: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

/** 解析 fsBaseUrl 的 host/port（http://127.0.0.1:24097/fs → {host, port}） */
function parseBase(base: string): { host: string; port: number } {
  const u = new URL(base);
  return { host: u.hostname, port: Number(u.port || 24097) };
}

/** 探活: fs 服务是否存活（GET /health, 200 即存活） */
export function isFsAlive(base: string, timeoutMs = 1500): Promise<boolean> {
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

/** 启动 fs 服务（server/fs, npx tsx; FS_PORT + WORKSPACE_ROOT 注入） */
function spawnFs(config: ServerConfig): Promise<boolean> {
  const { port } = parseBase(config.fsBaseUrl);
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/main.ts'], {
      cwd: path.join(REPO_ROOT, 'server', 'fs'),
      env: { ...process.env, FS_PORT: String(port), WORKSPACE_ROOT: config.workspaceRoot },
      stdio: 'ignore',
    });
    processHandle = child;
    child.on('error', (err) => {
      console.error('[fs] 启动失败:', err.message);
      processHandle = null;
      resolve(false);
    });
    child.on('exit', (code) => {
      if (processHandle === child) processHandle = null;
      console.log(`[fs] 进程退出 code=${code}`);
    });
    const poll = async (n: number): Promise<void> => {
      if (await isFsAlive(config.fsBaseUrl)) {
        console.log(`[fs] 就绪: ${config.fsBaseUrl} (pid=${child.pid})`);
        resolve(true);
        return;
      }
      if (n <= 0) {
        console.warn('[fs] 启动后探活超时');
        resolve(false);
        return;
      }
      setTimeout(() => void poll(n - 1), 500);
    };
    setTimeout(() => void poll(10), 500);
  });
}

/** 确保 fs 服务就绪（探活 → 未起则启动）; 幂等 */
export async function ensureFs(config: ServerConfig): Promise<boolean> {
  if (await isFsAlive(config.fsBaseUrl)) return true;
  if (starting) return starting;
  starting = spawnFs(config).finally(() => { starting = null; });
  return starting;
}