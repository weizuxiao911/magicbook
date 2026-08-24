/**
 * 沙箱 Controller — interfaces/http/controllers/sandbox.controller.ts
 *
 * HTTP 入口: 参数解析 → 调 SandboxService → 返回 DTO（snake_case）.
 */

import type { Request, Response } from 'express';

import type { SandboxService } from '../../application/sandbox.service';
import type { SandboxRuntime } from '../../domain/models/sandbox-runtime';

/** 响应 DTO（client 契约: snake_case 完整地址 + mode） */
export interface SandboxResponse {
  runtimeId: string;
  cwd: string;
  opencode_base_url: string;
  fs_base_url: string;
  registry_url: string;
  /** 运行模式: local（免登录直连）| cluster（需登录） */
  mode: 'local' | 'cluster';
}

function toDto(runtime: SandboxRuntime): SandboxResponse {
  return {
    runtimeId: runtime.runtimeId,
    cwd: runtime.cwd,
    opencode_base_url: runtime.opencodeBaseUrl,
    fs_base_url: runtime.fsBaseUrl,
    registry_url: runtime.registryUrl,
    mode: runtime.mode,
  };
}

export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  /** GET /sandbox — 获取运行时沙箱 */
  get = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const user = (req.headers['x-user-id'] as string) || 'default';
      const tenant = (req.headers['x-tenant-id'] as string) || 'default';
      const runtime = await this.sandbox.get(user, tenant);
      res.json(toDto(runtime));
    } catch (err) {
      next(err);
    }
  };

  /** POST /sandbox — 创建运行时沙箱 */
  create = async (req: Request, res: Response, next: (err: unknown) => void): Promise<void> => {
    try {
      const user = (req.headers['x-user-id'] as string) || 'default';
      const tenant = (req.headers['x-tenant-id'] as string) || 'default';
      const runtime = await this.sandbox.create(user, tenant);
      res.status(201).json(toDto(runtime));
    } catch (err) {
      next(err);
    }
  };

  /** GET /sandbox/:runtimeId/events — SSE 实时推流沙箱事件 */
  events = (req: Request, res: Response): void => {
    const runtimeId = req.params.runtimeId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event: object): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: 'creating', runtimeId });
    const timer = setTimeout(() => {
      send({ type: 'ready', runtimeId, payload: { runtimeId } });
      res.end();
    }, 200);

    req.on('close', () => {
      clearTimeout(timer);
      res.end();
    });
  };
}