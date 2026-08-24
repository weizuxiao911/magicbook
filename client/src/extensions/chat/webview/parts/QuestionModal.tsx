import React, { useState } from 'react';
import type { QuestionInfo } from './QuestionCard';

interface QuestionModalProps {
  questions: QuestionInfo[];
  requestID: string;
  sessionID: string;
  onReply: (sid: string, rid: string, answers: string[][]) => Promise<void>;
  onCancel: (sid: string) => Promise<void>;
  onDismiss: () => void;
}

/** 多问题 modal — OpenCode 风格: 固定在输入框上方, 支持问题 tab / 单选 / 多选 / 自定义输入 */
export const QuestionModal: React.FC<QuestionModalProps> = ({
  questions, requestID, sessionID, onReply, onCancel, onDismiss,
}) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [customActive, setCustomActive] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const q = questions[activeIdx];
  if (!q) return null;

  const buildAnswers = () => questions.map((_, qi) => {
    const sel = Array.from(selected[qi] || []);
    if (customActive[qi] && custom[qi]?.trim()) {
      sel.push(`__custom__:${custom[qi].trim()}`);
    }
    return sel;
  });

  const isCustomOn = (qi: number) => !!customActive[qi];

  const toggle = (qi: number, label: string, multiple: boolean) => {
    setSelected((prev) => {
      const cur = new Set(prev[qi] || []);
      if (multiple) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        if (cur.has(label) && cur.size === 1) cur.clear();
        else { cur.clear(); cur.add(label); }
      }
      return { ...prev, [qi]: cur };
    });
  };

  const onCustomChange = (qi: number, v: string) => {
    setCustom((prev) => ({ ...prev, [qi]: v }));
    setCustomActive((prev) => ({ ...prev, [qi]: v.trim().length > 0 }));
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onReply(sessionID, requestID, buildAnswers());
      onDismiss();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="chat__qmodal">
      <div className="chat__qmodal-head">
        <span className="chat__qmodal-count">{activeIdx + 1}/{questions.length} 个问题</span>
        <div className="chat__qmodal-tabs">
          {questions.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`chat__qmodal-tab${i === activeIdx ? ' is-active' : ''}`}
              onClick={() => setActiveIdx(i)}
            >
              问题 {i + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chat__qmodal-min"
          onClick={onDismiss}
          title="最小化问题"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
      </div>

      <div className="chat__qmodal-body">
        <div className="chat__qmodal-q">{q.question}</div>
        <div className="chat__qmodal-hint">选择一个答案</div>
        <div className="chat__qmodal-opts">
          {q.options.map((opt, oi) => {
            const active = (selected[activeIdx] || new Set()).has(opt.label);
            return (
              <button
                key={oi}
                type="button"
                className={`chat__qmodal-opt${active ? ' is-active' : ''}`}
                onClick={() => toggle(activeIdx, opt.label, !!q.multiple)}
                disabled={submitting}
              >
                <span className="chat__qmodal-radio">
                  <span className="chat__qmodal-radio-dot" />
                </span>
                <span className="chat__qmodal-opt-main">
                  <span className="chat__qmodal-opt-label">{opt.label}</span>
                  {opt.description && <span className="chat__qmodal-opt-desc">{opt.description}</span>}
                </span>
              </button>
            );
          })}

          {q.custom !== false && (
            <div className={`chat__qmodal-opt is-custom${isCustomOn(activeIdx) ? ' is-active' : ''}`}>
              <span className="chat__qmodal-radio">
                <span className="chat__qmodal-radio-dot" />
              </span>
              <span className="chat__qmodal-opt-main">
                <span className="chat__qmodal-opt-label">输入自己的答案</span>
                <textarea
                  rows={1}
                  placeholder="输入你的答案..."
                  value={custom[activeIdx] || ''}
                  onFocus={() => setCustomActive((p) => ({ ...p, [activeIdx]: true }))}
                  onChange={(e) => onCustomChange(activeIdx, e.target.value)}
                  disabled={submitting}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = el.scrollHeight + 'px';
                  }}
                />
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="chat__qmodal-foot">
        <button
          type="button"
          className="chat__qmodal-btn"
          onClick={() => { void onCancel(requestID); onDismiss(); }}
          disabled={submitting}
        >
          取消
        </button>
        {activeIdx < questions.length - 1 ? (
          <button
            type="button"
            className="chat__qmodal-btn chat__qmodal-btn--primary"
            onClick={() => setActiveIdx((i) => i + 1)}
            disabled={submitting}
          >
            下一步
          </button>
        ) : (
          <button
            type="button"
            className="chat__qmodal-btn chat__qmodal-btn--primary"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? '提交中...' : '确认'}
          </button>
        )}
      </div>
    </div>
  );
};
