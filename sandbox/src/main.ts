import express from 'express';
import http from 'node:http';
import httpProxy from 'http-proxy';

const PORT = parseInt(process.env.SERVER_PORT || '7789');
const DEFAULT_OPENCODE = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:24096';
let workspaceRoot = process.env.WORKSPACE_ROOT || '/tmp/workspace';
let aiTarget = DEFAULT_OPENCODE;

const app = express();
// /ai/* 全量透传, 不解析 body (由 opencode 处理); 其余接口解析 JSON
app.use((req, res, next) => {
  if (req.path.startsWith('/ai')) return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// 前置处理: 从 x-current-cwd header 解析当前工作目录 (base64),
// 设为 fs 根; 若 opencode 实际 cwd 不匹配则重启 opencode
app.use(async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Current-Cwd');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  const h = req.headers['x-current-cwd'];
  if (h) {
    try {
      const cwd = Buffer.from(String(h), 'base64').toString('utf-8');
      if (cwd && cwd !== workspaceRoot) {
        workspaceRoot = cwd;
        await ensureOpencodeForCwd(cwd);
      }
    } catch { /* ignore bad header */ }
  }
  next();
});

import { workspaceRoutes } from './routes/workspace.js';
import { fsRoutes } from './routes/fs.js';
import { aiRoutes } from './routes/ai.js';
import { ensureOpencode, getOpencodeCwd, registerExitCleanup, isAlive } from './service/opencode.js';

/** 确保 opencode 用目标 cwd (幂等: 端口活+cwd匹配不动, 否则重启) */
async function ensureOpencodeForCwd(cwd: string): Promise<void> {
  if (cwd === workspaceRoot && await isAlive(24096)) {
    const actual = await getOpencodeCwd();
    if (actual === cwd) return; // 匹配, 保留
  }
  await ensureOpencode(cwd).catch((e) => console.warn('[sandbox] opencode ensure failed:', e?.message));
}

workspaceRoutes(app, () => workspaceRoot, (v) => { workspaceRoot = v; }, (v) => { aiTarget = v; });
fsRoutes(app, () => workspaceRoot);
aiRoutes(app, () => aiTarget);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sandbox', pid: process.pid });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[sandbox] error:', err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || 'internal error' });
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ai')) {
    const proxy = httpProxy.createProxyServer({ changeOrigin: true });
    req.url = req.url.replace(/^\/ai/, '') || '/';
    proxy.ws(req, socket, head, { target: aiTarget });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[sandbox] listening on :${PORT}, ai→${aiTarget}`);
  // opencode 不逃逸: sandbox 退出时清理子进程
  registerExitCleanup();
});