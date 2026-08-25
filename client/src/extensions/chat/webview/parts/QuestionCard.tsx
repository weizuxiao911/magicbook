import React, { useState, useMemo } from 'react';

export interface QuestionOption {
  label: string;
  description: string;
}
export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;  // 是否允许自定义输入
}

function parseMaybeJson(v: any): any {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

export function extractQuestions(part: any): QuestionInfo[] | null {
  const candidates = [
    part?.state?.output,
    part?.state?.input,
    part?.state?.raw,
    part?.state?.metadata,
  ];
  for (const cand of candidates) {
    const v = parseMaybeJson(cand);
    if (!v) continue;
    const qs = (v as any).questions ?? (Array.isArray(v) ? v : null);
    if (Array.isArray(qs) && qs.length > 0 && qs.every((q: any) => q && typeof q.question === 'string' && Array.isArray(q.options))) {
      return qs.map((q: any) => ({
        question: q.question,
        header: q.header,
        multiple: q.multiple === true || q.type === 'multiple',
        custom: q.custom !== false, // 默认允许自定义输入
        options: q.options.map((o: any) => ({
          label: typeof o === 'string' ? o : (o.label ?? String(o)),
          description: typeof o === 'object' ? (o.description ?? '') : '',
        })),
      }));
    }
  }
  return null;
}

export function extractRequestId(part: any): string {
  return (
    part?.state?.metadata?.requestID ??
    part?.state?.metadata?.requestId ??
    part?.callID ??
    part?.id ??
    ''
  );
}

export const QuestionCard: React.FC<{
  part: any;
  sessionID: string;
  onReply: (sid: string, rid: string, answers: string[][]) => Promise<void>;
  /** 优先使用的 requestID (来自 question.v2.asked 事件的 id, 格式 que_xxx) */
  preferredRequestID?: string;
  /** 对话是否正忙 (AI 生成中): 仅 busy 时显示提交按钮 */
  busy?: boolean;
}> = ({ part, sessionID, onReply, preferredRequestID, busy }) => {
  const questions = useMemo(() => extractQuestions(part), [part]);
  const localRid = useMemo(() => extractRequestId(part), [part]);
  const requestId = preferredRequestID || localRid;
  const status: string = part?.state?.status || 'pending';
  const answered: boolean = status === 'completed' || !!(part?.state?.metadata?.answers);

  // selected: questionIndex → Set<optionLabel>
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  // custom: questionIndex → string
  const [custom, setCustom] = useState<Record<number, string>>({});
  // customActive: questionIndex → boolean (用户是否在自定义输入框里输入了内容)
  const [customActive, setCustomActive] = useState<Record<number, boolean>>({});
  // 多问题 tab: 只记当前激活问题索引（不额外持久化/折叠状态）
  const [activeIdx, setActiveIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  if (!questions) return null;
  // 问题数变化时钳制, 避免越界
  const qi = Math.min(activeIdx, questions.length - 1);
  const q = questions[qi];

  const isCustomOn = (index: number) => !!customActive[index];

  const toggle = (index: number, label: string, multiple: boolean) => {
    if (answered || submitting) return;
    setSelected((prev) => {
      const cur = new Set(prev[index] || []);
      if (multiple) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        // 单选: 切换 — 已选则清空, 否则替换
        if (cur.has(label) && cur.size === 1) cur.clear();
        else { cur.clear(); cur.add(label); }
      }
      return { ...prev, [index]: cur };
    });
  };

  const onCustomChange = (index: number, v: string) => {
    setCustom((prev) => ({ ...prev, [index]: v }));
    setCustomActive((prev) => ({ ...prev, [index]: v.trim().length > 0 }));
  };

  const submit = async () => {
    if (answered || submitting) return;
    setSubmitting(true);
    try {
      const answers = questions.map((item, index) => {
        const sel = Array.from(selected[index] || []);
        // 自定义答案作为独立一项 (不与已选合并)
        if (isCustomOn(index) && custom[index]?.trim()) {
          sel.push(`__custom__:${custom[index].trim()}`);
        }
        return sel;
      });
      await onReply(sessionID, requestId, answers);
    } finally {
      setSubmitting(false);
    }
  };

  const summary = (item: QuestionInfo, index: number) => {
    // 已答: 优先用 part 里的 answers
    const metaAnswers = part?.state?.metadata?.answers;
    if (answered && Array.isArray(metaAnswers) && metaAnswers[index]) {
      const arr = metaAnswers[index];
      return Array.isArray(arr) ? arr.map((a: string) => String(a).replace(/^__custom__:/, '')).join(', ') : String(arr);
    }
    const sel = Array.from(selected[index] || []);
    const c = (custom[index] || '').trim();
    const parts: string[] = [];
    if (sel.length) parts.push(sel.join(', '));
    if (c) parts.push(c);
    return parts.length ? `已回答: ${parts.join('; ')}` : '未回答';
  };

  return (
    <div className={`q${answered ? ' is-done' : ''}`}>
      <div className="q__head">
        <span className="q__badge">?</span>
        <span className="q__head-title">
          问题 {questions.length > 1 ? `${qi + 1}/${questions.length}` : ''}{answered ? ' 已回答' : ' 待回答'}
        </span>
        {questions.length > 1 && (
          <div className="q__tabs">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`q__tab${i === qi ? ' is-active' : ''}`}
                onClick={() => setActiveIdx(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
      {answered ? (
        <div className="q__summary">{summary(q, qi)}</div>
      ) : (
        <>
          <div className="q__item">
            {q.header && <div className="q__header">{q.header}</div>}
            <div className="q__q">{q.question}</div>
            <div className="q__opts">
              {q.options.map((opt, oi) => {
                const active = (selected[qi] || new Set()).has(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    className={`q__opt${active ? ' is-active' : ''}`}
                    onClick={() => toggle(qi, opt.label, !!q.multiple)}
                    disabled={answered || submitting}
                  >
                    <span className="q__opt-mark">{q.multiple ? (active ? '☑' : '☐') : (active ? '◉' : '○')}</span>
                    <span className="q__opt-body">
                      <span className="q__opt-label">{opt.label}</span>
                      {opt.description && <span className="q__opt-desc">{opt.description}</span>}
                    </span>
                  </button>
                );
              })}
              {q.custom !== false && (
                <div className={`q__opt q__custom-opt${isCustomOn(qi) ? ' is-active' : ''}`}>
                  <span className="q__opt-mark">{q.multiple ? (isCustomOn(qi) ? '☑' : '☐') : (isCustomOn(qi) ? '◉' : '○')}</span>
                  <span className="q__opt-body">
                    <span className="q__opt-label" onClick={() => { if (!isCustomOn(qi)) { setCustomActive(p => ({ ...p, [qi]: true })); } }}>
                      输入自己的答案
                    </span>
                    <textarea
                      className="q__custom"
                      rows={1}
                      placeholder="输入你的答案..."
                      value={custom[qi] || ''}
                      onFocus={() => setCustomActive(p => ({ ...p, [qi]: true }))}
                      onChange={(e) => onCustomChange(qi, e.target.value)}
                      disabled={answered || submitting}
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
          {busy && (
            <div className="q__foot">
              <button className="q__submit" onClick={submit} disabled={submitting}>
                {submitting ? '提交中...' : '提交'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
