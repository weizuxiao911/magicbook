/**
 * App — src/App.tsx
 *
 * 骨架系统: codeblitz AppRenderer 渲染 IDE 容器.
 * 渲染前拉取 registry 拓展元数据（编译期配置, 无登录依赖; codeblitz ext host 加载 vsix 用）.
 */

import React, { useEffect, useState } from 'react';

import { AppRenderer, getDefaultAppConfig } from '@codeblitzjs/ide-core';
import '@codeblitzjs/ide-core/bundle/codeblitz.css';
import '@codeblitzjs/ide-core/languages';

import { buildSlots } from './config/slots';
import { getBuiltinModules } from './config/modules';
import { preferences } from './config/preferences';
import { runtimeConfig } from './config/runtime';
import { getRegistryService } from './service/registry';
import type { ExtensionMetadata } from './commands/registry';
import './styles/overrides.css';
import './styles/slots.css';

/** 渲染前暂存上次打开的编辑器 uris（容器初始化恢复失败会清空 storage, 登录后按暂存恢复） */
function stashSavedEditorUris(): void {
  try {
    // 清 opensumi 保存的 layout 宽度（否则旧 size 覆盖 defaultSize; 让 defaultSize 240/396 生效）
    localStorage.removeItem('layout');
    localStorage.removeItem('global:/layout-global');
    localStorage.removeItem('scoped:/workspace/:/layout');
  } catch { /* ignore */ }
  try {
    // 自建持久化 key（watchEditorState 维护）; 兜底旧 opensumi workbench storage
    const raw = localStorage.getItem('editor.restore.uris');
    const activeUri = localStorage.getItem('editor.restore.activeUri');
    if (activeUri) (window as any).__SAVED_EDITOR_ACTIVE_URI__ = activeUri;
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr) && arr.length) { (window as any).__SAVED_EDITOR_URIS__ = arr; return; }
    }
    const legacy = localStorage.getItem('scoped:/workspace/:/workbench');
    if (!legacy) return;
    const state = JSON.parse(legacy) as { grid?: string };
    const grid = JSON.parse(state.grid || '{}') as { editorGroup?: { uris?: string[] } };
    const uris = grid?.editorGroup?.uris || [];
    if (uris.length) (window as any).__SAVED_EDITOR_URIS__ = uris;
  } catch { /* ignore */ }
}

export const App: React.FC = () => {
  stashSavedEditorUris();
  const defaultModules = getDefaultAppConfig().modules || [];
  const [extensionMetadata, setExtensionMetadata] = useState<ExtensionMetadata[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getRegistryService()
      .installMetadata()
      .then(setExtensionMetadata)
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <AppRenderer
      appConfig={{
        workspaceDir: '/',
        ...buildSlots(),
        defaultPreferences: preferences,
extensionMetadata: extensionMetadata as any,
        modules: [
          ...defaultModules,
          ...getBuiltinModules(),
        ],
      }}
      runtimeConfig={runtimeConfig as any}
    />
  );
};