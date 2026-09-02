/**
 * Portal — React Portal helper, 把 children 渲染到 document.body
 * 用于让 chat modal escape 出 right slot 容器, position:fixed 真正屏幕居中
 * (right slot 容器有 overflow/transform 等 containing block 会限制 fixed).
 *
 * 关键: portal 到 body 后, 失去 chat webview (.chat) 容器的 CSS 变量继承,
 *  --ai-bg-elev / --ai-glass-bg / --ai-glass-blur 等 fallback 全失效, modal 看着透明.
 *  解决: 在 portal 容器 inline style 注入完整主题色变量, 不依赖继承.
 * 主题跟随 body className (design-light / design-dark / vs / vs-light).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

/** 暗色主题变量集 (匹配 .chat 容器内定义, 暗色兜底) */
const DARK_VARS: React.CSSProperties = {
  ['--ai-bg' as any]: 'var(--editor-background, var(--app-surface-muted, #181818))',
  ['--ai-bg-elev' as any]: 'var(--editorWidget-background, #1c1c22)',
  ['--ai-bg-input' as any]: 'color-mix(in srgb, var(--ai-fg, #e5e7eb) 5%, var(--ai-bg-elev))',
  ['--ai-fg' as any]: 'var(--editor-foreground, #e5e7eb)',
  ['--ai-fg-muted' as any]: 'var(--descriptionForeground, #9ca3af)',
  ['--ai-border' as any]: 'var(--panel-border, rgba(255,255,255,0.08))',
  ['--ai-divider' as any]: 'var(--editor-lineHighlightBorder, rgba(255,255,255,0.06))',
  ['--ai-hover' as any]: 'var(--list-hoverBackground, rgba(255,255,255,0.06))',
  ['--ai-active' as any]: 'var(--list-activeSelectionBackground, rgba(99,102,241,0.18))',
  ['--ai-accent' as any]: 'var(--button-background, #6366f1)',
  ['--ai-accent-fg' as any]: 'var(--button-foreground, #ffffff)',
  ['--ai-accent-soft' as any]: 'rgba(99,102,241,0.18)',
  ['--ai-danger' as any]: 'var(--errorForeground, #fca5a5)',
  ['--ai-danger-bg' as any]: 'rgba(239,68,68,0.18)',
  ['--ai-success' as any]: 'var(--terminal-ansiGreen, #4ade80)',
  ['--ai-shadow' as any]: '0 16px 40px rgba(0,0,0,0.5)',
  ['--ai-metal-hi' as any]: 'color-mix(in srgb, var(--ai-fg) 22%, #ffffff)',
  ['--ai-metal-mid' as any]: 'color-mix(in srgb, var(--ai-fg) 10%, var(--ai-bg-elev))',
  ['--ai-metal-lo' as any]: 'color-mix(in srgb, var(--ai-fg) 2%, #000000)',
  ['--ai-metal' as any]: 'linear-gradient(180deg, var(--ai-metal-hi) 0%, var(--ai-metal-mid) 45%, var(--ai-metal-lo) 100%)',
  ['--ai-metal-edge' as any]: 'color-mix(in srgb, var(--ai-fg) 18%, transparent)',
  ['--ai-metal-accent-hi' as any]: 'color-mix(in srgb, var(--ai-accent) 55%, #ffffff)',
  ['----ai-metal-accent' as any]: 'linear-gradient(180deg, var(--ai-metal-accent-hi) 0%, var(--ai-accent) 55%, color-mix(in srgb, var(--ai-accent) 75%, #000000) 100%)',
  ['--ai-glass-bg' as any]: 'color-mix(in srgb, var(--ai-bg-elev) 86%, transparent)',
  ['--ai-glass-blur' as any]: 'blur(18px) saturate(160%)',
  ['--ai-glass-edge' as any]: 'var(--ai-border)',
  ['--ai-pop-shadow' as any]: '0 24px 60px color-mix(in srgb, #000 55%, transparent), 0 0 0 1px var(--ai-glass-edge) inset',
  ['--ai-chrome' as any]: 'radial-gradient(circle at 32% 24%, var(--ai-metal-hi) 0%, var(--ai-metal-mid) 40%, var(--ai-metal-lo) 92%)',
};

/** 亮色主题变量集 (亮色背景, 深色文字, 跟 .chat 内 light 主题一致) */
const LIGHT_VARS: React.CSSProperties = {
  ['--ai-bg' as any]: 'var(--editor-background, var(--app-surface-muted, #f6f6f6))',
  ['--ai-bg-elev' as any]: '#ffffff',
  ['--ai-bg-input' as any]: 'color-mix(in srgb, var(--ai-fg, #1f2328) 5%, #ffffff)',
  ['--ai-fg' as any]: 'var(--editor-foreground, #1f2328)',
  ['--ai-fg-muted' as any]: 'var(--descriptionForeground, #6b7280)',
  ['--ai-border' as any]: 'var(--panel-border, rgba(0,0,0,0.12))',
  ['--ai-divider' as any]: 'rgba(0,0,0,0.06)',
  ['--ai-hover' as any]: 'rgba(0,0,0,0.04)',
  ['--ai-active' as any]: 'rgba(99,102,241,0.14)',
  ['--ai-accent' as any]: 'var(--button-background, #6366f1)',
  ['--ai-accent-fg' as any]: 'var(--button-foreground, #ffffff)',
  ['--ai-accent-soft' as any]: 'rgba(99,102,241,0.14)',
  ['--ai-danger' as any]: 'var(--errorForeground, #dc2626)',
  ['--ai-danger-bg' as any]: 'rgba(239,68,68,0.12)',
  ['--ai-success' as any]: '#16a34a',
  ['--ai-shadow' as any]: '0 16px 40px rgba(0,0,0,0.18)',
  ['--ai-metal-hi' as any]: '#ffffff',
  ['--ai-metal-mid' as any]: '#f3f4f6',
  ['--ai-metal-lo' as any]: '#d1d5db',
  ['--ai-metal' as any]: 'linear-gradient(180deg, #ffffff 0%, #f3f4f6 45%, #d1d5db 100%)',
  ['--ai-metal-edge' as any]: 'rgba(0,0,0,0.10)',
  ['--ai-metal-accent-hi' as any]: '#a5b4fc',
  ['--ai-metal-accent' as any]: 'linear-gradient(180deg, #a5b4fc 0%, #6366f1 55%, #4338ca 100%)',
  ['--ai-glass-bg' as any]: 'color-mix(in srgb, #ffffff 96%, transparent)',
  ['--ai-glass-blur' as any]: 'blur(18px) saturate(160%)',
  ['--ai-glass-edge' as any]: 'rgba(0,0,0,0.12)',
  ['--ai-pop-shadow' as any]: '0 24px 60px rgba(0,0,0,0.18), 0 0 0 1px var(--ai-glass-edge) inset',
  ['--ai-chrome' as any]: 'radial-gradient(circle at 32% 24%, #ffffff 0%, #f3f4f6 40%, #d1d5db 92%)',
};

/** 从 body className 推断主题 */
function isLightTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const cls = document.body.className || '';
  return /design-light|vs-light|light/i.test(cls);
}

export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mounted, setMounted] = useState(false);
  const [light, setLight] = useState(isLightTheme);

  useEffect(() => { setMounted(true); }, []);

  // 监听 body className 变化 (主题切换), 实时更新变量
  useEffect(() => {
    if (!mounted) return;
    const obs = new MutationObserver(() => setLight(isLightTheme()));
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [mounted]);

  const wrapperStyle = useMemo(() => (light ? LIGHT_VARS : DARK_VARS), [light]);

  if (typeof document === 'undefined' || !mounted) return null;
  return createPortal(
    <div className="numas-portal-root" style={wrapperStyle}>
      {children}
    </div>,
    document.body,
  );
};
