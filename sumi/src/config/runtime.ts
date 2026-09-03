/**
 * 运行时配置 — core/config/runtime.ts
 *
 * 自定义 FileSystemProvider 接管 'file' scheme 后, 不再需要 BrowserFS mount.
 * 故此处不配置 workspace.filesystem — codeblitz fs-launch.contribution 在配置缺失时跳过 mount
 * (fs-launch.contribution.js:36-37 `if (!fsConfig) return;`).
 *
 * 文件系统实现见 ./fs.ts (CustomFileSystemProvider + DI 注入 CustomFsProviderContribution).
 * 不依赖任何 codeblitz ide-browserfs 模块, 不维护 InMemory 缓存 / 墓碑 / overlay.
 */

import type { IAppRendererProps } from '@codeblitzjs/ide-core';

export const runtimeConfig: IAppRendererProps['runtimeConfig'] = {} as any;