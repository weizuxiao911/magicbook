import React from 'react';
import { getBrand } from '../../scheme';

interface ConnectingViewProps {
  /** 全局 opencode 用户信息 (window.__APP_OPENCODE_RUNTIME__) */
  user?: { userId?: string; tenantId?: string; deployEnv?: string } | null;
}

/** opencode 实例连接中占位 — 无登录逻辑, 用户信息来自全局 runtime */
export const ConnectingView: React.FC<ConnectingViewProps> = ({ user }) => {
  const brand = getBrand();
  return (
    <div className="chat__gate">
      {brand && <div className="chat__gate-logo"><span>{brand.logoChar}</span></div>}
      <h2 className="chat__gate-title">正在连接 {brand?.nameZh || 'AI'} …</h2>
      <ul className="chat__gate-features">
        <li>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>集成丰富上下文，回答更准确</span>
        </li>
        <li>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span>开放智能体生态，满足多样任务需求</span>
        </li>
        <li>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <span>理解需求、调动工具、端到端完成真实任务</span>
        </li>
      </ul>
      {user?.userId && (
        <div className="chat__gate-user">当前用户: {user.userId}{user.deployEnv ? ` · ${user.deployEnv}` : ''}</div>
      )}
    </div>
  );
};
