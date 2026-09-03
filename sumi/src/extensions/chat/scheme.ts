/**
 * chat 全局配置读取 — extensions/chat/scheme.ts
 *
 * 品牌/建议文案单一来源: config/brand.ts (直接 import, 编译期可静态追踪).
 * 不依赖 window.__APP_CONFIG__.chatConfig 中间层, 避免绕路.
 *
 * chatConfig 结构: { brand: 品牌文案, suggestions: 欢迎页建议卡片 }
 * 没有全局配置时返回 null, UI 留空处理 (不兜底默认品牌).
 */

import { APP_CHAT_CONFIG } from '@/config/brand';

export interface ChatBrand {
  name: string;
  title: string;
  subtitle: string;
  greeting: string;
  logo: string;
}

export interface ChatSuggestion {
  icon: string;
  title: string;
  desc: string;
  prompt: string;
}

export interface ChatConfig {
  brand: ChatBrand;
  suggestions: ChatSuggestion[];
}

export function getChatConfig(): ChatConfig | null {
  return APP_CHAT_CONFIG as unknown as ChatConfig;
}

export function getBrand(): ChatBrand | null {
  return APP_CHAT_CONFIG.brand as unknown as ChatBrand;
}

export function getSuggestions(): ChatSuggestion[] {
  return APP_CHAT_CONFIG.suggestions as unknown as ChatSuggestion[];
}

export function formatBrand(template: string, brand?: ChatBrand | null): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, k) => (brand as any)?.[k] ?? `{${k}}`);
}
