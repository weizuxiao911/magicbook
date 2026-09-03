/**
 * contribution/editor-session/contribution.ts
 *
 * EditorSessionContribution — codeblitz 编辑器 tab 状态持久化贡献.
 *
 * 职责: 持久化编辑器打开的 tab + 当前激活 tab 到 localStorage, 刷新后从 localStorage 读回.
 *   - 不依赖 BrowserFS, 跟文件系统 Provider 完全解耦 (用 IFileServiceClient stat + IEditorService.open)
 *   - 不依赖 service/fs.ts (那边已精简, 只负责 FilePicker/chat IO API)
 *
 * 数据契约:
 *   - localStorage['editor.restore.uris']: JSON.stringify([uri, ...])
 *   - localStorage['editor.restore.activeUri']: 单 uri 字符串
 *   - window.__SAVED_EDITOR_URIS__ / __SAVED_EDITOR_ACTIVE_URI__: 注入覆盖 (测试/特殊场景)
 *
 * DI: ClientAppContribution (BrowserModule 自动 register via contributionProvider).
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution, Domain } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';

@Injectable()
@Domain(ClientAppContribution)
export class EditorSessionContribution implements ClientAppContribution {
  @Autowired(IFileServiceClient)
  private readonly fileService!: IFileServiceClient;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  /** 启动时调用: 恢复持久化的 tab + 激活 */
  onStart(): Promise<void> {
    this.watchEditorState();
    void this.restoreOpenedEditors();
    return Promise.resolve();
  }

  /** 监听编辑器状态: onActiveResourceChange / onDidEditorGroupsChanged / 2s 兜底轮询 */
  private watchEditorState(): void {
    try {
      this.editorService.onActiveResourceChange(() => this.syncPersistedUris());
      this.editorService.onDidEditorGroupsChanged(() => this.syncPersistedUris());
      (this.editorService as any).onDidEditorGroupTabChanged?.(() => this.syncPersistedUris());
      setInterval(() => this.syncPersistedUris(), 2000);
    } catch {
      /* ignore — 监听失败不影响主流程 */
    }
  }

  /** 同步当前打开的 URIs + 激活 URI 到 localStorage (无变化则跳过写) */
  private syncPersistedUris(): void {
    try {
      const uris = this.editorService.getAllOpenedUris().map((u) => u.toString());
      const next = JSON.stringify(uris);
      const active = this.editorService.currentEditorGroup?.currentResource?.uri.toString() || '';
      if (next === localStorage.getItem('editor.restore.uris') && active === localStorage.getItem('editor.restore.activeUri')) {
        return;
      }
      localStorage.setItem('editor.restore.uris', next);
      if (active) localStorage.setItem('editor.restore.activeUri', active);
    } catch {
      /* ignore */
    }
  }

  /** 从 localStorage 读上次打开的 URIs, stat 校验存在 (走当前 file scheme provider),
   *  通过的逐个 open. 最后激活原 active URI (失效则激活最后一个). */
  private async restoreOpenedEditors(): Promise<void> {
    try {
      const uris: string[] =
        (window as any).__SAVED_EDITOR_URIS__ ||
        (() => {
          const raw = localStorage.getItem('editor.restore.uris');
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        })();
      const activeUri: string =
        (window as any).__SAVED_EDITOR_ACTIVE_URI__ ||
        localStorage.getItem('editor.restore.activeUri') ||
        '';
      if (!uris.length) return;
      console.log('[editor-session] 恢复编辑器 tab:', uris.length, uris, 'active:', activeUri);
      await new Promise((r) => setTimeout(r, 500));
      const alive: string[] = [];
      await Promise.all(
        uris.map((uri) =>
          this.fileService
            .getFileStat(uri)
            .then((stat) => {
              if (!stat || stat.isDirectory) return;
              alive.push(uri);
              return this.editorService
                .open(URI.parse(uri), { backend: true, preview: false, deletedPolicy: 'skip' })
                .then(() => console.log('[editor-session] 恢复建 tab:', uri))
                .catch((e) => console.warn('[editor-session] 恢复建 tab 失败:', uri, e));
            })
            .catch(() => {}),
        ),
      );
      if (alive.length !== uris.length) {
        localStorage.setItem('editor.restore.uris', JSON.stringify(alive));
        console.log('[editor-session] 恢复状态自愈:', uris.filter((u) => !alive.includes(u)), '已从持久化移除');
      }
      const target =
        activeUri && alive.includes(activeUri) && !activeUri.startsWith('welcome:')
          ? activeUri
          : alive[alive.length - 1];
      if (target) {
        await this.editorService
          .open(URI.parse(target), { focus: true, preview: false })
          .then(() => console.log('[editor-session] 恢复激活当前 tab:', target))
          .catch((e) => console.warn('[editor-session] 恢复激活失败:', target, e));
      }
    } catch {
      /* ignore */
    }
  }
}

@Injectable()
export class EditorSessionModule extends BrowserModule {
  providers = [EditorSessionContribution];
  contributionProvider = ClientAppContribution;
}