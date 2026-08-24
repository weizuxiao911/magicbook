/**
 * 路由注册 — interfaces/routes/index.ts
 *
 * fs 服务（:24097）: 文件系统 API（无 /fs 前缀, 与 opencode 共享同一 cwd; 经 sandbox/ingress 入口接入）.
 */

import { Router } from 'express';

import type { FsController } from '../controllers/fs.controller';

export interface Controllers {
  fs: FsController;
}

export function registerRoutes(router: Router, c: Controllers): void {
  router.get('/cwd', c.fs.getCwd);
  router.get('/events', c.fs.sseEvents);
  router.get('/dir', c.fs.listDir);
  router.post('/dir', c.fs.mkdir);
  router.get('/file', c.fs.readFile);
  router.put('/file', c.fs.writeFile);
  router.delete('/file', c.fs.remove);
  router.get('/stat', c.fs.stat);
  router.get('/search', c.fs.search);
  router.post('/move', c.fs.move);
  router.post('/copy', c.fs.copy);
}