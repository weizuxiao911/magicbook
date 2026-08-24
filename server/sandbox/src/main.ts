/**
 * 组合根 / 启动入口 — server/sandbox/src/main.ts
 *
 * sandbox 服务（:7780）:
 *   - /sandbox/*   沙箱管理（返回 fs_base_url / pty_base_url / opencode_base_url; pty 由 client 直连 opencode）
 *   - fs/pty 为独立服务（fs:24097 / opencode:24096, 生命周期由 sandbox 管理; client 直连地址）
 *
 * DDD 依赖装配: infrastructure 实现 domain 端口 → application 编排 → interfaces 暴露 HTTP.
 */

import express from 'express';

import { loadConfig, type ServerConfig } from './infrastructure/config';
import { LocalSandboxRepository } from './infrastructure/sandbox/local';
import { ClusterSandboxRepository } from './infrastructure/sandbox/cluster';

import type { SandboxRepository } from './domain/repositories/sandbox-repository';

import { SandboxService } from './application/sandbox.service';


import { SandboxController } from './interfaces/controllers/sandbox.controller';

import { registerRoutes, type Controllers } from './interfaces/routes';

function createSandboxRepository(config: ServerConfig): SandboxRepository {
  // sandbox 服务自身对外 base（fs_base_url 用）; registry 独立服务地址（registry_url 用）
  const sandboxBase = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${config.port}`;

  switch (config.mode) {
    case 'cluster':
      return new ClusterSandboxRepository(config, sandboxBase);
    case 'local':
    default:
      return new LocalSandboxRepository(config, sandboxBase);
  }
}

function createControllers(config: ServerConfig): Controllers {
  const sandboxRepo = createSandboxRepository(config);

  const sandboxService = new SandboxService(sandboxRepo);

  return {
    sandbox: new SandboxController(sandboxService),
  };
}
async function main(): Promise<void> {
  const config = loadConfig();
  const controllers = createControllers(config);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // CORS: client 纯浏览器跨域访问（dev 全开; 生产可收紧为指定 origin）
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

  // 健康检查
  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'sandbox', mode: config.mode, pid: process.pid });
  });

  // 业务路由（opencode 不经代理: Local 直连上游, cluster 经 ingress 暴露）
  registerRoutes(app, controllers);

  // 统一错误处理
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[sandbox] error:', err?.message || err);
    res.status(err?.status || 500).json({ error: err?.message || 'internal error' });
  });

  app.listen(config.port, () => {
    console.log(`[sandbox] listening on :${config.port}, mode=${config.mode}`);
  });
}

main().catch((err) => {
  console.error('[sandbox] failed to start:', err);
  process.exit(1);
});
