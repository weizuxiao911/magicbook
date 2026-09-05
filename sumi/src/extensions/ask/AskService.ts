/**
 * Ask 拓展 — 通用 AI 通道 (codeblitz 拓展标准, 跟 filepicker 同构)
 *
 * 核心: `ask(prompt, callback(message))` — 任何拓展可直接调, 无需经 chat panel.
 * 适用场景: PDF 标注的"生成"按钮 / 任何程序侧需要独立会话跟 AI 交互的功能.
 *
 * 链路:
 *   ask 调用 → 创建会话 → 发送提示词 → 订阅[消息总线]按 sessionID 过滤 → 组装结果回调
 *
 * 架构:
 *   - 事件来自客户端消息总线 (service/event/eventBus.ts), 全客户端唯一一条
 *     `/global/event` SSE. ask **不**自建 EventSource (旧版自建 /api/event 缺
 *     workspace 上下文, 非启动目录工作区收不到事件 — 见 docs/提问命令-Ask无头通道设计与测试用例.md).
 *   - 每次 ask 创建一个独立 session (client.session.create) + 异步发 prompt (client.session.promptAsync)
 *   - 流式响应按 sessionId 派发给对应回调, session.idle → 组装完整 text 回调
 *   - 临时会话用完即删 (session.delete), 不污染 chat 会话列表
 *   - 无看门狗: 终态只由 session.idle / session.error / 用户 cancel() 驱动, 不设超时
 *
 * 用法:
 *   import { ask } from '../ask/AskService';
 *   const req = ask('通读 xxx 进行批注', (message) => {
 *     console.log('完整回答:', message);
 *   });
 *   // 取消: req.cancel()
 */

import { onSessionEvent } from '../../service/event/eventBus';
import { effectiveCwd } from '../../infra/url';

export interface AIRequestCallbacks {
  /** 流式增量 (打字机效果), 每次推送新 chunk */
  onDelta?: (chunk: string) => void;
  /** 流结束 (idle) 时推送完整累积 text */
  onComplete?: (text: string) => void;
  /** 错误 (session 创建失败 / session.error / 流异常) */
  onError?: (err: Error) => void;
}

export interface AIRequestHandle {
  /** 内部 sessionId (opencode) */
  sessionId: string;
  /** 取消: abort 后端对话 (client.session.abort) + 停止监听 + 删 session. 返回 Promise. */
  cancel: () => Promise<void>;
}

interface ActiveRequest {
  sessionId: string;
  callbacks: AIRequestCallbacks;
  text: string;
  /** 退订消息总线 */
  unsub: () => void;
  /** 终态守卫 (complete/error/cancel 只走一次) */
  settled: boolean;
}/** 拿全局 opencode SDK 客户端 (跟 service/opencode 共享同一实例). */
function getClient(): any {
  return (window as any).__APP_OPENCODE__;
}

/** best-effort 删除临时会话 (失败静默, 不影响主流程). */
async function deleteSession(sessionId: string): Promise<void> {
  try {
    const c = getClient();
    if (c?.session?.delete) await c.session.delete({ sessionID: sessionId });
  } catch { /* 删除失败忽略 */ }
}

/** AskService 单例: 维护多 active request, 事件来自消息总线. */
class AskService {
  private active = new Map<string, ActiveRequest>();

  /** 主动发请求: 创建 session + 订阅总线 + 异步发 prompt + 注册 callback. */
  async request(prompt: string, callbacks: AIRequestCallbacks = {}, opts: AskOptions = {}): Promise<AIRequestHandle> {
    const client = getClient();
    if (!client) {
      const err = new Error('opencode client not ready (window.__APP_OPENCODE__)');
      callbacks.onError?.(err);
      throw err;
    }

    // 1) 创建 session (走 SDK; 带 location.directory = 当前工作区 — 单一事实源 effectiveCwd(),
    //    跟 chat 一致, 否则 session 无目录上下文, 模型工具调用 (找 PDF 等) 会卡死)
    let sessionId: string;
    try {
      const directory = effectiveCwd() || undefined;
      const { data, error } = await client.session.create(directory ? { location: { directory } } : {});
      if (error) throw error;
      sessionId = data?.id;
      if (!sessionId) throw new Error('session.create: no id in response');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      callbacks.onError?.(err);
      throw err;
    }

    // 2) 订阅消息总线 (按 sessionID 过滤) — 先订阅再发 prompt, 避免漏事件
    const req: ActiveRequest = { sessionId, callbacks, text: '', unsub: () => {}, settled: false };
    req.unsub = onSessionEvent(sessionId, (ev) => this.handleEvent(ev));
    this.active.set(sessionId, req);

    // 3) 异步发 prompt (fire-and-forget, 回复走总线事件流)
    //    images: 走 type:'file' part (dataUrl 图片), 跟 chat 附件一致
    try {
      const parts: any[] = [{ type: 'text', text: prompt }];
      if (opts?.images?.length) {
        for (const img of opts.images) {
          const mime = (img.dataUrl?.split(',')[0].match(/data:([^;]+)/)?.[1]) || 'image/png';
          parts.push({
            type: 'file',
            mime,
            filename: img.name || 'page.png',
            url: img.dataUrl,
          });
        }
      }
      await client.session.promptAsync({
        sessionID: sessionId,
        parts,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.finish(sessionId, () => callbacks.onError?.(err));
      throw err;
    }

    return {
      sessionId,
      cancel: async () => {
        const cur = this.active.get(sessionId);
        if (!cur || cur.settled) return;
        cur.settled = true;
        cur.unsub();
        this.active.delete(sessionId);
        // 终止后端生成 (session.abort) + 删 session
        try {
          const c = getClient();
          if (c?.session?.abort) await c.session.abort({ sessionID: sessionId });
        } catch { /* 终止失败忽略 */ }
        await deleteSession(sessionId);
      },
    };
  }

  /** 总线事件 → 处理流式累积 + 终态 (onSessionEvent 已按 sessionID 过滤). */
  private handleEvent(ev: { type: string; properties: any }): void {
    const { type, properties: props } = ev;
    const sessionId = props?.sessionID as string | undefined;
    if (!sessionId) return;
    const req = this.active.get(sessionId);
    if (!req || req.settled) return;

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
      const finalText = req.text;
      this.finish(sessionId, () => req.callbacks.onComplete?.(finalText));
    } else if (type === 'session.error') {
      const e = props.error;
      const msg = (e && (e.message || e.error)) || (typeof e === 'string' ? e : '') || 'AI 生成出错';
      this.finish(sessionId, () => req.callbacks.onError?.(new Error(msg)));
    }
  }

  /** 终态清理: 退订总线 + 删临时会话 + 回调 (幂等, settled 守卫). */
  private finish(sessionId: string, fn: () => void): void {
    const req = this.active.get(sessionId);
    if (!req || req.settled) return;
    req.settled = true;
    req.unsub();
    this.active.delete(sessionId);
    void deleteSession(sessionId);
    fn();
  }

  /** 卸载 / 重置: 退订所有 active (总线共享, 不在此关闭). */
  dispose() {
    for (const req of this.active.values()) req.unsub();
    this.active.clear();
  }
}

let _instance: AskService | null = null;
function getInstance(): AskService {
  if (!_instance) _instance = new AskService();
  return _instance;
}

export interface AskImage {
  /** 文件名 (显示用) */
  name: string;
  /** dataURL 图片 (e.g. canvas.toDataURL('image/png')) */
  dataUrl: string;
}

export interface AskOptions {
  /** 图片附件 (跟 chat 附件一致, type:'file' part) */
  images?: AskImage[];
  onError?: (err: Error) => void;
}

/** 对外 API: 跟 chat 隔离的 AI 通道. 每次调用创建独立 session, 不污染 chat 历史.
 *  `ask(prompt, callback(message), opts?)` — callback 收完整组装结果; opts.images 带图片附件. */
export function ask(prompt: string, callback: (message: string) => void, opts: AskOptions = {}): Promise<AIRequestHandle> {
  return getInstance().request(prompt, {
    onComplete: callback,
    onError: opts.onError,
  }, opts);
}

/** 兼容旧名 (若其他调用处还引用 requestAI) */
export const requestAI = ask;

export function disposeAskService() {
  _instance?.dispose();
  _instance = null;
}
