/**
 * 文件系统 Controller — interfaces/http/controllers/fs.controller.ts
 *
 * HTTP 入口: 参数解析 → 调 FsService → 返回 RESTful 响应.
 * Local 模式: cwd 固定（/workspace）, 文件操作根由 server 配置决定, 不依赖用户身份.
 */

import type { Request, Response } from 'express';

import type { FsService } from '../../application/fs.service';
import type { FsEventStream } from '../../infrastructure/fs/watcher';

export class FsController {
  constructor(
    private readonly fs: FsService,
    private readonly events: FsEventStream,
  ) {}

  /** GET /fs/cwd */
  getCwd = (_req: Request, res: Response): void => {
    res.json({ cwd: this.fs.getCwd() });
  };

  /** GET /fs/events — SSE 实时推送工作目录变更 */
  sseEvents = (_req: Request, res: Response): void => {
    this.events.subscribe(res);
  };

  /** GET /fs/dir?path= */
  listDir = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '/';
      res.json(await this.fs.listDir(path));
    } catch (err) {
      next(err);
    }
  };

  /** POST /fs/dir?path= */
  mkdir = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '/';
      await this.fs.mkdir(path);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/file?path=&binary= */
  readFile = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '';
      const binary = req.query.binary === '1' || req.query.binary === 'true';
      const buf = await this.fs.readFile(path, binary);
      if (binary) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', buf.length);
        res.end(buf);
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(buf.toString('utf-8'));
      }
    } catch (err) {
      next(err);
    }
  };

  /** PUT /fs/file?path= */
  writeFile = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '';
      const result = await this.fs.writeFile(path, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /fs/file?path= */
  remove = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '';
      await this.fs.remove(path);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/stat?path= */
  stat = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '';
      res.json(await this.fs.stat(path));
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/search?path=&pattern= */
  search = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const path = (req.query.path as string) || '/';
      const pattern = (req.query.pattern as string) || '*';
      res.json(await this.fs.search(path, pattern));
    } catch (err) {
      next(err);
    }
  };

  /** POST /fs/move — body: { from, to, overwrite? } */
  move = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { from, to, overwrite } = req.body || {};
      if (!from || !to) {
        res.status(400).json({ error: 'from and to required' });
        return;
      }
      await this.fs.move(from, to, overwrite);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** POST /fs/copy — body: { from, to, overwrite? } */
  copy = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { from, to, overwrite } = req.body || {};
      if (!from || !to) {
        res.status(400).json({ error: 'from and to required' });
        return;
      }
      await this.fs.copy(from, to, overwrite);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };
}