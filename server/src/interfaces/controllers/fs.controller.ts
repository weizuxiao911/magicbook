/**
 * 文件系统 Controller — interfaces/http/controllers/fs.controller.ts
 *
 * HTTP 入口: 参数解析 → 调 FsService → 返回 RESTful 响应.
 */

import type { Request, Response } from 'express';

import type { FsService } from '../../application/fs.service';

export class FsController {
  constructor(private readonly fs: FsService) {}

  private identity(req: Request): { user: string; tenant: string } {
    return {
      user: (req.headers['x-user-id'] as string) || 'default',
      tenant: (req.headers['x-tenant-id'] as string) || 'default',
    };
  }

  /** GET /fs/cwd */
  getCwd = (req: Request, res: Response): void => {
    const { user, tenant } = this.identity(req);
    res.json({ cwd: this.fs.getCwd(user, tenant) });
  };

  /** GET /fs/dir?path= */
  listDir = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '/';
      res.json(await this.fs.listDir(user, tenant, path));
    } catch (err) {
      next(err);
    }
  };

  /** POST /fs/dir?path= */
  mkdir = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '/';
      await this.fs.mkdir(user, tenant, path);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/file?path=&binary= */
  readFile = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '';
      const binary = req.query.binary === '1' || req.query.binary === 'true';
      const buf = await this.fs.readFile(user, tenant, path, binary);
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
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '';
      const result = await this.fs.writeFile(user, tenant, path, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /fs/file?path= */
  remove = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '';
      await this.fs.remove(user, tenant, path);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/file/meta?path= */
  stat = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '';
      res.json(await this.fs.stat(user, tenant, path));
    } catch (err) {
      next(err);
    }
  };

  /** GET /fs/search?path=&pattern= */
  search = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const { user, tenant } = this.identity(req);
      const path = (req.query.path as string) || '/';
      const pattern = (req.query.pattern as string) || '*';
      res.json(await this.fs.search(user, tenant, path, pattern));
    } catch (err) {
      next(err);
    }
  };
}