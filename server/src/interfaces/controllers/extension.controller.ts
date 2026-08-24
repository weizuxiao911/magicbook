/**
 * vsix 拓展 Controller — interfaces/http/controllers/extension.controller.ts
 *
 * HTTP 入口: vsix 元数据/上传/下载/下架/静态资源, RESTful 资源化.
 */

import type { Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';

import type { ExtensionService } from '../../application/extension.service';

export class ExtensionController {
  private readonly upload: ReturnType<typeof multer>;

  constructor(
    private readonly extension: ExtensionService,
    uploadDir: string,
  ) {
    fs.mkdirSync(uploadDir, { recursive: true });
    this.upload = multer({ dest: uploadDir });
  }

  /** GET /extension — vsix 元数据清单 */
  listMetadata = async (_req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      res.json(await this.extension.listMetadata());
    } catch (err) {
      next(err);
    }
  };

  /** GET /extension/vsix/:file — 下载原始 .vsix */
  getVsix = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const file = path.basename(req.params.file);
      const full = await this.extension.getVsixPath(file);
      if (!full) {
        res.status(404).json({ error: 'vsix not found' });
        return;
      }
      res.download(full);
    } catch (err) {
      next(err);
    }
  };

  /** POST /extension/vsix — 上传 vsix（multipart field: file） */
  postVsix = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      this.upload.single('file')(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        void this.handleUpload(req, res, next);
      });
    } catch (err) {
      next(err);
    }
  };

  private async handleUpload(req: Request, res: Response, next: (err: unknown) => void): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'file field required' });
        return;
      }
      const meta = await this.extension.upload(req.file.path);
      res.status(201).json({ ok: true, ...meta.extension });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /extension/vsix/:file — 下架 */
  deleteVsix = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      await this.extension.remove(path.basename(req.params.file));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  };

  /** GET /extension/dist/:id/* — 解压产物静态资源 */
  getDistAsset = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const id = req.params.id;
      const rel = (req.params as Record<string, string>)['0'] || '';
      const full = await this.extension.getDistAsset(id, rel);
      if (!full) {
        res.status(404).json({ error: 'asset not found' });
        return;
      }
      res.sendFile(full);
    } catch (err) {
      next(err);
    }
  };
}