import React from 'react';

/**
 * PermissionModal — 工具权限请求弹层 (AI 调用 bash/webfetch/edit 等工具时询问)
 * 固定在输入框上方, 与 QuestionModal 同风格; 回复: once(允许一次) / always(始终允许) / reject(拒绝)
 */
export const PermissionModal: React.FC<{
  permission: any;
  onReply: (permissionID: string, response: 'once' | 'always' | 'reject') => void;
  onDismiss: () => void;
}> = ({ permission, onReply, onDismiss }) => {
  if (!permission?.id) return null;
  const title = permission.title || permission.type || '权限请求';
  const pattern = Array.isArray(permission.pattern) ? permission.pattern.join('、') : permission.pattern;
  const btn = (label: string, resp: 'once' | 'always' | 'reject', primary?: boolean) => (
    <button
      type="button"
      className={`chat__qmodal-btn${primary ? ' chat__qmodal-btn--primary' : ''}`}
      onClick={() => onReply(permission.id, resp)}
    >
      {label}
    </button>
  );
  return (
    <div className="chat__qmodal">
      <div className="chat__qmodal-head">
        <span className="chat__qmodal-count">权限请求</span>
        <button
          type="button"
          className="chat__qmodal-min"
          onClick={onDismiss}
          title="收起"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
      </div>
      <div className="chat__qmodal-body">
        <div className="chat__qmodal-q">{title}</div>
        {pattern && <div className="chat__qmodal-hint">{pattern}</div>}
      </div>
      <div className="chat__qmodal-foot">
        {btn('允许一次', 'once', true)}
        {btn('始终允许', 'always')}
        {btn('拒绝', 'reject')}
      </div>
    </div>
  );
};
