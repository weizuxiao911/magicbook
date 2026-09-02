/**
 * Chat 拓展 — extensions/chat/
 *
 * OpenSumi 拓展 (一个子目录一个拓展):
 *   - module.ts       OpenSumi 扩展注册 (ChatModule + ChatContribution)
 *   - webview/        聊天交互界面 (React: Chat + parts)
 *
 * 数据/命令: commands/ (OpenCode SDK 封装 + 会话/消息 commands)
 */
export { ChatModule, ChatContribution } from './module';