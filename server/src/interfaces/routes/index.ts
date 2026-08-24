/**
 * 路由注册 — interfaces/http/routes/index.ts
 *
 * 薄路由层: 只做 URL → Controller 映射, 业务全在 controller/service.
 * opencode 不经 server 代理（Local 直连, cluster 经 ingress 暴露）.
 */

import { Router } from 'express';

import type { SandboxController } from '../controllers/sandbox.controller';
import type { FsController } from '../controllers/fs.controller';
import type { ExtensionController } from '../controllers/extension.controller';

export interface Controllers {
  sandbox: SandboxController;
  fs: FsController;
  extension: ExtensionController;
}

export function registerRoutes(router: Router, c: Controllers): void {
  // 沙箱
  router.get('/sandbox', c.sandbox.get);
  router.post('/sandbox', c.sandbox.create);
  router.get('/sandbox/:runtimeId/events', c.sandbox.events);

  // 文件系统
  router.get('/fs/cwd', c.fs.getCwd);
  router.get('/fs/dir', c.fs.listDir);
  router.post('/fs/dir', c.fs.mkdir);
  router.get('/fs/file', c.fs.readFile);
  router.put('/fs/file', c.fs.writeFile);
  router.delete('/fs/file', c.fs.remove);
  router.get('/fs/file/meta', c.fs.stat);
  router.get('/fs/search', c.fs.search);

  // vsix 拓展
  router.get('/extension', c.extension.listMetadata);
  router.get('/extension/vsix/:file', c.extension.getVsix);
  router.post('/extension/vsix', c.extension.postVsix);
  router.delete('/extension/vsix/:file', c.extension.deleteVsix);
  router.get('/extension/dist/:id/*', c.extension.getDistAsset);
}