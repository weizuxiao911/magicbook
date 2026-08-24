/**
 * 组合根 / 启动入口 — src/main.ts
 *
 * DDD 依赖装配（手动组合根）:
 *   infrastructure 实现 domain 端口 → application 编排 → interfaces 暴露 HTTP.
 *
 * 依赖方向: interfaces → application → domain ← infrastructure.
 */

import express from 'express';

import { loadConfig, type ServerConfig } from './infrastructure/config';
import { LocalSandboxRepository } from './infrastructure/sandbox/local';
import { ClusterSandboxRepository } from './infrastructure/sandbox/cluster';
import { LocalFsRepository } from './infrastructure/fs/local';
import { LocalExtensionRepository } from './infrastructure/extension/local';
import type { SandboxRepository } from './domain/repositories/sandbox-repository';

import { SandboxService } from './application/sandbox.service';
import { FsService } from './application/fs.service';
import { ExtensionService } from './application/extension.service';

import { SandboxController } from './interfaces/controllers/sandbox.controller';
import { FsController } from './interfaces/controllers/fs.controller';
import { ExtensionController } from './interfaces/controllers/extension.controller';
import { registerRoutes, type Controllers } from './interfaces/routes';

function createSandboxRepository(config: ServerConfig): SandboxRepository {
  // server 自身对外 base（沙箱返回 fs/registry 完整地址用）:
  // 本期先按监听地址推导, 部署时可用 PUBLIC_BASE_URL 覆盖
  const serverBase = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${config.port}`;

  switch (config.mode) {
    case 'cluster':
      return new ClusterSandboxRepository(config, serverBase);
    case 'local':
    default:
      return new LocalSandboxRepository(config, serverBase);
  }
}

function createControllers(config: ServerConfig): Controllers {
  const sandboxRepo = createSandboxRepository(config);

  const sandboxService = new SandboxService(sandboxRepo);
  const fsService = new FsService(new LocalFsRepository(), sandboxRepo);
  const extensionService = new ExtensionService(
    new LocalExtensionRepository(config, 'localhost'),
  );

  return {
    sandbox: new SandboxController(sandboxService),
    fs: new FsController(fsService),
    extension: new ExtensionController(extensionService, `${config.extensionDir}/uploads`),
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
    res.json({ ok: true, mode: config.mode, pid: process.pid });
  });

  // 业务路由（opencode 不经 server 代理: Local 直连上游, cluster 经 ingress 暴露）
  registerRoutes(app, controllers);

  // 统一错误处理
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] error:', err?.message || err);
    res.status(err?.status || 500).json({ error: err?.message || 'internal error' });
  });

  app.listen(config.port, () => {
    console.log(`[magicbook-server] listening on :${config.port}, mode=${config.mode}`);
  });
}

main().catch((err) => {
  console.error('[magicbook-server] failed to start:', err);
  process.exit(1);
});