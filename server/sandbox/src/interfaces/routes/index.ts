/**
 * 路由注册 — interfaces/http/routes/index.ts
 *
 * sandbox 服务: /sandbox/*（fs:24097 / opencode:24096 为独立服务, client 直连地址; 生命周期由 sandbox 管理）.
 * opencode 不经代理（Local 直连, cluster 经 ingress 暴露）.
 * vsix 拓展分发由独立 registry 服务提供（:7781）.
 */
import { Router } from 'express';
import type { SandboxController } from '../controllers/sandbox.controller';
export interface Controllers {
  sandbox: SandboxController;
}
export function registerRoutes(router: Router, c: Controllers): void {
  // 沙箱
  router.get('/sandbox', c.sandbox.get);
  router.post('/sandbox', c.sandbox.create);
  router.get('/sandbox/:runtimeId/events', c.sandbox.events);
}