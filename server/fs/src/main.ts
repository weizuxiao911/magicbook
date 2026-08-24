/**
 * 组合根 / 启动入口 — server/fs/src/main.ts
 *
 * fs 服务（:24097）: 文件系统 API（与 opencode 共享同一 cwd）.
 *   - /fs/*        文件操作（dir/file/stat/search/move/copy）
 *   - /fs/events   SSE 实时推送工作区变更（explorer 刷新数据源）
 *
 * 生命周期由 sandbox 管理（探活 + 自启, 与 opencode 同级）;
 * 未来容器化: 与 opencode 一起内置沙箱容器（24097 与 24096 并列）.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalFsRepository } from './infrastructure/fs/local';
import { WorkspaceWatcher, FsEventStream } from './infrastructure/fs/watcher';
import { FsService } from './application/fs.service';
import { FsController } from './interfaces/controllers/fs.controller';
import { registerRoutes } from './interfaces/routes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 本仓库根（magicbook/）— server/fs/src → 上四级 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function main(): void {
  const port = Number(process.env.FS_PORT || 24097);
  const workspaceRoot = process.env.WORKSPACE_ROOT || path.join(REPO_ROOT, 'workspace');

  const fsRepository = new LocalFsRepository();
  const fsService = new FsService(fsRepository, workspaceRoot);
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();
  const fsEvents = new FsEventStream(watcher);
  const controller = new FsController(fsService, fsEvents);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-Tenant-Id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'fs', workspaceRoot, pid: process.pid });
  });

  registerRoutes(app, { fs: controller });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[fs] error:', err?.message || err);
    res.status(err?.status || 500).json({ error: err?.message || 'internal error' });
  });

  app.listen(port, () => {
    console.log(`[fs] listening on :${port}, workspace: ${workspaceRoot}`);
  });
}

main();