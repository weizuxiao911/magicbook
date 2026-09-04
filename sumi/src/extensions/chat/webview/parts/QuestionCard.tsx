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
  custom?: boolean;
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
        custom: q.custom !== false,
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
  /** 底部「取消」: abort 整个对话 (提问随之取消).
   *  仅当此卡片是当前正在进行的提问 (最后一条消息) 且会话 busy 时显示. */
  onAbort?: (sid: string) => void;
  /** 会话 busy 且本消息为最后一条进行中消息 (Chat 层由 busy && role assistant && id===最后一条 计算) */
  streaming?: boolean;
  preferredRequestID?: string;
  busy?: boolean;
}> = ({ part, sessionID, onReply, onAbort, streaming, preferredRequestID, busy }) => {
  const questions = useMemo(() => extractQuestions(part), [part]);
  const localRid = useMemo(() => extractRequestId(part), [part]);
  const requestId = preferredRequestID || localRid;
  const status: string = part?.state?.status || 'pending';
  const answered: boolean = status === 'completed' || !!(part?.state?.metadata?.answers);
  const active = busy && !answered;

  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [customActive, setCustomActive] = useState<Record<number, boolean>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(true);

  if (!questions) return null;
  const qi = Math.min(activeIdx, questions.length - 1);
  const q = questions[qi];

  const isCustomOn = (index: number) => !!customActive[index];

  const toggle = (index: number, label: string, multiple: boolean) => {
    if (!active || submitting) return;
    setSelected((prev) => {
      const cur = new Set(prev[index] || []);
      if (multiple) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
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
    if (!active || submitting) return;
    setSubmitting(true);
    try {
      const answers = questions.map((item, index) => {
        const sel = Array.from(selected[index] || []);
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
      <button type="button" className="q__head" onClick={() => setOpen((v) => !v)}>
        <span className="q__badge">?</span>
        <span className="q__head-title">
          问题 {questions.length > 1 ? `${qi + 1}/${questions.length}` : ''}{answered ? ' 已回答' : ' 待回答'}
        </span>
        {questions.length > 1 && (
          <div className="q__tabs" onClick={(e) => e.stopPropagation()}>
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
        <span className="q__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (answered ? (
        <div className="q__summary">{summary(q, qi)}</div>
      ) : (
        <>
          <div className="q__item">
            {q.header && <div className="q__header">{q.header}</div>}
            <div className="q__q">{q.question}</div>
            <div className="q__opts">
              {q.options.map((opt, oi) => {
                const activeOpt = (selected[qi] || new Set()).has(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    className={`q__opt${activeOpt ? ' is-active' : ''}`}
                    onClick={() => toggle(qi, opt.label, !!q.multiple)}
                    disabled={!active || submitting}
                  >
                    <span className="q__opt-mark">{q.multiple ? (activeOpt ? '☑' : '☐') : (activeOpt ? '◉' : '○')}</span>
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
                    <span className="q__opt-label" onClick={() => { if (active && !isCustomOn(qi)) { setCustomActive(p => ({ ...p, [qi]: true })); } }}>
                      输入自己的答案
                    </span>
                    <textarea
                      className="q__custom"
                      rows={1}
                      placeholder="输入你的答案..."
                      value={custom[qi] || ''}
                      onFocus={() => { if (active) setCustomActive(p => ({ ...p, [qi]: true })); }}
                      onChange={(e) => onCustomChange(qi, e.target.value)}
                      disabled={!active || submitting}
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
          {questions.length > 1 ? (
            <div className="q__foot">
              <div className="q__foot-start">
                {qi === 0 ? (
                  streaming && (
                    <button className="q__nav q__cancel" onClick={() => onAbort?.(sessionID)} disabled={submitting}>
                      取消
                    </button>
                  )
                ) : (
                  <button className="q__nav" onClick={() => setActiveIdx(qi - 1)}>
                    上一个
                  </button>
                )}
              </div>
              <div className="q__foot-end">
                {qi < questions.length - 1 ? (
                  <button className="q__nav" onClick={() => setActiveIdx(qi + 1)}>
                    下一个
                  </button>
                ) : busy && (
                  <button className="q__submit" onClick={submit} disabled={submitting}>
                    {submitting ? '提交中...' : '提交'}
                  </button>
                )}
              </div>
            </div>
          ) : busy && (
            <div className="q__foot">
              <div className="q__foot-start">
                {streaming && (
                  <button className="q__nav q__cancel" onClick={() => onAbort?.(sessionID)} disabled={submitting}>
                    取消
                  </button>
                )}
              </div>
              <div className="q__foot-end">
                <button className="q__submit" onClick={submit} disabled={submitting}>
                  {submitting ? '提交中...' : '提交'}
                </button>
              </div>
            </div>
          )}
        </>
      ))}
    </div>
  );
};