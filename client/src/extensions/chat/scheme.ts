/**
 * chat 全局配置读取 — extensions/chat/scheme.ts
 *
 * 只读取全局配置 (window.__APP_CONFIG__.chatConfig, 由 webapp 容器在启动期注入),
 * 不直接依赖 @/config/brand, 拓展保持自包含.
 *
 * chatConfig 结构: { brand: 品牌文案, suggestions: 欢迎页建议卡片 }
 * 没有全局配置时返回 null, UI 留空处理 (不兜底默认品牌).
 */

export interface ChatBrand {
  name: string;
  nameZh: string;
  tagline: string;
  greeting: string;
  logoChar: string;
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
  if (typeof window === 'undefined') return null;
  const g = (window as any).__APP_CONFIG__?.chatConfig as ChatConfig | undefined;
  return g || null;
}

export function getBrand(): ChatBrand | null {
  return getChatConfig()?.brand || null;
}

export function getSuggestions(): ChatSuggestion[] {
  return getChatConfig()?.suggestions || [];
}

export function formatBrand(template: string, brand?: ChatBrand | null): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, k) => (brand as any)?.[k] ?? `{${k}}`);
}
