/**
 * 沙箱编排 — application/sandbox.service.ts
 *
 * 编排 SandboxRepository: 获取/创建/释放沙箱.
 */

import type { SandboxRepository } from '../domain/repositories/sandbox-repository';
import type { SandboxRuntime } from '../domain/models/sandbox-runtime';

export class SandboxService {
  constructor(private readonly sandbox: SandboxRepository) {}

  /** 获取运行时沙箱（已存在则返回） */
  get(user: string, tenant: string): Promise<SandboxRuntime> {
    return this.sandbox.ensure(user, tenant);
  }

  /** 创建运行时沙箱 */
  create(user: string, tenant: string): Promise<SandboxRuntime> {
    return this.sandbox.ensure(user, tenant);
  }

  /** 释放沙箱 */
  release(runtimeId: string): Promise<void> {
    return this.sandbox.release(runtimeId);
  }

  /** 解析用户工作目录（不创建） */
  resolveCwd(user: string, tenant: string): string {
    return this.sandbox.resolveCwd(user, tenant);
  }
}