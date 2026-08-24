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

import { buildSlots } from './core/config/slots';
import { getBuiltinModules } from './core/config/modules';
import { preferences } from './core/config/preferences';
import { runtimeConfig } from './core/config/runtime';
import { getRegistryService } from './service/registry';
import type { ExtensionMetadata } from './core/commands/registry';
import './core/styles/overrides.css';
import './core/styles/slots.css';

export const App: React.FC = () => {
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