/**
 * 沙箱运行时领域模型 — domain/models/sandbox-runtime.ts
 *
 * 领域核心值对象: 一个运行时沙箱 = 用户/租户独享的 AI + 文件系统运行环境.
 * 零框架依赖.
 */

/** 沙箱状态 */
export type SandboxStatus = 'creating' | 'ready' | 'error' | 'terminating';

/** 运行模式 */
export type SandboxMode = 'local' | 'cluster';

/** 沙箱运行时（领域模型, 含各协议完整地址） */
export class SandboxRuntime {
  constructor(
    public readonly runtimeId: string,
    public readonly cwd: string,
    public readonly opencodeBaseUrl: string,
    public readonly fsBaseUrl: string,
    public readonly registryUrl: string,
    public readonly mode: SandboxMode = 'local',
    public readonly status: SandboxStatus = 'ready',
    public readonly tenant: string = 'default',
    public readonly user: string = 'default',
  ) {}

  /** 是否就绪可用 */
  isReady(): boolean {
    return this.status === 'ready';
  }
}