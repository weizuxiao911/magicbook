/**
 * auth 实现 — service/auth/index.ts
 *
 * implements core/commands/auth 的 IAuth: 登录态 / 会话 / 运行时就绪.
 * 单一事实源: cookie 登录态 + sandbox runtime 就绪 + 全局事件广播.
 *
 * 跨拓展唤起登录走 AUTH_CMD 命令（login 拓展注册, 此处经 CommandService 执行）.
 */

import { Injectable, Autowired, INJECTOR_TOKEN, Injector } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { CommandService } from '@opensumi/ide-core-common';

import type { AuthEvent, IAuth } from '../../core/commands/auth';
import { AuthToken, AUTH_CMD } from '../../core/commands/auth';

const USER_COOKIE = 'animbook_username';

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

@Injectable()
export class AuthServiceImpl implements IAuth {
  static instance: AuthServiceImpl | null = null;

  @Autowired(INJECTOR_TOKEN)
  private readonly injector!: Injector;

  private listeners = new Set<(e: AuthEvent) => void>();

  constructor() {
    AuthServiceImpl.instance = this;
    this.attachWindowEvents();
  }

  isLoggedIn(): boolean {
    return !!getCookie(USER_COOKIE);
  }

  getUsername(): string | null {
    return getCookie(USER_COOKIE);
  }

  isRuntimeReady(): boolean {
    const rt = (window as any).__APP_SANDBOX__?.getRuntime?.();
    return !!rt;
  }

  showLogin(): void {
    this.command().executeCommand(AUTH_CMD.SHOW_LOGIN).catch(() => {});
  }

  hideLogin(): void {
    this.command().executeCommand(AUTH_CMD.HIDE_LOGIN).catch(() => {});
  }

  logout(): void {
    document.cookie = `${USER_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    this.emit('logout');
    window.location.reload();
  }

  onAuthEvent(handler: (e: AuthEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** 登录成功（由 login 拓展调用, 写入 cookie 并广播） */
  loginSucceed(user: string): void {
    document.cookie = `${USER_COOKIE}=${encodeURIComponent(user)}; path=/; max-age=${30 * 24 * 60 * 60}`;
    this.emit('logined');
  }

  /** runtime 就绪/丢失（由 sandbox 应用后调用） */
  runtimeChanged(ready: boolean): void {
    this.emit(ready ? 'runtime-ready' : 'runtime-lost');
  }

  private command(): CommandService {
    return this.injector.get(CommandService);
  }

  private emit(e: AuthEvent): void {
    this.listeners.forEach((fn) => fn(e));
  }

  private attachWindowEvents(): void {
    window.addEventListener('app.logined', () => this.emit('logined'));
    window.addEventListener('app.connected', () => this.emit('runtime-ready'));
  }
}

/** 模块级单例 getter */
export function getAuthService(): IAuth {
  return AuthServiceImpl.instance || (AuthServiceImpl.instance = new AuthServiceImpl());
}

@Injectable()
export class AuthModule extends BrowserModule {
  providers = [{ token: AuthToken, useFactory: () => getAuthService() }];
}

/** 安装全局单例 */
export function installAuthService(): void {
  (window as any).__APP_AUTH__ = getAuthService();
  console.log('[auth] service installed');
}