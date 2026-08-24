/**
 * core/commands 汇总 — 全局协议/接口/Token 定义层
 *
 * 所有 service 实现的契约都在此定义:
 *   IAgent / IRegistry / ISandbox / IFileSystem / IEnvService / IAuth
 *
 * 约定:
 *   - 接口 + Token 全局定义（内核）, service 层 implements 实现
 *   - 使用方 useInjectable(Token) 注入, 不直接 import service 实现
 */

export * from './agent';
export * from './registry';
export * from './sandbox';
export * from './fs';
export * from './env';
export * from './auth';