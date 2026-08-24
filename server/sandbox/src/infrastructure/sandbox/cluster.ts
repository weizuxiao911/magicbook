/**
 * 集群沙箱实现（占位）— infrastructure/sandbox/cluster.ts
 *
 * ⚠️ 本期不做 cluster 模式（先验证本地模式系统链路闭环）.
 *
 * 目标链路（参考 taichu gateway 契约）:
 *   server → Service(ClusterIP) → Deployment → Pod(agent-image, 内置 opencode :24096)
 *
 * 规划:
 *   - 客户端: @kubernetes/client-node（等价 Fabric8）
 *   - Deployment: 按 runtimeId 命名/label, 镜像 agent-image, PVC workspace+config 双 subPath
 *   - ENV 注入: X-USER-ID / X-TENANT-ID
 *   - Service: ClusterIP 寻址, server 经 {svc}.{ns}.svc.cluster.local:24096 转发
 *   - opencode_base_url = server 内部可达的 svc 地址（client 只连 server, 不直连 pod）
 *
 * 启动方式: SERVER_MODE=cluster 时启用（当前未实现, 会抛出未实现错误）.
 */

import type { ServerConfig } from '../config';
import type { SandboxRepository } from '../../domain/repositories/sandbox-repository';
import { SandboxRuntime } from '../../domain/models/sandbox-runtime';

export class ClusterSandboxRepository implements SandboxRepository {
  constructor(
    private readonly config: ServerConfig,
    private readonly sandboxBase: string,
  ) {}

  resolveCwd(user: string, tenant: string): string {
    return `/workspace/${tenant}/${user}`;
  }

  async ensure(user: string, tenant: string): Promise<SandboxRuntime> {
    throw new Error(
      '[cluster] 集群模式未实现（本期先验证本地模式链路闭环）。' +
      '目标链路: server → Service → Deployment → Pod(agent-image)。' +
      '启动方式: 保持 SERVER_MODE=local',
    );
  }

  async release(runtimeId: string): Promise<void> {
    throw new Error('[cluster] 集群模式未实现（本期先验证本地模式链路闭环）');
  }
}