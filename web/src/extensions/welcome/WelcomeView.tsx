import React, { useMemo, useRef } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser/lib/react-hooks/injectable-hooks';
import { CommandService } from '@opensumi/ide-core-common';

import { FsToken, type IFileSystem } from '@/commands/fs';
import { EnvToken, type IEnvService } from '@/commands/env';

/**
 * WelcomeView — webapp 主区欢迎页
 *
 * 注册为 editor component (scheme = 'welcome'), 资源 URI = welcome://home.
 * 工作区无打开文件时由 WelcomeContribution.onDidRestoreState 自动打开.
 *
 * 内容:
 *   - logo (品牌 logoChar) + 品牌名 + 标语 (从全局配置 __APP_CONFIG__.chatConfig.brand 读取)
 *   - 快捷操作: 上传文件到工作区
 */
export const WelcomeView: React.FC<{ resource?: any }> = () => {
  const commandService = useInjectable<CommandService>(CommandService);
  const fs = useInjectable<IFileSystem>(FsToken);
  const env = useInjectable<IEnvService>(EnvToken);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 品牌/logo 从全局配置 (__APP_CONFIG__.chatConfig.brand) 读取, 不硬编码
  const brand = useMemo(() => {
    const cfg = (window as any).__APP_CONFIG__;
    return cfg?.chatConfig?.brand || { name: 'AI 工作台', logoChar: '', tagline: '' };
  }, []);

  const workspaceDir = env?.getCwdSync?.() || '';

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    if (!fs?.write) {
      alert('沙箱文件系统未就绪');
      return;
    }
    const results: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const text = await f.text();
        const safe = f.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
        const idePath = `/${safe}`;
        await fs.write(idePath, text);
        results.push(safe);
      } catch (err) {
        console.error('[welcome] upload failed:', f.name, err);
      }
    }
    // 刷新 explorer
    try { commandService.tryExecuteCommand('file-tree.refresh'); } catch { /* ignore */ }
    if (results.length) {
      // 尝试打开第一个文件
      try {
        const uri = `file://${workspaceDir.replace(/\/$/, '')}/${results[0]}`;
        await commandService.tryExecuteCommand('core.open', uri);
      } catch { /* ignore */ }
    }
    e.target.value = '';
  };

  return (
    <div className="ab-welcome">
      <style>{STYLES}</style>
      <div className="ab-welcome__inner">
        <div className="ab-welcome__logo">
          {brand.logoChar ? (
            <span style={{ fontSize: 30, fontWeight: 700 }}>{brand.logoChar}</span>
          ) : (
            <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
          )}
        </div>
        <h1 className="ab-welcome__title">{brand.name}</h1>
        {brand.tagline && <p className="ab-welcome__subtitle">{brand.tagline}</p>}

        {/* workspaceDir 显示 (按需求去掉) */}
        {/* {workspaceDir && (
          <p className="ab-welcome__cwd" title={workspaceDir}>工作区: {workspaceDir}</p>
        )} */}

        <div className="ab-welcome__actions">
          {/* 上传文件入口已移到 chat 顶部 + 按钮 (showOpenFilePicker), welcome 不再提供 */}
        </div>
      </div>
    </div>
  );
};

const STYLES = `
.ab-welcome {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  background: var(--app-panel-bg);
  color: var(--editor-foreground, var(--vscode-editor-foreground));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  overflow: auto;
}
.ab-welcome__inner {
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; padding: 40px 24px;
  max-width: 560px; width: 100%;
}
.ab-welcome__logo {
  width: 72px; height: 72px;
  border-radius: 18px;
  background: var(--button-background, var(--vscode-button-background, #2563eb));
  color: var(--button-foreground, var(--vscode-button-foreground, #fff));
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--button-background, #2563eb) 30%, transparent);
  margin-bottom: 14px;
}
.ab-welcome__title {
  margin: 0; font-size: 28px; font-weight: 700; letter-spacing: 0.5px;
  color: var(--editor-foreground, var(--vscode-editor-foreground));
}
.ab-welcome__subtitle {
  margin: 0 0 18px;
  font-size: 14px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground));
}
.ab-welcome__cwd {
  margin: 0 0 24px;
  font-size: 12px;
  color: var(--descriptionForeground, var(--vscode-descriptionForeground));
  font-family: var(--monaco-monospace-font, ui-monospace, SFMono-Regular, Menlo, monospace);
  background: var(--input-background, var(--vscode-input-background, rgba(128,128,128,0.1)));
  border: 1px solid var(--panel-border, var(--vscode-panel-border, transparent));
  padding: 4px 10px; border-radius: 6px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ab-welcome__actions {
  display: flex; gap: 12px; flex-wrap: wrap; justify-content: center;
}
.ab-welcome__btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 18px;
  background: var(--button-secondaryBackground, var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15)));
  color: var(--button-secondaryForeground, var(--vscode-button-secondaryForeground, var(--editor-foreground)));
  border: 1px solid var(--panel-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
  border-radius: 10px;
  font-family: inherit; font-size: 13.5px; font-weight: 500;
  cursor: pointer; transition: background .15s, border-color .15s, transform .05s;
}
.ab-welcome__btn:hover {
  background: var(--list-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,0.2)));
  border-color: var(--focusBorder, var(--vscode-focusBorder, rgba(128,128,128,0.3)));
}
.ab-welcome__btn:active { transform: translateY(1px); }
.ab-welcome__btn--primary {
  background: var(--button-background, var(--vscode-button-background, #2563eb));
  color: var(--button-foreground, var(--vscode-button-foreground, #fff));
  border-color: transparent;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--button-background, #2563eb) 25%, transparent);
}
.ab-welcome__btn--primary:hover {
  background: var(--button-hoverBackground, var(--vscode-button-hoverBackground));
}
`;
