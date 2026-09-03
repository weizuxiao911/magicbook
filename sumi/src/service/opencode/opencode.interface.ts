/**
 * service/opencode/opencode.interface.ts
 *
 * 对外契约: AI 智能体能力 (sessions / chat / models / providers / skills / agents / commands).
 * DI 入口: useInjectable(AgentToken).
 *
 * 不导出 impl (impl 在 ./opencode.service.ts, DI 容器 new).
 */

export interface AgentSession {
  id: string;
  title?: string;
  directory?: string;
}

export interface AgentMessage {
  id?: string;
  info?: { role?: string; time?: { created?: number } };
  parts?: Array<{ type?: string; text?: string }>;
}

export interface AgentModel {
  id: string;
  providerID: string;
  name: string;
}

export interface AgentRuntime {
  /** 当前工作空间 (workspace) 路径 */
  workspace: string;
  defaultShell: string;
  healthy: boolean;
}

export interface IOpencodeService {
  /** opencode SDK client (懒建, 返回 null 表示未就绪) */
  getClient(): any;
  /** SDK client 是否就绪 (实例已创建) */
  isReady(): boolean;
  /** 等待 SDK 就绪 */
  waitForReady(timeoutMs?: number): Promise<void>;
  /** runtime 元信息 (workspace / defaultShell / healthy), 未初始化返回 null */
  getRuntime(): AgentRuntime | null;
  /** 创建新会话, 返回 session id */
  createSession(title?: string): Promise<string>;
  /** 当前 cwd 下的会话列表 */
  listSessions(): Promise<AgentSession[]>;
  /** 会话消息列表 */
  listMessages(sessionID: string): Promise<AgentMessage[]>;
  /** 发送消息 (string 或 parts[]) */
  sendMessage(
    sessionID: string,
    textOrParts: string | unknown[],
    agent?: string,
    model?: unknown,
    variant?: string,
  ): Promise<void>;
  /** 中断当前生成 */
  abort(sessionID: string): Promise<void>;
  /** 删除会话 */
  deleteSession(sessionID: string): Promise<void>;
  /** 当前 cwd 下可用智能体 */
  listAgents(): Promise<unknown[]>;
  /** 当前 cwd 下可用模型 (provider 已连接的 active) */
  listModels(): Promise<AgentModel[]>;
}

/** DI Token. useInjectable(AgentToken) 拿单例. */
export const AgentToken: symbol = Symbol('IOpencodeService');