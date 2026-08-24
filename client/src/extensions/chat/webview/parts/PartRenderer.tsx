import React, { useState, useEffect } from 'react';
import { Markdown } from './Markdown';
import { ReasoningView } from './Reasoning';
import { TodoCard } from './TodoCard';
import { extractQuestions } from './QuestionCard';
import { SubAgentCard } from './SubAgentCard';
import { ToolView } from './ToolView';

export type ToolKind = 'question' | 'subagent' | 'todowrite' | 'default';

export function getToolKind(tool: string): ToolKind {
  if (!tool) return 'default';
  const n = tool.toLowerCase();
  if (n === 'question' || n.includes('question')) return 'question';
  if (n === 'todowrite' || n === 'todo_write') return 'todowrite';
  if (n === 'task' || n === 'subagent' || n === 'subagent_task' || n.includes('subagent')) return 'subagent';
  return 'default';
}

export const PartRenderer: React.FC<{
  part: any;
  streaming?: boolean;
  /** 对话是否已结束 (busy=false): 结束后卡片自动折叠 */
  done?: boolean;
  sessionID: string;
  onReply: (sid: string, rid: string, answers: string[][]) => Promise<void>;
  preferredQuestionRequestID?: string;
  preferredQuestionQuestions?: any[];
}> = ({ part, streaming, done, sessionID, onReply, preferredQuestionRequestID, preferredQuestionQuestions }) => {
  if (!part || part.synthetic || part.ignored) return null;

  switch (part.type) {
    case 'text': {
      const text = String(part.text || '');
      if (!text) return null;
      return <Markdown content={text} streaming={streaming} expand={streaming} />;
    }
    case 'reasoning':
      return <ReasoningView part={part} streaming={streaming} done={done} />;
    case 'file': {
      // 图片/文件附件: 粘贴或上传后由服务端回传的 file part
      const mime = String(part.mime || '');
      const url = String(part.url || '');
      if (!url) return null;
      if (mime.startsWith('image/')) {
        return (
          <div className="chat__part-file chat__part-file--image">
            <img src={url} alt={part.filename || 'image'} />
          </div>
        );
      }
      return (
        <div className="chat__part-file">
          <a href={url} target="_blank" rel="noreferrer" download={part.filename}>
            <span className="chat__part-file-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            <span className="chat__part-file-name">{part.filename || url}</span>
          </a>
        </div>
      );
    }
    case 'tool': {
      const kind = getToolKind(String(part.tool || ''));
      switch (kind) {
        case 'question': {
          // 消息流内显示问题记录 (紧凑, 可折叠); 实际作答走 QuestionModal
          const qs = extractQuestions(part);
          const meta = part?.state?.metadata;
          const answered = part?.state?.status === 'completed' || !!meta?.answers;
          const answers: any[] = Array.isArray(meta?.answers) ? meta.answers : [];
          if (!qs || qs.length === 0) return null;
          return (
            <QRecord qs={qs} answered={answered} answers={answers} done={done} />
          );
        }
        case 'todowrite':
          return <TodoCard part={part} done={done} />;
        case 'subagent':
          return <SubAgentCard part={part} />;
        default:
          return <ToolView part={part} done={done} />;
      }
    }
    case 'step-start':
    case 'step-finish':
    case 'snapshot':
    case 'patch':
    case 'agent':
    case 'retry':
    case 'compaction':
      return null;
    default:
      return null;
  }
};

/** 问题记录卡 (消息流内, 可折叠) — 展示问题与回答, 实际作答走 QuestionModal */
const QRecord: React.FC<{
  qs: Array<{ question: string; header?: string; options?: any[] }>;
  answered: boolean;
  answers: any[];
  done?: boolean;
}> = ({ qs, answered, answers, done }) => {
  const [open, setOpen] = useState(true);
  // 对话完成后自动折叠
  useEffect(() => { if (done) setOpen(false); }, [done]);
  return (
    <div className={`q is-done${open ? ' is-open' : ''}${answered ? ' is-answered' : ''}`}>
      <button type="button" className="q__head" onClick={() => setOpen((v) => !v)}>
        <span className="q__badge">?</span>
        <span className="q__head-title">
          问题 {qs.length}{answered ? ' 已回答' : ' 待回答'}
        </span>
        <span className="q__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && qs.map((q, qi) => (
        <div className="q__summary" key={qi}>
          <div className="q__q">{q.question}</div>
          {answered && answers[qi] && (
            <div className="q__opt-desc">
              回答：{Array.isArray(answers[qi])
                ? answers[qi].map((a: string) => String(a).replace(/^__custom__:/, '')).join('、')
                : String(answers[qi])}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
