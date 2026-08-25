import React from 'react';

export const WorkspaceView: React.FC = () => {
  return (
    <div className="ws-root">
      <style>{S}</style>
      <div className="ws-body">
        <div className="ws-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div className="ws-title">尚未打开工作目录</div>
        <div className="ws-desc">选择一个目录作为工作空间</div>
        <button className="ws-btn" onClick={() => window.dispatchEvent(new CustomEvent('workspace:show-picker'))}>
          打开工作目录
        </button>
      </div>
    </div>
  );
};

const S = `
.ws-root{display:flex;flex-direction:column;height:100%}
.ws-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;color:var(--sideBar-foreground,var(--foreground,#999))}
.ws-icon{margin-bottom:16px}
.ws-title{font-size:14px;font-weight:600;color:var(--sideBar-foreground,var(--foreground,#ccc));margin-bottom:8px}
.ws-desc{font-size:12px;color:var(--sideBar-foreground,var(--foreground,#777));margin-bottom:20px}
.ws-btn{padding:8px 20px;background:var(--button-background,#6366f1);border:none;border-radius:6px;color:var(--button-foreground,#fff);font-size:13px;font-weight:600;cursor:pointer}
.ws-btn:hover{opacity:0.9}
`;