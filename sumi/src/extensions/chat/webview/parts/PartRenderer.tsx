import React from 'react';
import { Markdown } from './Markdown';
import { ReasoningView } from './Reasoning';
import { TodoCard } from './TodoCard';
import { QuestionCard, extractQuestions } from './QuestionCard';
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
  onIgnoreQuestion?: (rid: string) => void;
  preferredQuestionRequestID?: string;
  preferredQuestionQuestions?: any[];
  /** 对话是否正忙: 仅 busy 时显示提交按钮等交互 */
  busy?: boolean;
}> = ({ part, streaming, done, sessionID, onReply, onIgnoreQuestion, preferredQuestionRequestID, preferredQuestionQuestions, busy }) => {
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
          // 卡片式交互: 消息流内直接作答 (选项/自定义/提交), 不依赖弹窗
          return (
            <QuestionCard
              part={part}
              sessionID={sessionID}
              onReply={onReply}
              onIgnore={onIgnoreQuestion}
              preferredRequestID={preferredQuestionRequestID}
              busy={busy}
            />
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
