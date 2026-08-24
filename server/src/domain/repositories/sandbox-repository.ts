/**
 * 沙箱仓储接口（端口）— domain/repositories/sandbox-repository.ts
 *
 * 领域层定义的端口, 由基础设施层实现（local / cluster 两模式）.
 * 依赖方向: infrastructure → domain（依赖倒置）.
 */

import type { SandboxRuntime } from '../models/sandbox-runtime';

export interface SandboxRepository {
  /** 按用户/租户确保沙箱就绪（不存在则创建） */
  ensure(user: string, tenant: string): Promise<SandboxRuntime>;
  /** 释放沙箱（闲置回收） */
  release(runtimeId: string): Promise<void>;
  /** 解析用户工作目录（不创建） */
  resolveCwd(user: string, tenant: string): string;
}