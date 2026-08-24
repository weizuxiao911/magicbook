/**
 * 组合根 / 启动入口 — server/registry/src/main.ts
 *
 * registry 服务（:7781）: vsix 拓展分发（元数据/上传/下载/下架/静态资源）.
 *
 * 存储目录: registry/extensions/（vsix/ dist/ uploads/）.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { LocalExtensionRepository } from './infrastructure/extension/local';
import { ExtensionService } from './application/extension.service';
import { ExtensionController } from './interfaces/controllers/extension.controller';
import { registerRoutes } from './interfaces/routes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 7781);
// registry 服务存储根（registry/extensions/: vsix/dist/uploads, 分发运行时数据）
const STORE_DIR = process.env.STORE_DIR || path.resolve(__dirname, '..', 'extensions');
const PUBLIC_HOST = process.env.PUBLIC_HOST || `localhost:${PORT}`;

function main(): void {
  const repository = new LocalExtensionRepository(STORE_DIR, PUBLIC_HOST);
  const service = new ExtensionService(repository);
  const controller = new ExtensionController(service, path.join(STORE_DIR, 'uploads'));

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'registry', pid: process.pid });
  });

  registerRoutes(app, { extension: controller });

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[registry] error:', err?.message || err);
    res.status(err?.status || 500).json({ error: err?.message || 'internal error' });
  });

  app.listen(PORT, () => {
    console.log(`[registry] listening on :${PORT}, store=${STORE_DIR}`);
  });
}

main();