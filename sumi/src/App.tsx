/**
 * App — src/App.tsx
 *
 * 骨架系统: codeblitz AppRenderer 渲染 IDE 容器.
 * 渲染前拉取 registry 拓展元数据（编译期配置, 无登录依赖; codeblitz ext host 加载 vsix 用）.
 */

import React, { useEffect, useMemo, useState } from 'react';

import { AppRenderer, getDefaultAppConfig } from '@codeblitzjs/ide-core';
import { SlotLocation } from '@opensumi/ide-core-browser';
import '@codeblitzjs/ide-core/bundle/codeblitz.css';
import '@codeblitzjs/ide-core/languages';

import { buildSlots } from './config/slots';
import { getBuiltinModules } from './config/modules';
import { preferences } from './config/preferences';
import { runtimeConfig } from './config/runtime';
import { ExtensionServiceImpl } from './service/extension';
import type { ExtensionMetadata } from './service/extension';
import { urlWorkspace, getWorkspace, appBaseUrl } from './infra/url';
import { APP_CHAT_CONFIG } from './config/brand';
import './styles/overrides.css';
import './styles/slots.css';

const BRAND = APP_CHAT_CONFIG.brand;

/**
 * SplashScreen — URL 缺 `?directory=` 时的显式动画 loading 遮罩.
 * App 侧会先探测真实 workspace → replaceState 补 URL → reload;
 * reload 后 urlWorkspace() 非空, 正常渲染 IDE. 探测失败由 8s 超时兜底.
 * 品牌文案一律来自 config/brand.ts (单一来源), 不在此硬编码.
 */
function SplashScreen(): React.JSX.Element {
  return (
    <div className="numas-splash" role="status" aria-live="polite">
      <div className="numas-splash-logo">{BRAND.logo}</div>
      <div className="numas-splash-spinner" />
      <div className="numas-splash-title">{BRAND.name}</div>
      <div className="numas-splash-text">{BRAND.subtitle}</div>
    </div>
  );
}

/**
 * 探测真实 workspace 并同步到 URL (source-of-truth).
 * 流程: URL `?directory=` 已有 → 直接用; 没有 → 调 opencode `/path` 拿 directory 补 URL。
 * 返回 true 表示已补好 URL (调用方应 reload); false 表示无可补 (交给 initRuntime 兜底)。
 */
async function ensureUrlWorkspace(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    if (urlWorkspace()) return false; // URL 已有, 无需处理
    // 主动探 opencode /path 拿 workdir
    let ws = '';
    const base = appBaseUrl();
    if (base) {
      try {
        const res = await fetch(`${base.replace(/\/+$/, '')}/path`, {
          headers: { Accept: 'application/json' },
        });
        const json = await res.json();
        ws = json?.directory || json?.worktree || '';
      } catch { /* ignore */ }
    }
    if (!ws) return false;
    const u = new URL(window.location.href);
    u.searchParams.set('directory', ws);
    window.history.replaceState(null, '', u.toString());
    console.log('[App] 探测 workspace 并补 URL:', ws);
    return true;
  } catch { return false; }
}

export const App: React.FC = () => {
  const defaultModules = getDefaultAppConfig().modules || [];
  const [extensionMetadata, setExtensionMetadata] = useState<ExtensionMetadata[]>([]);
  const [ready, setReady] = useState(false);
  // URL 缺 `?directory=` 时先显示 splash: 探测 workspace → replaceState 补 URL → reload
  const noExplicitWorkspace = urlWorkspace() === '';
  // 兜底: 探测失败 / opencode 未起时, 8s 后强制渲染 IDE (跳过 reload 分支)
  const [forceRender, setForceRender] = useState(false);
  // 启动期直接 instantiate (DI 容器还未就绪, 一次性调用)
  const extService = useMemo(() => new ExtensionServiceImpl(), []);

  useEffect(() => {
    extService.installMetadata()
      .then(setExtensionMetadata)
      .finally(() => setReady(true));
  }, [extService]);

  // URL 缺 `?directory=` 时: 探测真实 workspace 补 URL → reload (一次性)
  useEffect(() => {
    if (!noExplicitWorkspace) return;
    let cancelled = false;
    const t = setTimeout(() => { if (!cancelled) setForceRender(true); }, 8000);
    (async () => {
      try {
        const patched = await ensureUrlWorkspace();
        if (!cancelled && patched) window.location.reload();
        else if (!cancelled) setForceRender(true);
      } catch { if (!cancelled) setForceRender(true); }
    })();
    return () => { cancelled = true; clearTimeout(t); };
  }, [noExplicitWorkspace]);

  if (!ready || (noExplicitWorkspace && !forceRender)) return <SplashScreen />;

  return (
    <AppRenderer
      appConfig={{
        workspaceDir: '/',
        ...buildSlots(),
        // monaco worker CDN: alipay (gw.alipayobjects.com) 404 缺失 editor.worker.bundle.js
        //   → 编辑器 fallback 主线程 "现在无法访问编辑器". jsdelivr / npmmirror 有文件.
        componentCDNType: 'jsdelivr',
        useSimplifyExplorerPanel: true, // 去掉 explorer 容器里的「打开的编辑器」「大纲」section
        // 槽位尺寸单一事实源 (SlotRenderer 上的 defaultSize/minSize 等 prop 已被外层忽略,
        //   见 sumi/src/layout.tsx 注释)
        panelSizes: {
          [SlotLocation.left]: 268,   // explorer
          [SlotLocation.right]: 468,  // chat (sumi/src/extensions/chat/module.ts: SlotLocation.right)
          [SlotLocation.bottom]: 200,  // terminal / output / markers
        },
        defaultPreferences: preferences,
        extensionMetadata: extensionMetadata as any,
        modules: [
          ...defaultModules,
          ...getBuiltinModules(),
        ],
      }}
      runtimeConfig={runtimeConfig as any}
    />
  );
};