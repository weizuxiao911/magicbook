/**
 * contribution/editor-restore/contribution.ts
 *
 * EditorRestoreFallbackContribution — 官方 workbench tab 恢复的「延迟兜底」
 *
 * 背景 (2026-09-05 实测): codeblitz 官方 restoreState 在 WorkbenchEditorService.doInitialize
 * 早期执行, 该时机 numas 自定义 fs provider 链下的 file 资源 handlesUri 尚未就绪 →
 * doOpen 走 openerService 静默早退 (不建 tab、不报错、随后缓存被清空), 官方恢复必然落空:
 *   - workbench storage (localStorage scoped:{ws}:/workbench) 有 uris
 *   - 但启动后没有任何 file tab, 官方因「无打开资源」判定打开欢迎页
 *
 * 职责 (用户拍板: 官方规则 + numas 延迟兜底):
 *   - 欢迎页显示/打开规则仍归 codeblitz 官方 (不干预、不双开)
 *   - 本贡献在 onDidRestoreState (官方恢复流程结束) 后延迟检查: workbench 缓存有 uris
 *     但编辑器无任何 file tab (官方恢复落空) → 手动恢复 uris
 *   - 恢复成功后关闭官方因空判定已打开的欢迎页 (避免「欢迎页 + 文件」并存观感)
 *   - 官方恢复成功 (已有 file tab) → 完全不干预
 *
 * 数据契约 (只读官方 workbench storage, 不另建 key):
 *   - localStorage['scoped:{workspaceDir}:/workbench'] → { grid: '{editorGroup json}' }
 *   - 不写入任何 numas 自建持久化 key
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule, ClientAppContribution, Domain } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { IFileServiceClient } from '@opensumi/ide-file-service/lib/common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { BrowserEditorContribution } from '@opensumi/ide-editor/lib/browser/types';

import { getWorkspace } from '../../infra/url';

/** 当前 workspace 目录 (URL ?directory, source-of-truth) */
function currentCwd(): string {
  try {
    return getWorkspace() || '';
  } catch {
    return '';
  }
}

/** 读官方 workbench storage 里的 grid uris (file:// 过滤; 不含欢迎页等非 file scheme) */
function readWorkbenchUris(): { uris: string[]; active: string } {
  try {
    const cwd = currentCwd();
    if (!cwd) return { uris: [], active: '' };
    // opensumi ScopedBrowserStorageService key: `scoped:{workspaceDir}:{scope}`,
    // workspaceDir 可能带/不带尾斜杠 → 两种形态都匹配
    const candidates = [`scoped:${cwd}:/workbench`, `scoped:${cwd.replace(/\/+$/, '')}/:/workbench`];
    let raw = '';
    for (const k of candidates) {
      const v = localStorage.getItem(k);
      if (v) { raw = v; break; }
    }
    if (!raw) return { uris: [], active: '' };
    const state = JSON.parse(raw) as { grid?: string };
    const grid = JSON.parse(state.grid || '{}') as { editorGroup?: { uris?: string[]; current?: string } };
    const eg = grid?.editorGroup;
    const uris = (eg?.uris || []).filter(
      (u) => typeof u === 'string' && u.startsWith('file://'),
    );
    const cur = eg?.current || '';
    const active = cur.startsWith('file://') ? cur : '';
    return { uris, active };
  } catch {
    return { uris: [], active: '' };
  }
}

/** 当前编辑器是否已有任意 file tab (官方恢复成功标志) */
function hasAnyFileTab(editorService: WorkbenchEditorService): boolean {
  try {
    const groups = (editorService as any).editorGroups || [];
    return groups.some((g: any) =>
      (g.resources || []).some((r: any) => {
        try { return r.uri.scheme === 'file'; } catch { return false; }
      }),
    );
  } catch {
    return false;
  }
}

@Injectable()
@Domain(BrowserEditorContribution, ClientAppContribution)
export class EditorRestoreFallbackContribution implements BrowserEditorContribution, ClientAppContribution {
  @Autowired(IFileServiceClient)
  private readonly fileService!: IFileServiceClient;

  @Autowired(WorkbenchEditorService)
  private readonly editorService!: WorkbenchEditorService;

  /** 官方恢复前的 uris 快照: opensumi storage debounce flush 会在启动早期把空 grid 异步
   *  写回覆盖缓存 → 兜底必须用恢复前快照. 快照在 index.html inline script (bundle 前,
   *  早于一切 storage 队列) 取到 window.__NUMAS_WB_URIS__, 这里读它 + 现值兜底. */
  private snapshot: { uris: string[]; active: string } = { uris: [], active: '' };

  /** onStart 读 inline script 快照 (window.__NUMAS_WB_URIS__) */
  onStart(): void {
    try {
      const w = (window as any).__NUMAS_WB_URIS__;
      if (Array.isArray(w) && w.length) {
        this.snapshot = { uris: w as string[], active: '' };
      } else {
        this.snapshot = readWorkbenchUris();
      }
    } catch {
      this.snapshot = readWorkbenchUris();
    }
  }

  /** 官方 onDidRestoreState (官方恢复流程结束、欢迎页判定完成) 后延迟兜底 */
  onDidRestoreState?(): void {
    setTimeout(() => { void this.fallbackRestore(); }, 900);
  }

  private async fallbackRestore(): Promise<void> {
    try {
      // 优先快照 (官方可能已把缓存空保存覆盖); 快照空则回退读现值 (官方未恢复场景)
      const cached = this.snapshot.uris.length ? this.snapshot : readWorkbenchUris();
      const { uris, active } = cached;
      if (!uris.length) return;
      // 官方恢复成功 (已有 file tab) → 不干预
      if (hasAnyFileTab(this.editorService)) return;

      console.log('[editor-restore] 官方恢复未生效 (早期 handlesUri 未就绪), numas 延迟兜底:', uris.length);
      const cwd = currentCwd();
      const alive: string[] = [];
      await Promise.all(
        uris.map(async (uriStr) => {
          try {
            if (cwd && !uriStr.startsWith(`file://${cwd.replace(/\/+$/, '')}`)) {
              console.log('[editor-restore] 跳过跨 workspace 文件:', uriStr);
              return;
            }
            const stat = await this.fileService.getFileStat(uriStr);
            if (!stat || stat.isDirectory) return;
            alive.push(uriStr);
            await this.editorService.open(URI.parse(uriStr), {
              backend: true,
              preview: false,
              deletedPolicy: 'skip',
            });
            console.log('[editor-restore] 恢复建 tab:', uriStr);
          } catch (e) {
            console.warn('[editor-restore] 恢复失败:', uriStr, e);
          }
        }),
      );
      if (!alive.length) return;

      // 恢复成功 → 关闭官方因「无打开资源」判空已打开的欢迎页
      try {
        const groups = (this.editorService as any).editorGroups || [];
        for (const g of groups) {
          const welcomes = (g.resources || []).filter((r: any) => {
            try { return r.uri.scheme === 'welcome'; } catch { return false; }
          });
          for (const w of welcomes) await g.close(w.uri, { force: true });
        }
      } catch { /* ignore */ }

      // 激活原 current (失效则最后一个)
      const target = active && alive.includes(active) ? active : alive[alive.length - 1];
      if (target) {
        await this.editorService.open(URI.parse(target), { focus: true, preview: false }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
}

@Injectable()
export class EditorRestoreFallbackModule extends BrowserModule {
  providers = [EditorRestoreFallbackContribution];
  contributionProvider = [BrowserEditorContribution, ClientAppContribution];
}
