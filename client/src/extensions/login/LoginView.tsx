/**
 * LoginView — extensions/login/LoginView.tsx
 *
 * 全屏登录页 (本地免登录模式: 任意账号密码可登录).
 * 登录状态持久化: cookie 存 username, 刷新后读取自动视为已登录 (跳过登录页).
 *
 * 流程:
 *   - 启动读 cookie: 有 username → 直接初始化 + 建 client (已登录, 跳过)
 *   - 无 → 全屏登录页
 *   - 登录成功 → 写 cookie → 初始化 BASE_URL + SDK client → 派发 app.logined
 *   - 监听 app.connected (fs 确认 client 就绪) → 写 .env.user → 进入主界面
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { CommandService } from '@opensumi/ide-core-common';

import { getSandboxService } from '../../service/sandbox';
import { getAuthService } from '../../service/auth';
import { toFileUri } from '../../service/base';
import { APP_CHAT_CONFIG } from '../../core/config/brand';
import { FsToken, type IFileSystem } from '../../core/commands/fs';

import { LOGIN_EVENTS, USER_COOKIE, getCookie } from './module';

export const LoginView: React.FC = () => {
  const commandService = useInjectable<CommandService>(CommandService);
  const fs = useInjectable<IFileSystem>(FsToken);
  const brand = useMemo(() => APP_CHAT_CONFIG.brand, []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  // 登录面板可见性: 由 URL hash 驱动 — location.hash === '#login' 时显示, 否则隐藏.
  // chat「去登录」→ 设 #login; 关闭/登录成功 → 去掉 #login.
  const [visible, setVisible] = useState<boolean>(() => location.hash === '#login');
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onHashChange = () => setVisible(location.hash === '#login');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 默认激活用户名输入框 (多次重试, 覆盖 chat 面板的延迟聚焦)
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [150, 400, 900, 1600]) {
      timers.push(setTimeout(() => usernameRef.current?.focus(), delay));
    }
    return () => timers.forEach(clearTimeout);
  }, []);

  /** 初始化服务 (登录后: 获取沙箱 runtime → 应用各协议地址 → 派发 app.logined) */
  const doLogin = useCallback((user: string) => {
    // 1. 登录态写入（service/auth 统一管理 cookie + 广播 logined）
    getAuthService().loginSucceed(user);
    void (async () => {
      try {
        // 2. 获取/创建沙箱 → server 返回完整协议地址
        const runtime = await getSandboxService().get();
        // 3. 应用运行时 (写全局配置: agentUrl/fsUrl/registryUrl)
        getSandboxService().applyRuntime(runtime);
        getAuthService().runtimeChanged(true);
        console.log('[login] sandbox runtime 就绪:', runtime.runtimeId);
      } catch (err) {
        console.warn('[login] sandbox 获取失败 (骨架模式继续):', err);
      }
      window.dispatchEvent(new CustomEvent(LOGIN_EVENTS.LOGINED, { detail: { username: user } }));
      console.log('[login] app.logined:', user);
      // 登录成功 → 关闭登录面板（去掉 #login, 回默认布局）
      setConnected(true);
      if (location.hash === '#login') location.hash = '';
      commandService.tryExecuteCommand('filetree.refresh.all').catch(() => {});
    })();
  }, [commandService]);

  // 启动: 读 cookie 判断是否已登录
  useEffect(() => {
    const saved = getCookie(USER_COOKIE);
    if (saved) {
      console.log('[login] cookie 已登录:', saved);
      doLogin(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 app.connected: fs 侧 client 就绪后派发 → 写 .env.user → 进入主界面
  useEffect(() => {
    const onConnected = (e: Event) => {
      const detail = (e as CustomEvent<{ username?: string }>).detail || {};
      const user = detail.username || getCookie(USER_COOKIE) || username;
      console.log('[login] app.connected:', user);
      void (async () => {
        try {
          if (fs?.write) {
            await fs.write(toFileUri('/.env.user'), `USERNAME=${user}\n`);
            console.log('[login] 已写入 workspace/.env.user');
          }
        } catch (err) {
          console.warn('[login] 写 .env.user 失败:', err);
        }
        setConnected(true);
      })();
    };
    window.addEventListener(LOGIN_EVENTS.CONNECTED, onConnected);
    return () => window.removeEventListener(LOGIN_EVENTS.CONNECTED, onConnected);
  }, [username]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      doLogin(username.trim());
    } catch (err: any) {
      setError(err?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  }, [username, password, doLogin]);

  // 登录成功 (cookie 已登录 或 connected) 后进入主界面
  // 已登录 → 不渲染; 未登录 → 仅当用户点击「去登录」触发 visible 时显示登录面板
  if (connected || getCookie(USER_COOKIE) || !visible) return null;

  return (
    <div className="ab-login">
      <style>{STYLES}</style>
      <div className="ab-login__bg" aria-hidden="true">
        <div className="ab-login__orb ab-login__orb--1" />
        <div className="ab-login__orb ab-login__orb--2" />
        <div className="ab-login__orb ab-login__orb--3" />
        <div className="ab-login__grid" />
      </div>

      <div className="ab-login__card">
        <button
          className="ab-login__close"
          title="关闭"
          aria-label="关闭登录"
          onClick={() => {
            location.hash = '';
          }}
        >
          ×
        </button>
        <div className="ab-login__logo">
          <span>{brand.logoChar}</span>
        </div>
        <h1 className="ab-login__title">{brand.name}</h1>
        <p className="ab-login__tagline">{brand.tagline}</p>

        <form className="ab-login__form" onSubmit={handleSubmit}>
          <div className="ab-login__field">
            <svg className="ab-login__field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <input
              className="ab-login__input"
              type="text"
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              ref={usernameRef}
            />
          </div>
          <div className="ab-login__field">
            <svg className="ab-login__field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <input
              className="ab-login__input"
              type={showPwd ? 'text' : 'password'}
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="ab-login__pwd-toggle"
              title={showPwd ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPwd(!showPwd)}
            >
              {showPwd ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          {error && <div className="ab-login__error">{error}</div>}

          <button type="submit" className="ab-login__btn" disabled={loading}>
            {loading ? (
              <span className="ab-login__spinner" />
            ) : (
              '登 录'
            )}
          </button>
        </form>

        <p className="ab-login__hint">本地模式 · 任意账号密码均可登录</p>
      </div>
    </div>
  );
};

const STYLES = `
.ab-login {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--app-panel-bg, var(--editor-background, #181818));
  color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.ab-login__bg { position: absolute; inset: 0; pointer-events: none; }
.ab-login__orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: .45;
}
.ab-login__orb--1 {
  width: 480px; height: 480px;
  top: -120px; left: -80px;
  background: radial-gradient(circle, color-mix(in srgb, var(--button-background, #2563eb) 50%, transparent), transparent 70%);
  animation: ab-login-drift 18s ease-in-out infinite alternate;
}
.ab-login__orb--2 {
  width: 520px; height: 520px;
  bottom: -160px; right: -100px;
  background: radial-gradient(circle, color-mix(in srgb, var(--focusBorder, #4f8cff) 38%, transparent), transparent 70%);
  animation: ab-login-drift 22s ease-in-out infinite alternate-reverse;
}
.ab-login__orb--3 {
  width: 320px; height: 320px;
  top: 55%; left: 12%;
  background: radial-gradient(circle, color-mix(in srgb, var(--button-background, #2563eb) 26%, transparent), transparent 70%);
  animation: ab-login-drift 26s ease-in-out infinite alternate;
}
@keyframes ab-login-drift {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(60px, 40px) scale(1.12); }
}
.ab-login__grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(color-mix(in srgb, var(--editor-foreground, #e5e7eb) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--editor-foreground, #e5e7eb) 5%, transparent) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, #000 30%, transparent 75%);
}
.ab-login__card {
  position: relative;
  width: 380px;
  padding: 44px 40px 32px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--editor-background, #1c1e26) 88%, transparent);
  border: 1px solid var(--app-border, var(--panel-border, rgba(128,128,128,.2)));
}
.ab-login__close {
  position: absolute;
  top: 12px; right: 12px;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 7px;
  color: var(--editor-foreground, #e5e7eb);
  font-size: 18px; line-height: 1;
  cursor: pointer;
  transition: background .12s;
}
.ab-login__close:hover { background: rgba(128,128,128,.2); }
  box-shadow:
    0 30px 80px rgba(0,0,0,.4),
    inset 0 1px 0 color-mix(in srgb, var(--editor-foreground, #fff) 7%, transparent);
  backdrop-filter: blur(20px) saturate(1.3);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  text-align: center;
  animation: ab-login-pop .35s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes ab-login-pop {
  from { transform: translateY(16px) scale(.97); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
.ab-login__logo {
  width: 68px; height: 68px;
  margin: 0 auto 16px;
  border-radius: 18px;
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700;
  background: linear-gradient(135deg, var(--button-background, #2563eb), color-mix(in srgb, var(--button-background, #2563eb) 60%, #8b5cf6));
  color: var(--button-foreground, #fff);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--button-background, #2563eb) 35%, transparent);
}
.ab-login__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: .3px;
  color: var(--editor-foreground, var(--vscode-editor-foreground, #e5e7eb));
}
.ab-login__tagline {
  margin: 8px 0 30px;
  font-size: 13.5px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #9a9aa3));
}
.ab-login__form { display: flex; flex-direction: column; gap: 14px; }
.ab-login__field { position: relative; }
.ab-login__field-icon {
  position: absolute;
  left: 14px; top: 50%;
  width: 17px; height: 17px;
  transform: translateY(-50%);
  color: var(--descriptionForeground, #8a8a92);
  pointer-events: none;
  transition: color .18s;
}
.ab-login__field:focus-within .ab-login__field-icon { color: var(--focusBorder, #4f8cff); }
.ab-login__input {
  width: 100%;
  height: 44px;
  padding: 0 14px 0 42px;
  border-radius: 12px;
  border: 1px solid var(--app-border, var(--panel-border, rgba(128,128,128,.25)));
  background: color-mix(in srgb, var(--editor-background, #181818) 92%, transparent);
  color: inherit;
  font-size: 14.5px;
  outline: none;
  /* 凹下去 (默认即凹陷): 顶部深内阴影 + 底部暗边 */
  box-shadow:
    inset 0 2px 5px rgba(0,0,0,.28),
    inset 0 -1px 1px rgba(0,0,0,.18),
    inset 2px 0 4px rgba(0,0,0,.1),
    inset -2px 0 4px rgba(0,0,0,.1);
  transition: border-color .18s, box-shadow .18s, background .18s;
}
.ab-login__input::placeholder { color: var(--descriptionForeground, #8a8a92); }
.ab-login__input:focus {
  border-color: var(--focusBorder, #4f8cff);
  background: color-mix(in srgb, var(--editor-background, #181818) 94%, transparent);
  box-shadow:
    inset 0 2px 4px rgba(0,0,0,.18),
    inset 0 -1px 0 color-mix(in srgb, var(--editor-foreground, #fff) 8%, transparent),
    0 0 0 3px color-mix(in srgb, var(--focusBorder, #4f8cff) 16%, transparent);
}
.ab-login__field:has(input[type="password"]) .ab-login__input { padding-right: 44px; }
.ab-login__pwd-toggle {
  position: absolute;
  right: 6px; top: 50%;
  transform: translateY(-50%);
  width: 32px; height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--descriptionForeground, #8a8a92);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color .15s, background .15s;
}
.ab-login__pwd-toggle:hover { color: inherit; background: color-mix(in srgb, var(--editor-foreground, #fff) 6%, transparent); }
.ab-login__error {
  font-size: 12.5px;
  color: var(--errorForeground, #f48771);
  text-align: left;
  padding-left: 2px;
}
.ab-login__btn {
  height: 48px;
  margin-top: 4px;
  border: none;
  border-radius: 13px;
  background: linear-gradient(160deg,
    color-mix(in srgb, var(--button-background, #2563eb) 92%, #fff),
    var(--button-background, #2563eb) 55%,
    color-mix(in srgb, var(--button-background, #2563eb) 72%, #1e1b4b));
  color: var(--button-foreground, #fff);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 3px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  /* 凸起: 多层阴影 (上亮 + 下深 + 外投影) */
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 35%, transparent),
    inset 0 -3px 8px rgba(0,0,0,.25),
    0 2px 4px rgba(0,0,0,.3),
    0 8px 24px color-mix(in srgb, var(--button-background, #2563eb) 35%, transparent);
  transition: transform .1s, box-shadow .15s, filter .15s;
}
.ab-login__btn:hover {
  filter: brightness(1.06);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 40%, transparent),
    inset 0 -3px 8px rgba(0,0,0,.22),
    0 4px 8px rgba(0,0,0,.32),
    0 12px 32px color-mix(in srgb, var(--button-background, #2563eb) 42%, transparent);
}
.ab-login__btn:active {
  transform: translateY(2px);
  box-shadow:
    inset 0 2px 6px rgba(0,0,0,.35),
    0 1px 2px rgba(0,0,0,.3);
}
.ab-login__btn:disabled { opacity: .7; cursor: not-allowed; }
.ab-login__spinner {
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ab-login-spin .7s linear infinite;
}
@keyframes ab-login-spin { to { transform: rotate(360deg); } }
.ab-login__hint {
  margin: 22px 0 0;
  font-size: 12px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground, #7c7c85));
}
`;
