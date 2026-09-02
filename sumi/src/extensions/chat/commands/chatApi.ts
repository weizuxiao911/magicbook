/**
 * Chat 面板对外 API — extensions/chat/commands/chatApi
 *
 * chat 激活后由 Chat 组件把「面板自身交互能力」注册到此处, 供 commands 桥接,
 * 供其他拓展 / vsix 通过 executeCommand('chat.xxx') 调用.
 *
 * 不挂 window 全局对象: 走 opensumi 容器 (CommandContribution) 注册命令,
 * 跨拓展/动态拓展通过 VSCode 标准的 executeCommand 使用.
 */

export interface ChatPanelApi {
  /** 新建会话 */
  newSession(): void | Promise<void>;
  /** 显示历史会话弹窗 */
  sessions(): void;
  /** 发送指令 */
  send(text: string): void | Promise<void>;
  /** 切换会话 */
  changeSession(sid: string): void;
}

let registered: ChatPanelApi | null = null;

/** 由 Chat 组件在挂载时注册 (一次), 卸载时可传 null 注销 */
export function registerChatPanelApi(api: ChatPanelApi | null): void {
  registered = api;
}

export function getChatPanelApi(): ChatPanelApi | null {
  return registered;
}
