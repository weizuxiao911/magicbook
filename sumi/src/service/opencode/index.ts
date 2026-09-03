/**
 * service/opencode/index.ts — 公共 API barrel
 *
 * 对外导出: 接口契约 + DI token + DI module (impl 内部, 不导出).
 * 消费方: import { IOpencodeService, AgentToken, AgentModule } from '@/service/opencode';
 *
 * impl 在 ./opencode.service.ts, 通过 DI 容器单例化, 不直接 import.
 */

export type {
  AgentSession,
  AgentMessage,
  AgentModel,
  AgentRuntime,
  IOpencodeService,
} from './opencode.interface';

export { AgentToken } from './opencode.interface';
export { AgentModule } from './opencode.service';