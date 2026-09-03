import { Injectable, Autowired } from '@opensumi/di';
import { Domain, URI } from '@opensumi/ide-core-common';
import { BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import type { IResource, ResourceService } from '@opensumi/ide-editor';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
} from '@opensumi/ide-editor/lib/browser/types';

import { WelcomeView } from './WelcomeView';

const WELCOME_SCHEME = 'welcome';
const WELCOME_ID = 'webapp.welcome';
const WELCOME_URI = new URI(`${WELCOME_SCHEME}://home`);

/**
 * Welcome 拓展 — 空工作区时主区欢迎页
 *
 * 注册:
 *   - IResourceProvider for scheme 'welcome' → 把 welcome://home 解析为 IResource
 *   - EditorComponent uid = WELCOME_ID, scheme = WELCOME_SCHEME → React 组件 WelcomeView
 *
 * 自动打开:
 *   - onDidRestoreState 生命周期里检查当前 editor groups, 若没有任何已打开的资源,
 *     自动打开 welcome://home (不跨刷新恢复 supportsRevive = false).
 */
@Injectable()
@Domain(BrowserEditorContribution, ClientAppContribution)
export class WelcomeContribution implements BrowserEditorContribution, ClientAppContribution {
  @Autowired(WorkbenchEditorService)
  private readonly editorService: WorkbenchEditorService;

  // ----- Resource Provider -----
  registerResource(resourceService: ResourceService): void {
    resourceService.registerResourceProvider({
      scheme: WELCOME_SCHEME,
      provideResource: (uri: URI): IResource => ({
        uri,
        name: '欢迎',
        icon: 'codicon codicon-home',
        supportsRevive: false,
      }),
      shouldCloseResourceWithoutConfirm: () => true,
    });
  }

  // ----- Editor Component -----
  registerEditorComponent(registry: EditorComponentRegistry): void {
    registry.registerEditorComponent({
      uid: WELCOME_ID,
      scheme: WELCOME_SCHEME,
      component: WelcomeView,
    });
    registry.registerEditorComponentResolver(WELCOME_SCHEME, (_resource, results, resolve) => {
      resolve([
        {
          componentId: WELCOME_ID,
          type: 'component',
          title: '欢迎',
        },
      ]);
    });
  }

  // ----- 启动后自动打开 (若没有已恢复的编辑器) -----
  onDidRestoreState?(): void {
    // 多等一帧, 让其他贡献点 (如 explorer) 先完成 restore
    setTimeout(() => {
      try {
        const groups = (this.editorService as any).editorGroups || [];
        const anyOpen = groups.some((g: any) => g.resources && g.resources.length > 0);
        if (!anyOpen) {
          void this.editorService.open(WELCOME_URI, { preview: false, focus: false });
        }
      } catch (err) {
        console.warn('[welcome] auto-open failed:', err);
      }
    }, 60);
  }

  // ClientAppContribution stub (onStart/initialize not needed; onDidRestoreState 已够用)
  initialize?(): void {}
  onStart?(): void {}
}

@Injectable()
export class WelcomeModule extends BrowserModule {
  providers = [WelcomeContribution];
  contributionProvider = [BrowserEditorContribution, ClientAppContribution];
}
