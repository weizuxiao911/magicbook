/**
 * 本地沙箱实现 — infrastructure/sandbox/local.ts
 *
 * 本地模式: 无独立容器, cwd 即 workspace 本身（workspaceRoot/, 不按用户分目录）.
 *   - opencode: 直接使用配置的上游 opencodeBaseUrl（生命周期: 探活 + 自启, cwd=workspace）
 *   - fs: sandbox 服务内置（fs_base_url = 自身 /fs, 与 opencode 同一 cwd）
 *   - registry: 独立服务（registry_url 由 REGISTRY_URL 配置）
 */

import fs from 'node:fs';

import type { ServerConfig } from '../config';
import type { SandboxRepository } from '../../domain/repositories/sandbox-repository';
import { SandboxRuntime } from '../../domain/models/sandbox-runtime';
import { ensureOpencode } from '../opencode/lifecycle';

export class LocalSandboxRepository implements SandboxRepository {
  constructor(
    private readonly config: ServerConfig,
    /** sandbox 服务自身对外 base（fs_base_url 用） */
    private readonly sandboxBase: string,
    /** registry 独立服务 base（registry_url 用） */
    private readonly registryBase: string,
  ) {}

  resolveCwd(user: string, tenant: string): string {
    // 本地模式: cwd 是相对地址（/workspace）, 供 client 做 file:// 根与 opencode 共享
    return '/workspace';
  }

  /** 宿主机绝对工作区根（fs 操作内部用） */
  private hostRoot(): string {
    return this.config.workspaceRoot;
  }

  async ensure(user: string, tenant: string): Promise<SandboxRuntime> {
    const cwd = this.resolveCwd(user, tenant);
    const isWin = process.platform === 'win32';
    const defaultShell = isWin
      ? 'powershell.exe'
      : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    fs.mkdirSync(this.hostRoot(), { recursive: true });
    // opencode 探活 + 自启（不存在则启动, cwd=workspace; 与 fs 共享同一 cwd）
    await ensureOpencode(this.config);
    const base = this.sandboxBase.replace(/\/+$/, '');
    return new SandboxRuntime(
      user,
      cwd,
      // Local 模式: client 直连上游 opencode（不经代理转发）
      this.config.opencodeBaseUrl,
      // fs 由 sandbox 服务内置实现（同一 cwd）
      `${base}/fs`,
      // pty（终端）: client 直连 opencode /pty（sandbox 只管理 opencode 生命周期）
      this.config.opencodeBaseUrl,
      // 默认 shell（终端创建用）
      defaultShell,
      // registry 独立服务
      `${this.registryBase.replace(/\/+$/, '')}/extension`,
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