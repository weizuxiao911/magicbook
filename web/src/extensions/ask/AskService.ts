/**
 * Ask 拓展 — 通用 AI 通道 (codeblitz 拓展标准, 跟 filepicker 同构)
 *
 * 核心: `ask(prompt, callback(message))` — 任何拓展可直接调, 无需经 chat panel.
 * 适用场景: PDF 标注的"生成"按钮 / 任何程序侧需要独立会话跟 AI 交互的功能.
 *
 * 链路:
 *   ask 调用 → 创建会话 → 发送提示词 → 全局监听按会话过滤 → 组装结果回调
 *
 * 架构:
 *   - 内部维护单 EventSource 订阅 /global/event (opencode 全局 SSE)
 *   - 每次 ask 创建一个独立 session (client.session.create) + 异步发 prompt (client.session.promptAsync)
 *   - 流式响应按 sessionId 派发给对应回调, session.idle → 组装完整 text 回调
 *
 * 用法:
 *   import { ask } from '../ask/AskService';
 *   const req = ask('通读 xxx 进行批注', (message) => {
 *     console.log('完整回答:', message);
 *   });
 *   // 取消: req.cancel()
 */

export interface AIRequestCallbacks {
  /** 流式增量 (打字机效果), 每次推送新 chunk */
  onDelta?: (chunk: string) => void;
  /** 流结束 (idle) 时推送完整累积 text */
  onComplete?: (text: string) => void;
  /** 错误 (session 创建失败 / 流异常) */
  onError?: (err: Error) => void;
}

export interface AIRequestHandle {
  /** 内部 sessionId (opencode) */
  sessionId: string;
  /** 取消订阅 (不影响 chat / opencode 后端, 仅不接收后续事件) */
  cancel: () => void;
}

interface ActiveRequest {
  sessionId: string;
  callbacks: AIRequestCallbacks;
  text: string;
  /** 超时看门狗 timer */
  timer: ReturnType<typeof setTimeout> | null;
}

/** 请求超时看门狗: 超过该时长未收到 idle → 判定失败 (后端可能卡死/模型无响应), 走 onError + 清理. */
const REQUEST_TIMEOUT_MS = 90_000;

const RUNTIME_KEY = '__APP_OPENCODE_RUNTIME__';

function getBaseUrl(): string {
  const base = (window as any)[RUNTIME_KEY]?.baseUrl;
  if (!base) throw new Error('opencode baseUrl missing (window.__APP_OPENCODE_RUNTIME__.baseUrl)');
  return base;
}

/** 拿全局 opencode SDK 客户端 (跟 service/agent.ts 共享同一实例). */
function getClient(): any {
  return (window as any).__APP_OPENCODE__;
}

/** AskService 单例: 维护单 EventSource + 多 active request 派发. */
class AskService {
  private es: EventSource | null = null;
  private active = new Map<string, ActiveRequest>();

  /** 启动单 EventSource 订阅 (惰性, 首次 request 时启动) */
  private ensureStream() {
    if (this.es) return;
    const base = getBaseUrl();
    const es = new EventSource(`${base}/global/event`);
    this.es = es;
    es.onmessage = (msg) => {
      try {
        const raw = JSON.parse(msg.data);
        const ev = (raw && raw.payload) || raw;
        const type = ev?.type as string | undefined;
        const props = ev?.properties || ev?.data;
        if (!type || !props) return;
        const ssid = props.sessionID as string | undefined;
        if (!ssid) return;
        const req = this.active.get(ssid);
        if (!req) return;
        if (type === 'message.part.delta' && props.field === 'text' && typeof props.delta === 'string') {
          req.text += props.delta;
          req.callbacks.onDelta?.(props.delta);
        } else if (type === 'message.part.updated' && props.part?.text != null) {
          // 全量 upsert: 用最新 text 覆盖 (避免 delta + updated 双计数)
          const part = props.part;
          if (part.type === 'text' || typeof part.text === 'string') {
            req.text = part.text;
            req.callbacks.onDelta?.('');
          }
        } else if (type === 'session.idle' || (type === 'session.status' && props.status?.type === 'idle')) {
          // 流结束: 清理 timer, 派发 onComplete, 移除 active
          if (req.timer) clearTimeout(req.timer);
          const finalText = req.text;
          this.active.delete(ssid);
          req.callbacks.onComplete?.(finalText);
        }
      } catch { /* ignore bad frame */ }
    };
    es.onerror = () => { /* EventSource 自动重连, 不需手动处理 */ };
  }

  /** 主动发请求: 创建 session + 异步发 prompt + 注册 callback. */
  async request(prompt: string, callbacks: AIRequestCallbacks = {}): Promise<AIRequestHandle> {
    this.ensureStream();
    const client = getClient();
    if (!client) {
      const err = new Error('opencode client not ready (window.__APP_OPENCODE__)');
      callbacks.onError?.(err);
      throw err;
    }

    // 1) 创建 session (走 SDK; 带 location.directory = 工作目录, 跟 chat 一致,
    //    否则 session 无目录上下文, 模型工具调用 (找 PDF 等) 会卡死)
    let sessionId: string;
    try {
      let directory: string | undefined;
      try {
        const { data } = await client.path.get();
        directory = typeof data?.directory === 'string' ? data.directory : undefined;
      } catch { /* 拿不到就用默认 */ }
      const { data, error } = await client.session.create(directory ? { location: { directory } } : {});
      if (error) throw error;
      sessionId = data?.id;
      if (!sessionId) throw new Error('session.create: no id in response');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      callbacks.onError?.(err);
      throw err;
    }

    // 2) 注册 active + 超时看门狗 (90s 无 idle → 判定失败, 防止按钮永久"生成中")
    const timer = setTimeout(() => {
      const req = this.active.get(sessionId);
      if (!req) return;
      this.active.delete(sessionId);
      req.callbacks.onError?.(new Error('AI 生成超时 (90s), 请重试'));
    }, REQUEST_TIMEOUT_MS);
    this.active.set(sessionId, { sessionId, callbacks, text: '', timer });

    // 3) 异步发 prompt (fire-and-forget, 回复走 SSE 事件流)
    try {
      await client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.active.delete(sessionId);
      callbacks.onError?.(err);
      throw err;
    }

    return {
      sessionId,
      cancel: () => { this.active.delete(sessionId); },
    };
  }

  /** 关闭全局 EventSource (卸载 / 重置时) */
  dispose() {
    this.es?.close();
    this.es = null;
    this.active.clear();
  }
}

let _instance: AskService | null = null;
function getInstance(): AskService {
  if (!_instance) _instance = new AskService();
  return _instance;
}

/** 对外 API: 跟 chat 隔离的 AI 通道. 每次调用创建独立 session, 不污染 chat 历史.
 *  `ask(prompt, callback(message))` — callback 收完整组装结果. */
export function ask(prompt: string, callback: (message: string) => void, opts: { onError?: (err: Error) => void } = {}): Promise<AIRequestHandle> {
  return getInstance().request(prompt, {
    onComplete: callback,
    onError: opts.onError,
  });
}

/** 兼容旧名 (若其他调用处还引用 requestAI) */
export const requestAI = ask;

export function disposeAskService() {
  _instance?.dispose();
  _instance = null;
}
