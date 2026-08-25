/**
 * Login 拓展 — extensions/login/
 *
 * OpenSumi 内置拓展: webapp 登录门槛.
 *   - LoginContribution: 注册 LoginView 到自定义 `login` 槽位 (LayoutComponent 渲染为全屏遮罩)
 *   - LoginView: 用户名/密码表单, 本地免登录模式 (任意账号密码可登录)
 *
 * 登录流程 (见 README「登录与初始化流程」):
 *   1. 表单提交 → 初始化 opencodeBaseUrl/registryBaseUrl (env 默认值) + 建 SDK client
 *   2. 派发 app.logined {username}
 *   3. 监听 app.connected (fs 侧 client 就绪后派发) → fs.write /.env.user 写 username
 */

import { Injectable } from '@opensumi/di';
import { Domain, CommandContribution, CommandRegistry } from '@opensumi/ide-core-common';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { ComponentContribution, ComponentRegistry } from '@opensumi/ide-core-browser/lib/layout';

import { AUTH_CMD as AUTH_CMD_CORE } from '../../core/commands/auth';
import { LoginView } from './LoginView';

/** 自定义登录槽位 id (LayoutComponent 里用 SlotRenderer slot="login" 渲染为全屏遮罩) */
export const LOGIN_SLOT = 'login';

/** 登录 cookie 名 */
export const USER_COOKIE = 'animbook_username';

/** 登录/连接事件名 (window CustomEvent 消息机制) */
export const LOGIN_EVENTS = {
  LOGINED: 'app.logined',
  CONNECTED: 'app.connected',
  SHOW_LOGIN: 'auth:show-login',
  HIDE_LOGIN: 'auth:hide-login',
} as const;

/**
 * 登录相关全局命令 (跨拓展调用唯一通道):
 *   auth.showLogin   唤起登录面板
 *   auth.hideLogin   关闭登录面板
 * 命令 ID 定义在 core/commands/auth（AUTH_CMD）, 其他拓展通过 CommandService.executeCommand 调用.
 */
export const AUTH_CMD = AUTH_CMD_CORE;

/** 读取登录 cookie */
export function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** 是否已登录 */
export function isLoggedIn(): boolean {
  return !!getCookie(USER_COOKIE);
}

/** 当前登录用户名 */
export function getUsername(): string | null {
  return getCookie(USER_COOKIE);
}

/**
 * 退出登录: 清 cookie + 刷新回登录页.
 * 供 actions 槽位登出按钮 / 其他拓展调用.
 */
export function logout(): void {
  document.cookie = `${USER_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  console.log('[login] logout, 刷新回登录页');
  window.location.reload();
}

/**
 * 挂全局登录/登出能力 (供内置拓展 / vsix 取用):
 *   window.__APP_AUTH__ = { isLoggedIn, getUsername, logout, showLogin, hideLogin }
 * showLogin/hideLogin 内部走全局命令 (auth.*), 不直接派发 CustomEvent.
 */
export function installAuthGlobal(): void {
  (window as any).__APP_AUTH__ = {
    isLoggedIn,
    getUsername,
    logout,
    showLogin: () => window.dispatchEvent(new CustomEvent(LOGIN_EVENTS.SHOW_LOGIN)),
    hideLogin: () => window.dispatchEvent(new CustomEvent(LOGIN_EVENTS.HIDE_LOGIN)),
  };
}

@Injectable()
@Domain(ComponentContribution, ClientAppContribution, CommandContribution)
export class LoginContribution implements ComponentContribution, ClientAppContribution, CommandContribution {
  registerComponent(registry: ComponentRegistry): void {
    registry.register(LOGIN_SLOT, {
      id: LOGIN_SLOT,
      component: LoginView,
    }, undefined, LOGIN_SLOT);
  }

  registerCommands(commands: CommandRegistry): void {
    // 登录面板由 URL hash 驱动: #login 显示, 无 hash 隐藏
    commands.registerCommand({ id: AUTH_CMD.SHOW_LOGIN }, {
      execute: () => { location.hash = '#login'; },
    });
    commands.registerCommand({ id: AUTH_CMD.HIDE_LOGIN }, {
      execute: () => { if (location.hash === '#login') location.hash = ''; },
    });
  }

  onDidStart(): void {
    installAuthGlobal();
  }
}

@Injectable()
export class LoginModule extends BrowserModule {
  providers = [LoginContribution];

  contributionProvider = [ComponentContribution, ClientAppContribution, CommandContribution];
}
