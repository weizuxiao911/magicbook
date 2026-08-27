/**
 * 常量 + helpers — extensions/chat/webview/helpers.ts
 * UI 不变, 仅搬迁位置 (类型/常量/纯函数, 无 hooks).
 */

import { extractAssistantTodos } from './parts/TodoCard';

/** 字节 → base64（浏览器端, 分块避免栈溢出） */
export function bytesToBase64(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export interface Row {
  id: string;
  role: 'user' | 'assistant';
  parts: any[];
  error?: any;
  /** 消息时间戳 (created/completed), 用于 meta 展示耗时 */
  time?: { created?: number; completed?: number };
}

export const HIDDEN_AGENTS = new Set(['compaction', 'title', 'summary']);

export const AGENT_ICONS: Record<string, string> = {
  build: '🔨',
  plan: '🗺',
  general: '✨',
  explore: '🔭',
};

export const AGENT_DESC: Record<string, string> = {
  build: '执行任务 · 文件操作 · 命令执行',
  plan: '规划方案 · 任务拆解 (只读工具)',
  general: '通用问答 · 多步任务并行执行',
  explore: '信息检索 · 上下文探索',
};

export const CLIENT_COMMANDS: Array<{ cmd: string; desc: string; hint?: string }> = [
  { cmd: 'models',    desc: '选择模型', hint: '打开模型选择' },
  { cmd: 'connect',   desc: '选择服务商', hint: '搜索服务商 · 输入 API Key 连接' },
  { cmd: 'compact',   desc: '压缩上下文', hint: 'AI summary, 释放 tokens' },
  { cmd: 'new',       desc: '创建新会话', hint: '新建一个空白会话' },
  { cmd: 'sessions',  desc: '历史会话', hint: '打开历史会话列表' },
  { cmd: 'skills',    desc: '选择技能', hint: '打开技能选择弹层' },
  { cmd: 'agents',    desc: '选择角色', hint: '切换 agent 角色' },
];

export function findCurrentTodos(parts: any[]): Array<{ content: string; status: string; priority?: string }> {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.type === 'tool' && String(p.tool || '').toLowerCase() === 'todowrite') {
      const todos = extractAssistantTodos(p?.state?.output)
        .concat(extractAssistantTodos(p?.state?.input));
      if (todos.length) return todos;
    }
  }
  return [];
}

export function extractText(parts: any[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p: any) => p?.type === 'text' && !p?.synthetic && !p?.ignored)
    .map((p: any) => p.text || '')
    .join('');
}

export function formatDuration(start?: number, end?: number): string {
  if (!start || !end) return '';
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 100) / 10;
  return `${sec}秒`;
}

const questionStore = new Map<string, { requestID: string; questions: any[] }>();
const questionSubscribers = new Set<() => void>();
const QUESTION_STORAGE = 'chat.question.v1';

// 从 sessionStorage 恢复 (question.asked 事件是实时的, 重载后会丢, 需要持久化 que_xxx)
function hydrateQuestionStore(): void {
  try {
    const raw = sessionStorage.getItem(QUESTION_STORAGE);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, { requestID: string; questions: any[] }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v?.requestID) questionStore.set(k, v);
    }
  } catch { /* ignore */ }
}
hydrateQuestionStore();

export function notifyQuestionChange() { questionSubscribers.forEach((fn) => fn()); }

/** 记录某会话的待答问题 (que_xxx), 持久化到 sessionStorage 供重载后继续作答 */
export function setQuestion(sessionID: string, data: { requestID: string; questions: any[] }): void {
  questionStore.set(sessionID, data);
  try {
    sessionStorage.setItem(QUESTION_STORAGE, JSON.stringify(Object.fromEntries(questionStore)));
  } catch { /* ignore */ }
  notifyQuestionChange();
}

export function getQuestionStore(): Map<string, { requestID: string; questions: any[] }> {
  return questionStore;
}

/** 清除某会话的待答问题 (回答/忽略后调用, 避免切回重复弹窗) */
export function clearQuestion(sessionID: string): void {
  questionStore.delete(sessionID);
  try {
    sessionStorage.setItem(QUESTION_STORAGE, JSON.stringify(Object.fromEntries(questionStore)));
  } catch { /* ignore */ }
  notifyQuestionChange();
}

export function subscribeQuestionChange(fn: () => void): () => void {
  questionSubscribers.add(fn);
  return () => { questionSubscribers.delete(fn); };
}