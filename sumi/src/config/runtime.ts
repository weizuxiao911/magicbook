/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 自定义 FileSystemProvider 接管 'file' scheme 后, 不再需要 BrowserFS mount.
 * 故此处不配置 workspace.filesystem — codeblitz fs-launch.contribution 在配置缺失时跳过 mount
 * (fs-launch.contribution.js:36-37 `if (!fsConfig) return;`).
 *
 * 文件系统实现见 ./fs.ts (CustomFileSystemProvider + DI 注入 CustomFsProviderContribution).
 * 不依赖任何 codeblitz ide-browserfs 模块, 不维护 InMemory 缓存 / 墓碑 / overlay.
 *
 * WelcomePage (用户拍板, 2026-09): 欢迎页显示/打开规则走 codeblitz 官方机制
 * (官方 WelcomeContribution.onDidRestoreState: 无打开资源才 openWelcome),
 * 自建 welcome 扩展 (extensions/welcome/module.ts) 已删, 本处经官方扩展点
 * runtimeConfig.WelcomePage 注入 numas 欢迎 UI 替换官方默认组件.
 */

import type { IAppRendererProps } from '@codeblitzjs/ide-core';
import { WelcomeView } from '../extensions/welcome/WelcomeView';

export const runtimeConfig: IAppRendererProps['runtimeConfig'] = {
  WelcomePage: WelcomeView as any,
} as any;