/**
 * extensions/browser/BrowserView.tsx — 内置浏览器主编辑区组件
 *
 * 布局: 顶部 URL 栏 (输入地址回车导航 / 刷新 / 在真实浏览器打开) +
 *       下方 <iframe> 撑满 main slot (宽高 100%).
 * iframe sandbox 允许脚本/同源/表单/弹窗; 本地服务永远经 /proxy 反代 = 同源可调试 (强制规则).
 * 挂载时向 IBrowserService 注册 BrowserViewApi (导航/刷新/取 iframe), 卸载注销.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';

import { BrowserToken, type IBrowserService, type BrowserViewApi } from './browser.interface';
import { normalizeUrl } from './browser.service';

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, flexShrink: 0, cursor: 'pointer',
  background: 'transparent', border: 'none', borderRadius: 6,
  color: 'var(--editor-foreground, #e5e7eb)',
};

export const BrowserView: React.FC<{ resource?: any }> = () => {
  const browser = useInjectable<IBrowserService>(BrowserToken as any);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [addr, setAddr] = useState('');          // 地址栏文本: 用户输入的真实地址 (不变)
  const [src, setSrc] = useState('about:blank'); // iframe 实际加载地址
  const [nonce, setNonce] = useState(0);         // 刷新用 (改 key 强制重载)
  // refs: 供 mount 时注册的视图句柄读取最新值 (避免闭包过期)
  const addrRef = useRef('');
  const srcRef = useRef('about:blank');
  addrRef.current = addr;
  srcRef.current = src;

  const doNavigate = useCallback((input: string) => {
    const norm = normalizeUrl(input);
    setAddr(norm.real || input);   // 地址栏展示用户输入的真实地址, 不暴露反代
    setSrc(norm.src || 'about:blank'); // iframe 实际加载地址 (本地服务 = 反代)
  }, []);
  // 始终指向最新 doNavigate (供 mount 时注册的句柄调用, 避免闭包过期)
  const doNavigateRef = useRef(doNavigate);
  doNavigateRef.current = doNavigate;

  // 挂载: 注册视图句柄 + 消费待打开 URL
  useEffect(() => {
    const api: BrowserViewApi = {
      navigate: (url: string) => doNavigateRef.current(url),
      reload: () => setNonce((n) => n + 1),
      getRealUrl: () => addrRef.current,
      getSrc: () => srcRef.current,
      getIframe: () => iframeRef.current,
      postMessage: (data: unknown) => {
        try { iframeRef.current?.contentWindow?.postMessage(data, '*'); } catch { /* 跨域降级 */ }
      },
    };
    browser._registerView(api);
    const pending = browser._consumePendingUrl();
    if (pending) doNavigateRef.current(pending);
    return () => browser._unregisterView(api);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doNavigate(addr);
  };

  const reload = () => {
    try { iframeRef.current?.contentWindow?.location.reload(); } catch { setNonce((n) => n + 1); }
    setNonce((n) => n + 1);
  };

  const openExternal = () => {
    if (!addr) return;
    const { external } = normalizeUrl(addr);
    if (external) window.open(external, '_blank', 'noopener');
  };

  // 地址栏显示的是用户输入的真实地址, 不展示反代; 但 iframe 是反代的
  const iframeProxied = src.includes('/proxy/');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: 'var(--editor-background, #1e1e1e)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          borderBottom: '1px solid var(--panel-border, rgba(255,255,255,0.08))',
          background: 'var(--editorWidget-background, #252526)',
        }}
      >
        <button type="button" title="刷新" style={iconBtn} onClick={reload}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <form onSubmit={onSubmit} style={{ flex: 1, display: 'flex' }}>
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="输入网址, 回车访问 (localhost 服务自动经 /proxy 反代, 同源可调试)"
            style={{
              flex: 1, height: 28, padding: '0 10px', fontSize: 13,
              color: 'var(--editor-foreground, #e5e7eb)',
              background: 'var(--input-background, rgba(255,255,255,0.06))',
              border: '1px solid var(--panel-border, rgba(255,255,255,0.12))',
              borderRadius: 6, outline: 'none', minWidth: 0,
            }}
          />
        </form>
        <button type="button" title="在系统真实浏览器新标签打开" style={iconBtn} onClick={openExternal}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <iframe
          key={nonce}
          ref={iframeRef}
          src={src}
          title="numas-browser"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        />
        {iframeProxied && (
          <div style={{ position: 'absolute', right: 8, bottom: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,0,0,0.55)', color: '#9ae6b4', pointerEvents: 'none' }}>
            反代同源 · 可调试
          </div>
        )}
      </div>
    </div>
  );
};
