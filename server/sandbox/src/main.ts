/**
 * 组合根 / 启动入口 — server/sandbox/src/main.ts
 *
 * sandbox 服务（:7780）:
 *   - /sandbox/*   沙箱管理（返回 fs_base_url / opencode_base_url, 两者共享同一 cwd）
 *   - /fs/*        文件系统（内置实现, 与 opencode 同一 cwd）
 *   - opencode 生命周期（探活 + 自启 serve, cwd=workspace）
 *
 * DDD 依赖装配: infrastructure 实现 domain 端口 → application 编排 → interfaces 暴露 HTTP.
 */

import express from 'express';

import { loadConfig, type ServerConfig } from './infrastructure/config';
import { LocalSandboxRepository } from './infrastructure/sandbox/local';
import { ClusterSandboxRepository } from './infrastructure/sandbox/cluster';
import { LocalFsRepository } from './infrastructure/fs/local';
import { WorkspaceWatcher, FsEventStream } from './infrastructure/fs/watcher';
import type { SandboxRepository } from './domain/repositories/sandbox-repository';

import { SandboxService } from './application/sandbox.service';
import { FsService } from './application/fs.service';

import { SandboxController } from './interfaces/controllers/sandbox.controller';
import { FsController } from './interfaces/controllers/fs.controller';
import { registerRoutes, type Controllers } from './interfaces/routes';

function createSandboxRepository(config: ServerConfig): SandboxRepository {
  // sandbox 服务自身对外 base（fs_base_url 用）; registry 独立服务地址（registry_url 用）
  const sandboxBase = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${config.port}`;
  const registryBase = process.env.REGISTRY_URL || 'http://127.0.0.1:7781';

  switch (config.mode) {
    case 'cluster':
      return new ClusterSandboxRepository(config, sandboxBase, registryBase);
    case 'local':
    default:
      return new LocalSandboxRepository(config, sandboxBase, registryBase);
  }
}

function createControllers(config: ServerConfig): Controllers {
  const sandboxRepo = createSandboxRepository(config);

  const sandboxService = new SandboxService(sandboxRepo);
  const fsRepository = new LocalFsRepository();
  const fsService = new FsService(fsRepository, config.workspaceRoot);
  // 文件监听 + SSE 事件流（explorer 实时刷新数据源）
  const watcher = new WorkspaceWatcher(config.workspaceRoot);
  watcher.start();
  const fsEvents = new FsEventStream(watcher);

  return {
    sandbox: new SandboxController(sandboxService),
    fs: new FsController(fsService, fsEvents),
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