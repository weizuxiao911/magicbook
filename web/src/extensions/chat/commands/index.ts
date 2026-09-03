/**
 * Chat 拓展命令入口 — extensions/chat/commands/index.ts
 *
 * chat 的 AI 会话/消息能力全部通过全局 opencode 实例直接调用 (见 ./api),
 * 不再注册任何全局命令 (chat.ai.*) — 避免拓展封装过多全局指令.
 * 如需跨拓展/vsix webview 桥接, 由 core/commands 统一注册, 不在 chat 内自建.
 */
export {};
