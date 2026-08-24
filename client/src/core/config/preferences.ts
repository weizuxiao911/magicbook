import type { IAppRendererProps } from '@codeblitzjs/ide-core';

/**
 * 客户端偏好配置 — 传给 CodeBlitz 框架的 defaultPreferences
 *
 * client 是 OpenSumi/CodeBlitz 框架容器,不主动改写这些 key;但项目级默认值
 * (主题 / 自动保存 / startup 行为 / 面包屑) 在这里集中声明,方便后续按需调整。
 */
export const preferences: IAppRendererProps['appConfig']['defaultPreferences'] = {
  'general.theme': 'opensumi-design-dark-theme',
  'workbench.startupEditor': 'none',
  'breadcrumbs.enabled': false,
  // 禁用预览模式 (OpenSumi key): 单击文件直接打开常驻 tab, 不用斜体预览 tab
  'editor.previewMode': false,
  'editor.enablePreviewFromCodeNavigation': false,
  'editor.autoSave': 'afterDelay',
  'editor.autoSaveDelay': 100,
  // 文件树每层缩进量(px): 默认 8 偏小, 加大到 16 让父子层级明显
  'explorer.fileTree.indent': 16,
};
