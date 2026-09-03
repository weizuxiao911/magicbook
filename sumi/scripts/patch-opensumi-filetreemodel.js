#!/usr/bin/env node
/**
 * patch-opensumi-filetreemodel.js — postinstall 自动应用 FileTreeService + FileTreeModelService race 修复
 *
 * 治本 opensumi file-tree-next 两个 race condition:
 *
 * 1) FileTreeService.init() listener race:
 *    framework fire-and-forget 启动 init(), 内部 await workspaceService.roots 时挂起.
 *    如果在 await 期间 module.ts 调 setWorkspace 触发 onWorkspaceChanged emit,
 *    FileTreeService.init() 还没注册 listener → emit 错过 → fileTreeService.root 仍是 undefined
 *    → explorer 只渲染 workspace 三角没子节点.
 *
 *    修复: init 走完 listener 注册好后, 检查 this._roots 是否非空但 this.root 还是 undefined,
 *    手动 fire 一次 onWorkspaceChangeEmitter + refresh, 重建 root + 通知 FileTreeModelService.
 *
 * 2) FileTreeModelService.onWorkspaceChange dispose race:
 *    FileTreeModelService 监听 fileTreeService.onWorkspaceChange, 回调里立即
 *    this.disposableCollection.dispose() + this.initTreeModel().
 *    dispose 把所有 push 进 collection 的 disposable 释放 (含刚 push 的自身 listener 和
 *    initTreeModel 重建期间 push 的新 listener), 中间窗口 emit 丢失 → explorer 空白.
 *
 *    修复: 把即将失效的 collection 暂存, 替换 this.disposableCollection 让 initTreeModel
 *    注册新 listener, 旧 collection 留给异步 dispose.
 *
 * 跟 patch-codeblitz-constant.js 风格一致: 局部字符串替换, 幂等, postinstall 自动应用.
 * npm install 后自动重放, 不会被重装覆盖.
 *
 * 触发场景:
 *   localStorage APP_CWD 残留 (用户之前选过的工作目录) 跟 server PWD (numas) 不一致时,
 *   module.ts onStart setWorkspace 触发 onWorkspaceChanged → FileTreeService.init() 错过 emit
 *   → explorer 子节点空白. 现治本: 两层 race 都修.
 */
const fs = require('node:fs');
const path = require('node:path');

const FTMODEL_FILE = path.resolve(
  __dirname,
  '../node_modules/@opensumi/ide-file-tree-next/lib/browser/services/file-tree-model.service.js',
);
const FTSERVICE_FILE = path.resolve(
  __dirname,
  '../node_modules/@opensumi/ide-file-tree-next/lib/browser/file-tree.service.js',
);

const MARKER_DEFER = '__numasDeferDispose';
const MARKER_RECOVER = '__numasRecoverRoot';

// ============================================================================
// Patch 1: FileTreeModelService dispose 推迟
// ============================================================================
const FTMODEL_OLD = `        this.disposableCollection.push(this.fileTreeService.onWorkspaceChange(() => {
            this.disposableCollection.dispose();
            this.initTreeModel();
        }));`;

const FTMODEL_NEW = `        this.disposableCollection.push(this.fileTreeService.onWorkspaceChange(() => {
            // numas patch (__numasDeferDispose): 原版立即 dispose() 会让 initTreeModel()
            // 重建期间新 push 的 onWorkspaceChange listener 被一起释放, 后续 emit 无 listener
            // 接收 → fileTreeService.root 仍是 undefined → explorer 只渲染 workspace 三角没子节点.
            // 改为: 把即将失效的 collection 暂存, 替换 this.disposableCollection 让 initTreeModel
            // 注册新 listener, 旧 collection 留到 initTreeModel 完成再 dispose. 双 collection 隔离.
            const __numasOldColl = this.disposableCollection;
            this.disposableCollection = new ide_core_browser_1.DisposableCollection();
            this.initTreeModel().then(() => {
                __numasOldColl.dispose();
            });
        }));`;

function patchFileTreeModel() {
  if (!fs.existsSync(FTMODEL_FILE)) {
    console.warn('[patch-filetreemodel] target not found:', FTMODEL_FILE);
    return false;
  }
  let src = fs.readFileSync(FTMODEL_FILE, 'utf-8');
  if (src.includes(MARKER_DEFER)) {
    console.log('[patch-filetreemodel] FileTreeModelService.dispose 已 patch, 跳过');
    return true;
  }
  if (!src.includes(FTMODEL_OLD)) {
    console.warn('[patch-filetreemodel] FileTreeModelService OLD pattern 未匹配, 版本可能变化, 请检查', FTMODEL_FILE);
    return false;
  }
  fs.writeFileSync(FTMODEL_FILE, src.replace(FTMODEL_OLD, FTMODEL_NEW));
  console.log('[patch-filetreemodel] FileTreeModelService.dispose 推迟 patch applied');
  return true;
}

// ============================================================================
// Patch 2: FileTreeService.init() setWorkspace 后兜底 fire
// ============================================================================
// init() 末尾插入兜底 fire: 如果 init 期间 setWorkspace 已 emit 但 listener 错过, 这里补一次.
// 锚点: 最后那个 onPreferenceChanged 的 `}));` 之后, 紧接着 `}` (init 结束) 之前.
const FTSERVICE_OLD = `        this.toDispose.push(this.corePreferences.onPreferenceChanged((change) => {
            if (change.preferenceName === 'explorer.fileTree.baseIndent') {
                this._baseIndent = change.newValue || 8;
                this.onTreeIndentChangeEmitter.fire({
                    indent: this.indent,
                    baseIndent: this.baseIndent,
                });
            }
            else if (change.preferenceName === 'explorer.fileTree.indent') {
                this._indent = change.newValue || 8;
                this.onTreeIndentChangeEmitter.fire({
                    indent: this.indent,
                    baseIndent: this.baseIndent,
                });
            }
            else if (change.preferenceName === 'explorer.compactFolders') {
                this._isCompactMode = change.newValue;
                this.refresh();
            }
        }));
    }`;

const FTSERVICE_NEW = `        this.toDispose.push(this.corePreferences.onPreferenceChanged((change) => {
            if (change.preferenceName === 'explorer.fileTree.baseIndent') {
                this._baseIndent = change.newValue || 8;
                this.onTreeIndentChangeEmitter.fire({
                    indent: this.indent,
                    baseIndent: this.baseIndent,
                });
            }
            else if (change.preferenceName === 'explorer.fileTree.indent') {
                this._indent = change.newValue || 8;
                this.onTreeIndentChangeEmitter.fire({
                    indent: this.indent,
                    baseIndent: this.baseIndent,
                });
            }
            else if (change.preferenceName === 'explorer.compactFolders') {
                this._isCompactMode = change.newValue;
                this.refresh();
            }
        }));
        // numas patch (__numasRecoverRoot): init 是 framework fire-and-forget 启动的,
        // await workspaceService.roots 期间 module.ts 的 setWorkspace 可能已经触发 emit,
        // 我们的 onWorkspaceChanged listener 错过 → fileTreeService.root 仍是 undefined →
        // explorer 只渲染 workspace 三角没子节点. 现在 init 走完 listener 都注册好,
        // 但 emit 不会再触发 — 手动重建 root (新 Directory 实例, 跟 line 109 listener 一致).
        //
        // 注意: 不 fire this.onWorkspaceChangeEmitter.fire(newRoot)!
        //   因为 fire 会触发 FileTreeModelService listener → initTreeModel → resolveChildren
        //   → line 230 this.root = children[0] (根目录的第一个子节点) — 覆盖我们的 newRoot,
        //   且 children[0] 是文件 (如 .DS_Store), UI 渲染出来没 children.
        //   只 set root + refresh, explorer 视图会自然通过 fireFilesChange 拿到 children.
        if (this._roots && this._roots.length > 0 && !this.root) {
            const __numasRoots = this._roots;
            const __numasUri = new ide_core_browser_1.URI(__numasRoots[0].uri);
            const __numasRoot = new file_tree_node_define_1.Directory(this, undefined, __numasUri, __numasUri.displayName, __numasRoots[0], this.fileTreeAPI.getReadableTooltip(__numasUri));
            this.root = __numasRoot;
            // 触发 explorer 重新拉根 (fireFilesChange 也行, refresh 走内部 _changeEventDispatchQueue)
            this.fileService.fireFilesChange({ changes: [{ uri: __numasUri.toString(), type: 1 }] });
            if (typeof window !== 'undefined') {
                window.__numasInit = window.__numasInit || {};
                window.__numasInit.fired = true;
                window.__numasInit.rootAfter = !!this.root;
                window.__numasInit.rootName = __numasRoot.name;
            }
        }
    }`;

function patchFileTreeService() {
  if (!fs.existsSync(FTSERVICE_FILE)) {
    console.warn('[patch-filetreemodel] target not found:', FTSERVICE_FILE);
    return false;
  }
  let src = fs.readFileSync(FTSERVICE_FILE, 'utf-8');
  if (src.includes(MARKER_RECOVER)) {
    console.log('[patch-filetreemodel] FileTreeService.init 已 patch, 跳过');
    return true;
  }
  if (!src.includes(FTSERVICE_OLD)) {
    console.warn('[patch-filetreemodel] FileTreeService.init OLD pattern 未匹配, 版本可能变化, 请检查', FTSERVICE_FILE);
    return false;
  }
  fs.writeFileSync(FTSERVICE_FILE, src.replace(FTSERVICE_OLD, FTSERVICE_NEW));
  console.log('[patch-filetreemodel] FileTreeService.init 兜底 fire patch applied');
  return true;
}

const ok1 = patchFileTreeModel();
const ok2 = patchFileTreeService();
if (!ok1 || !ok2) process.exitCode = 1;
