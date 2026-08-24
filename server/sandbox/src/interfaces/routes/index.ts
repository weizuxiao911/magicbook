/**
 * 路由注册 — interfaces/http/routes/index.ts
 *
 * sandbox 服务: /sandbox/* + /fs/*.
 * opencode 不经代理（Local 直连, cluster 经 ingress 暴露）.
 * vsix 拓展分发由独立 registry 服务提供（:7781）.
 */

import { Router } from 'express';

import type { SandboxController } from '../controllers/sandbox.controller';
import type { FsController } from '../controllers/fs.controller';
export interface Controllers {
  sandbox: SandboxController;
  fs: FsController;
}

export function registerRoutes(router: Router, c: Controllers): void {
  // 沙箱
  router.get('/sandbox', c.sandbox.get);
  router.post('/sandbox', c.sandbox.create);
  router.get('/sandbox/:runtimeId/events', c.sandbox.events);

  // 文件系统（与 opencode 共享同一 cwd）
  router.get('/fs/cwd', c.fs.getCwd);
  router.get('/fs/events', c.fs.sseEvents);
  router.get('/fs/dir', c.fs.listDir);
  router.post('/fs/dir', c.fs.mkdir);
  router.get('/fs/file', c.fs.readFile);
  router.put('/fs/file', c.fs.writeFile);
  router.delete('/fs/file', c.fs.remove);
  router.get('/fs/stat', c.fs.stat);
  router.get('/fs/search', c.fs.search);
  router.post('/fs/move', c.fs.move);
  router.post('/fs/copy', c.fs.copy);
}