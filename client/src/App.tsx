/**
 * App — src/App.tsx
 *
 * 骨架系统: codeblitz AppRenderer 渲染 IDE 容器.
 * 已登录 → 取 cwd → 加载文件系统 + AI; 未登录 → 登录引导（待接入）.
 */

import React from 'react';

import { AppRenderer, getDefaultAppConfig } from '@codeblitzjs/ide-core';
import '@codeblitzjs/ide-core/bundle/codeblitz.css';
import '@codeblitzjs/ide-core/languages';

import { buildSlots } from './core/config/slots';
import { getBuiltinModules } from './core/config/modules';
import { preferences } from './core/config/preferences';
import { runtimeConfig } from './core/config/runtime';
import './core/styles/overrides.css';
import './core/styles/slots.css';

export const App: React.FC = () => {
  const defaultModules = getDefaultAppConfig().modules || [];

  return (
    <AppRenderer
      appConfig={{
        workspaceDir: '/',
        ...buildSlots(),
        defaultPreferences: preferences,
        extensionMetadata: (window as any).__APP_REGISTRY_METADATA__ || [],
        modules: [
          ...defaultModules,
          ...getBuiltinModules(),
        ],
      }}
      runtimeConfig={runtimeConfig as any}
    />
  );
};