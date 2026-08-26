/**
 * Welcome 拓展 — extensions/welcome/
 *
 * OpenSumi 拓展 (一个子目录一个拓展):
 *   - module.ts        OpenSumi 扩展注册 (WelcomeModule + WelcomeContribution)
 *   - WelcomeView.tsx  主区欢迎页 (logo / 标语 / 上传文件 / 打开文件)
 *
 * 注册为 editor component (scheme = welcome), 空工作区时自动打开 welcome://home.
 */
export { WelcomeModule, WelcomeContribution } from './module';
