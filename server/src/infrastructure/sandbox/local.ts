/**
 * 本地沙箱实现 — infrastructure/sandbox/local.ts
 *
 * 本地模式: 无独立容器, cwd 即 workspace 本身（workspaceRoot/, 不按用户分目录）.
 *   - opencode: 直接使用配置的上游 opencodeBaseUrl
 *   - fs/registry: 统一 server 自身路由（由调用方传入 base 生成）
 */

import fs from 'node:fs';

import type { ServerConfig } from '../config';
import type { SandboxRepository } from '../../domain/repositories/sandbox-repository';
import { SandboxRuntime } from '../../domain/models/sandbox-runtime';
import { ensureOpencode } from '../opencode/lifecycle';

export class LocalSandboxRepository implements SandboxRepository {
  constructor(
    private readonly config: ServerConfig,
    /** server 自身对外 base（如 http://host:7787）, 用于生成 fs/registry 地址 */
    private readonly serverBase: string,
  ) {}

  resolveCwd(user: string, tenant: string): string {
    // 本地模式: cwd 就是 workspace 本身
    return this.config.workspaceRoot;
  }

  async ensure(user: string, tenant: string): Promise<SandboxRuntime> {
    const cwd = this.resolveCwd(user, tenant);
    fs.mkdirSync(cwd, { recursive: true });
    // opencode 探活 + 自启（不存在则启动, 幂等）
    await ensureOpencode(this.config);
    const base = this.serverBase.replace(/\/+$/, '');
    return new SandboxRuntime(
      user,
      cwd,
      // Local 模式: client 直连上游 opencode（不经代理转发）
      this.config.opencodeBaseUrl,
      `${base}/fs`,
      `${base}/extension`,
      'local',
      'ready',
      tenant,
      user,
    );
  }

  async release(runtimeId: string): Promise<void> {
    // 本地模式无独立容器, 保留目录与数据
    console.log(`[local-sandbox] release ${runtimeId}: noop (keeps workspace)`);
  }
}