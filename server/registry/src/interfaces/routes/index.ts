/**
 * 路由注册 — interfaces/http/routes/index.ts
 *
 * registry 服务: /extension/*（vsix 元数据/上传/下载/下架/静态资源）.
 */

import { Router } from 'express';

import type { ExtensionController } from '../controllers/extension.controller';

export interface Controllers {
  extension: ExtensionController;
}

export function registerRoutes(router: Router, c: Controllers): void {
  router.get('/extension', c.extension.listMetadata);
  router.get('/extension/vsix/:file', c.extension.getVsix);
  router.post('/extension/vsix', c.extension.postVsix);
  router.delete('/extension/vsix/:file', c.extension.deleteVsix);
  router.get('/extension/dist/:id/*', c.extension.getDistAsset);
}