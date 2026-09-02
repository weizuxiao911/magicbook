/**
 * customEditor 根治 patch (v1) — web/src/dev/patch-custom-editor.ts
 *
 * 根因: opensumi/createCustomEditorComponent 的 React 组件在 dev mode 下
 *       mount→unmount→mount 双调用,导致 useEffect 异步 .then() 跑回来时
 *       React ref 已被设 null,挂载跳过,webview 永远不挂。
 *
 * 根治: webview 生命周期完全交给 main thread 接管,React 组件只 fire event。
 *       main thread patch onCustomEditorShouldDisplayEvent,自己 create webview
 *       + 挂到 workbench-editor 根下的 stable container (React 树外),
 *       监听编辑器事件自动调整位置 + 卸载。
 *
 * 关闭: 设 window.__CE_PATCH_DISABLED__ = true 后刷新页面
 */

import { MainThreadCustomEditor } from '@opensumi/ide-extension/lib/browser/vscode/api/main.thread.custom-editor';
import { CustomEditorShouldHideEvent } from '@opensumi/ide-extension/lib/common/vscode/custom-editor';
// events 在 @opensumi/ide-editor/lib/browser/types
import { EditorGroupChangeEvent, EditorActiveResourceStateChangedEvent } from '@opensumi/ide-editor/lib/browser/types';
// docRef 需要
import { IEditorDocumentModelService } from '@opensumi/ide-editor/lib/browser';

const TAG = '[ce-patch]';

interface PendingMount {
  webview: any;
  viewType: string;
  uri: any;
  openTypeId: string;
  webviewOptions: any;
  extensionInfo: any;
  cancellationToken: any;
  mounted: boolean;
  stableContainer?: HTMLElement;
  resizeObserver?: ResizeObserver;
  onWindowResize?: () => void;
  syncPosition?: () => void;
  hideDisposable?: { dispose: () => void };
  docRef?: any;  // IEditorDocumentModelService 创建的 doc ref, 卸载时 dispose
}

interface InstanceState {
  pendingMounts: Map<string, PendingMount>;
  mountedMap: Map<string, PendingMount>;
  handlersRegistered: boolean;
}

const stateMap = new WeakMap<any, InstanceState>();

function getState(instance: any): InstanceState {
  let s = stateMap.get(instance);
  if (!s) {
    s = { pendingMounts: new Map(), mountedMap: new Map(), handlersRegistered: false };
    stateMap.set(instance, s);
  }
  return s;
}

function findPaperTabContainer(uriStr: string): {
  group: HTMLElement;
  editorBody: HTMLElement;
} | null {
  const workbenchEditor = document.getElementById('workbench-editor');
  if (!workbenchEditor) return null;
  const escaped = uriStr.replace(/"/g, '\\"');
  const tab = workbenchEditor.querySelector(
    `.kt_editor_tab___LLmhN[data-uri="${escaped}"]`,
  );
  if (!tab) return null;
  const group = tab.closest('.kt_editor_group____46Ak');
  if (!group) return null;
  const editorBody = group.querySelector('.kt_editor_components___cmFFV');
  if (!editorBody) return null;
  return { group: group as HTMLElement, editorBody: editorBody as HTMLElement };
}

export function installCustomEditorPatch(): void {
  if ((window as any).__CE_PATCH_DISABLED__) return;
  if ((window as any).__CE_PATCH_INSTALLED__) return;
  (window as any).__CE_PATCH_INSTALLED__ = true;
  // eslint-disable-next-line no-console
  console.log(TAG, 'installing — webview 生命周期移交 main thread');

  // patch onCustomEditorShouldDisplayEvent
  MainThreadCustomEditor.prototype.onCustomEditorShouldDisplayEvent = async function patchedDisplay(
    this: any,
    e: any,
  ) {
    const mapKeys = this.customEditors ? Array.from(this.customEditors.keys()) : [];
    // eslint-disable-next-line no-console
    console.log(TAG, '[dbg] DisplayEvent', { viewType: e?.payload?.viewType, mapKeys, editorExists: !!this.customEditors?.get(e?.payload?.viewType) });
    const editor = this.customEditors.get(e.payload.viewType);
    if (!editor) return;

    const { viewType, uri, openTypeId, webviewPanelId, cancellationToken } = e.payload;
    const state = getState(this);
    const key = `${viewType}::${uri.toString()}`;

    // 已有 pending / 已挂载, 跳过 (避免 React StrictEffects 双调用重复)
    if (state.pendingMounts.has(key) || state.mountedMap.has(key)) {
      // eslint-disable-next-line no-console
      console.log(TAG, 'skip duplicate', { key });
      return;
    }

    // 拿 webview (React useEffect 可能已经 create 了, 优先复用)
    let webview = webviewPanelId ? this.webviewService.getWebview(webviewPanelId) : null;
    // eslint-disable-next-line no-console
    console.log(TAG, '[dbg] getWebview', { webviewPanelId, got: !!webview });
    if (!webview) {
      try {
        webview = this.webviewService.createWebview(editor.options.webviewOptions || {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(TAG, 'createWebview failed', err);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(TAG, '[dbg] createWebview in patch', { created: !!webview });
    }
    if (!webview) return;

    // eslint-disable-next-line no-console
    console.log(TAG, 'patched onCustomEditorShouldDisplayEvent', { key, webviewId: webview.id });

    // 缓存
    state.pendingMounts.set(key, {
      webview,
      viewType,
      uri,
      openTypeId,
      webviewOptions: editor.options.webviewOptions || {},
      extensionInfo: editor.extensionInfo,
      cancellationToken,
      mounted: false,
    });

    // 注册编辑器事件监听
    if (!state.handlersRegistered) {
      state.handlersRegistered = true;
      const tryMount = () => (this as any).__paperTryMountAllPending();
      // 切到 paper 时挂载, 切走时卸载
      // 同时扫 mountedMap (已挂) + pendingMounts (隐藏/待挂),
      // 否则 paper 切走再切回就找不到 info 了 (sync 看不到 → 永不恢复)
      // 检测激活 tab 走 DOM (workbenchEditorService.currentResource.uri 对 customEditor
      // 返回 undefined, 不可用)
       const sync = () => {
         const activeTab = document.querySelector(
           '.kt_editor_tab___LLmhN.kt_editor_tab_current___A2OZc',
         ) as HTMLElement | null;
         const activeUri = activeTab?.getAttribute('data-uri') || '';
         const all = new Map<string, PendingMount>([
           ...state.mountedMap.entries(),
           ...state.pendingMounts.entries(),
         ]);
         for (const [key, info] of Array.from(all.entries())) {
           if (activeUri === info.uri.toString()) {
             // 当前就是 paper, 确保挂载/恢复显示
             (this as any).__paperTryMount(key);
           } else {
             // 检查 paper tab 是否还在 DOM (用户可能关闭了 tab, 不止切走)
             // main slot 只有 paper 一个 tab 时关闭, 整个 group 销毁, activeTab 为 null
             const escapedUri = info.uri.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
             const tabStillExists = !!document.querySelector(
               `[data-uri="${escapedUri}"]`,
             );
             if (tabStillExists) {
               // 切走了, 隐藏 (切回时复用)
               (this as any).__paperHide(key);
             } else {
               // tab 关闭了, 彻底卸载 (避免孤儿 webview 残留)
               (this as any).__paperUnmount(key);
             }
           }
         }
       };
       this.addDispose(this.eventBus.on(EditorGroupChangeEvent, sync));
       this.addDispose(this.eventBus.on(EditorActiveResourceStateChangedEvent, sync));

       // 兜底: DOM MutationObserver 监听 paper tab 关闭 (避免孤儿 webview)
       // 监听 document.body 子树: 一旦 paper uri 的 tab 从 DOM 消失, sync() 检测到
       // tabStillExists=false → 调 __paperUnmount 清 webview
       const observer = new MutationObserver(() => sync());
       observer.observe(document.body, { childList: true, subtree: true });
     }

    // 立即尝试挂载
    (this as any).__paperTryMountAllPending();
  };

  // 尝试挂载所有 pending
  (MainThreadCustomEditor.prototype as any).__paperTryMountAllPending = async function (this: any) {
    const state = getState(this);
    for (const key of Array.from(state.pendingMounts.keys())) {
      await this.__paperTryMount(key);
    }
  };

  // 挂载单个
  (MainThreadCustomEditor.prototype as any).__paperTryMount = async function (this: any, key: string) {
    const state = getState(this);
    const info = state.pendingMounts.get(key);
    if (!info) return;
    if (info.cancellationToken?.isCancellationRequested) {
      state.pendingMounts.delete(key);
      return;
    }
    if (info.mounted) {
      // 已挂载过, 切回时只需恢复显示
      if (info.stableContainer) {
        info.stableContainer.style.display = 'block';
      }
      // 重新计算位置
      if (info.syncPosition) info.syncPosition();
      // 重新挂载 ResizeObserver
      const target = findPaperTabContainer(info.uri.toString());
      if (target && info.resizeObserver) {
        try { info.resizeObserver.observe(target.editorBody); } catch { /* */ }
      }
      if (target && info.onWindowResize) {
        window.addEventListener('resize', info.onWindowResize);
      }
      // eslint-disable-next-line no-console
      console.log(TAG, '__paperTryMount: reshow', { key });
      state.pendingMounts.delete(key);
      state.mountedMap.set(key, info);
      return;
    }

    const workbenchEditor = document.getElementById('workbench-editor');
    if (!workbenchEditor) {
      // eslint-disable-next-line no-console
      console.log(TAG, 'no workbench-editor, defer', { key });
      return;
    }

    // 找当前激活的 paper tab 容器
    const target = findPaperTabContainer(info.uri.toString());
    if (!target) {
      // eslint-disable-next-line no-console
      console.log(TAG, 'paper tab not found, defer', { key });
      return;
    }

    // 挂到 workbench-editor 根下的 stable container (React 树外)
    const stableKey = `__paper_mount_${key}`;
    let stableContainer = workbenchEditor.querySelector<HTMLElement>(
      `:scope > div[data-paper-mount-key="${stableKey.replace(/"/g, '\\"')}"]`,
    );
    if (!stableContainer) {
      stableContainer = document.createElement('div');
      stableContainer.setAttribute('data-paper-mount-key', stableKey);
      stableContainer.style.cssText = 'position:absolute;pointer-events:auto;z-index:2;';
      workbenchEditor.appendChild(stableContainer);
    }

    // 同步位置
    const syncPosition = () => {
      const rect = target.editorBody.getBoundingClientRect();
      const workRect = workbenchEditor.getBoundingClientRect();
      if (!stableContainer) return;
      stableContainer.style.top = rect.top - workRect.top + 'px';
      stableContainer.style.left = rect.left - workRect.left + 'px';
      stableContainer.style.width = rect.width + 'px';
      stableContainer.style.height = rect.height + 'px';
    };
    syncPosition();

    // 监听 editor body 尺寸 + window resize
    const resizeObserver = new ResizeObserver(syncPosition);
    resizeObserver.observe(target.editorBody);
    const onWindowResize = () => syncPosition();
    window.addEventListener('resize', onWindowResize);

    info.stableContainer = stableContainer;
    info.resizeObserver = resizeObserver;
    info.onWindowResize = onWindowResize;
    info.syncPosition = syncPosition;
    info.mounted = true;

    // 注册 hide event 监听, 关闭 tab 时完全卸载
    const hideDisposable = this.eventBus.on(CustomEditorShouldHideEvent, (e: any) => {
      if (info.uri.toString() === e.payload.uri.toString()) {
        (this as any).__paperUnmount(key);
      }
    });
    info.hideDisposable = hideDisposable;

    // ★ 直接调 webview.appendTo(stableContainer) 挂载
    // eslint-disable-next-line no-console
    console.log(TAG, '__paperTryMount: before appendTo', {
      key,
      webviewId: info.webview.id,
      hasIframe: !!info.webview.iframe,
      iframeParent: info.webview.iframe?.parentElement?.tagName,
      stableContainerChildCount: stableContainer.children.length,
    });
    try {
      info.webview.appendTo(stableContainer);
      // eslint-disable-next-line no-console
      console.log(TAG, '__paperTryMount: after appendTo', {
        key,
        webviewId: info.webview.id,
        iframeParent: info.webview.iframe?.parentElement?.tagName,
        iframeParentDataKey: info.webview.iframe?.parentElement?.getAttribute?.('data-paper-mount-key'),
        stableContainerChildCount: stableContainer.children.length,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'appendTo failed', err);
      (this as any).__paperUnmount(key);
      return;
    }

    // pipe + fire resolve
    try {
      // ★ paper 拓展 resolve 需要先有 docRef, 否则 getDocument 失败
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docModelService: any = (this as any).editorDocumentModelService;
      let docRef: any = null;
      if (docModelService && info.uri) {
        try {
          docRef = await docModelService.createModelReference(info.uri);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(TAG, 'createModelReference failed (try without docRef)', e);
        }
      }
      if (docRef) {
        info.docRef = docRef;
        // docRef 在 unmount 时释放
        // 监听 hide event
      }

      this.webview.pipeBrowserHostedWebviewPanel(
        info.webview,
        { uri: info.uri, openTypeId: info.openTypeId },
        info.viewType,
        info.webviewOptions,
        info.extensionInfo,
      );
      this.proxy.$resolveCustomTextEditor(
        info.viewType,
        info.uri.codeUri,
        info.webview.id,
        info.cancellationToken,
      );
      // eslint-disable-next-line no-console
      console.log(TAG, 'webview mounted + resolve fired', { key, webviewId: info.webview.id, hasDocRef: !!docRef });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'pipe/resolve failed', err);
      (this as any).__paperUnmount(key);
      return;
    }

    state.mountedMap.set(key, info);
    state.pendingMounts.delete(key);
  };

  // 隐藏 (切走 tab 时) — 保留 webview/stableContainer, 切回时只需重新显示
  (MainThreadCustomEditor.prototype as any).__paperHide = function (this: any, key: string) {
    const state = getState(this);
    const info = state.mountedMap.get(key) || state.pendingMounts.get(key);
    if (!info) return;
    // eslint-disable-next-line no-console
    console.log(TAG, '__paperHide', { key });

    if (info.resizeObserver) {
      try { info.resizeObserver.disconnect(); } catch { /* */ }
    }
    if (info.onWindowResize) {
      try { window.removeEventListener('resize', info.onWindowResize); } catch (_) { /* */ }
    }
    if (info.stableContainer) {
      info.stableContainer.style.display = 'none';
    }
    // 从 mountedMap 移出, 但 info.webview 保持活着
    state.mountedMap.delete(key);
    // 关键: re-add 到 pendingMounts, 否则 sync 扫不到 → 切回时 __paperTryMount 永不触发
    state.pendingMounts.set(key, info);
  };

  // 彻底卸载 (关闭 tab 时) — 完全清理
  (MainThreadCustomEditor.prototype as any).__paperUnmount = function (this: any, key: string) {
    const state = getState(this);
    const info = state.mountedMap.get(key) || state.pendingMounts.get(key);
    if (!info) return;
    // eslint-disable-next-line no-console
    console.log(TAG, '__paperUnmount', { key });

    (this as any).__paperHide(key);

    if (info.hideDisposable) {
      try { info.hideDisposable.dispose(); } catch { /* */ }
    }
    if (info.docRef) {
      try { info.docRef.dispose(); } catch { /* */ }
    }
    if (info.webview) {
      try { info.webview.remove(); } catch { /* */ }
      try { info.webview.dispose(); } catch { /* */ }
    }
    if (info.stableContainer && info.stableContainer.parentNode) {
      const toRemove = info.stableContainer;
      setTimeout(() => {
        if (toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
      }, 100);
    }
    state.mountedMap.delete(key);
    state.pendingMounts.delete(key);
  };

  // eslint-disable-next-line no-console
  console.log(TAG, 'installed, 刷新页面看效果');
}
