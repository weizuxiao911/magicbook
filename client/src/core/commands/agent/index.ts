/**
 * IAgent 接口定义 — core/commands/agent
 *
 * 全局协议/接口定义（内核）: AI 智能体能力契约.
 * 实现: service/agent（implements IAgent, 对接 server /opencode/*）.
 *
 * 使用方通过 useInjectable(AgentToken) 注入, 不直接 import 实现.
 */

/** AI 会话信息 */
export interface AgentSession {
  id: string;
  title?: string;
  directory?: string;
}

/** AI 消息 */
export interface AgentMessage {
  id?: string;
  info?: { role?: string; time?: { created?: number } };
  parts?: Array<{ type?: string; text?: string }>;
}

/** 模型信息 */
export interface AgentModel {
  id: string;
  providerID: string;
  name: string;
}

/** AI 智能体能力接口 */
export interface IAgent {
  /** SDK 客户端实例（全局单例, 供 chat 等直接使用） */
  getClient(): any;
  /** 是否就绪（实例已创建） */
  isReady(): boolean;
  /** 等待就绪 */
  waitForReady(timeoutMs?: number): Promise<void>;
  /** 创建新会话 */
  createSession(title?: string): Promise<string>;
  /** 会话列表 */
  listSessions(): Promise<AgentSession[]>;
  /** 会话消息 */
  listMessages(sessionID: string): Promise<AgentMessage[]>;
  /** 发送消息 */
  sendMessage(sessionID: string, textOrParts: string | unknown[], agent?: string, model?: unknown, variant?: string): Promise<void>;
  /** 中断 */
  abort(sessionID: string): Promise<void>;
  /** 删除会话 */
  deleteSession(sessionID: string): Promise<void>;
  /** agent 列表 */
  listAgents(): Promise<unknown[]>;
  /** 模型列表 */
  listModels(): Promise<AgentModel[]>;
}

/** Agent Token（全局定义） — service/agent 局部实现 */
export const AgentToken: symbol = Symbol('IAgent');