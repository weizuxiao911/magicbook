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
 *   - localStorage['editor.restore.{ws}.uris']: JSON.stringify([uri, ...])  (ws = 工作空间目录, 按 workspace 隔离)
 *   - localStorage['editor.restore.{ws}.activeUri']: 单 uri 字符串
 *   - 旧全局 key (editor.restore.uris / editor.restore.activeUri): 首次启动迁移到当前 ws key 后删除
 *   - window.__SAVED_EDITOR_URIS__ / __SAVED_EDITOR_ACTIVE_URI__: 注入覆盖 (测试/特殊场景)
 *
 * DI: ClientAppContribution (BrowserModule 自动 register via contributionProvider).
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution, Domain } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';

import { getWorkspace } from '../../infra/url';

/** 当前 workspace 目录 (getWorkspace = URL ?directory, source-of-truth).
 *  key 维度用, 保证切换 workspace 互不污染. */
function currentWorkspaceKey(): string {
  try {
    const cwd = getWorkspace() || '';
    return cwd.replace(/^\/+|\/+$/g, '').replace(/[\\/:]/g, '_') || 'default';
  } catch {
    return 'default';
  }
}

/** 读 key (带旧全局 key 迁移: 旧数据首次迁移到当前 ws key, 之后旧 key 不再写) */
function persistedKey(suffix: 'uris' | 'activeUri'): string {
  return `editor.restore.${currentWorkspaceKey()}.${suffix}`;
}

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

  /** 同步当前打开的 URIs + 激活 URI 到 localStorage (按 workspace 隔离; 无变化则跳过写) */
  private syncPersistedUris(): void {
    try {
      const uris = this.editorService.getAllOpenedUris().map((u) => u.toString());
      const next = JSON.stringify(uris);
      const active = this.editorService.currentEditorGroup?.currentResource?.uri.toString() || '';
      const urisKey = persistedKey('uris');
      const activeKey = persistedKey('activeUri');
      if (next === localStorage.getItem(urisKey) && active === localStorage.getItem(activeKey)) {
        return;
      }
      localStorage.setItem(urisKey, next);
      if (active) localStorage.setItem(activeKey, active);
    } catch {
      /* ignore */
    }
  }

  /** 从 localStorage 读上次打开的 URIs (按 workspace), stat 校验存在 (走当前 file scheme provider),
   *  通过的逐个 open. 最后激活原 active URI (失效则激活最后一个).
   *  仅恢复属于当前 workspace 的 tab (跨 workspace 的文件不恢复, 避免污染当前工作区). */
  private async restoreOpenedEditors(): Promise<void> {
    try {
      // 当前工作目录基准 = URL ?directory (source-of-truth), 不能依赖 __APP_CONFIG__ 注入的
      // cwd (opencode 进程启动 workdir, 切 workspace 不更新 → stale → 恢复全被过滤).
      const cwd = getWorkspace() || '';
      const urisKey = persistedKey('uris');
      const activeKey = persistedKey('activeUri');
      const uris: string[] =
        (window as any).__SAVED_EDITOR_URIS__ ||
        (() => {
          let raw = localStorage.getItem(urisKey);
          // 旧全局 key 迁移: 无 ws key 且旧 key 有数据 → 用旧数据 (首轮 sync 后写回 ws key)
          if (!raw) {
            const legacy = localStorage.getItem('editor.restore.uris');
            if (legacy) { raw = legacy; localStorage.setItem(urisKey, legacy); }
          }
          if (!raw) return [];
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        })();
      const activeUri: string =
        (window as any).__SAVED_EDITOR_ACTIVE_URI__ ||
        localStorage.getItem(activeKey) ||
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
              // workspace 隔离: 只恢复当前 workspace 内的文件 (旧跨 ws 数据残留也一并滤掉)
              if (cwd && uri.startsWith('file://') && !uri.startsWith(`file://${cwd}`)) {
                console.log('[editor-session] 跳过跨 workspace 文件:', uri);
                return;
              }
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
        localStorage.setItem(urisKey, JSON.stringify(alive));
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