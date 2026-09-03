#!/usr/bin/env node
/**
 * patch-codeblitz-constant.js — postinstall 自动应用 WORKSPACE_ROOT + OverlayFS rename patch
 *
 * 1. WORKSPACE_ROOT 从固定 '/workspace' 改为运行时取真实 cwd:
 *    file:///workspace/x  →  file:///{cwd}/x
 *
 * 2. OverlayFS.renameSync 文件分支: 只存在于 readable (宿主机) 的文件移动
 *    改为宿主机原子 move (桥接 /.browserfs_moves.log → FsPty mv), 不走 copy —
 *    copy 对大文件 (30MB+ PDF) 会经 SDK 读 (30MB 限制) + 分块写 (6万块) 损坏文件.
 *
 * 为什么不用 webpack alias (web/src/patches/constant.js 方案):
 *   codeblitz 包内模块用相对路径互引, alias 只匹配包路径形式的请求 → 行为分裂.
 *   就地改 node_modules 则所有引用一致.
 *
 * npm install 后自动重放 (package.json postinstall), 不会被重装覆盖.
 * 幂等: 已 patch 则跳过.
 */
const fs = require('node:fs');
const path = require('node:path');

const CONST_FILE = path.resolve(__dirname, '../node_modules/@codeblitzjs/ide-sumi-core/lib/common/constant.js');
const OVERLAY_FILE = path.resolve(__dirname, '../node_modules/@codeblitzjs/ide-browserfs/lib/backend/OverlayFS.js');
const DISK_FILE = path.resolve(__dirname, '../node_modules/@codeblitzjs/ide-sumi-core/lib/server/file-service/disk-file-system.provider.js');
const MARKER = '__numasWorkspaceRoot';
const OVERLAY_MARKER = '__numasRenameBridge';
const DISK_MARKER = '__numasAtomicMove';

const PATCH = `// numas patch (postinstall): WORKSPACE_ROOT 运行时取真实工作目录 (file:///workspace/x → file:///{cwd}/x)
//   优先级: localStorage APP_CWD (用户选择) → sessionStorage APP_CWD_FALLBACK (hostCwd 兜底) → __APP_CONFIG__.cwd → '/workspace'
//   注意: constant.js 在 createApp 时首次求值, 此时 __APP_CONFIG__.cwd 可能尚未注入 (initRuntime 异步), 故 storage 优先
function __numasWorkspaceRoot() {
    try {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('APP_CWD') || sessionStorage.getItem('APP_CWD_FALLBACK');
            if (saved) return __numasWsNormalize(saved);
        }
        if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
            const c = window.__APP_CONFIG__;
            if (c.cwd) return __numasWsNormalize(c.cwd);
        }
    }
    catch (e) { /* 存储不可用 → 默认 */ }
    return '/workspace';
}
function __numasWsNormalize(p) {
    var s = String(p).replace(/\\\\/g, '/').replace(/\\/+$/, '');
    // Windows 盘符 (D:/... 或 /D:/...) → codeblitz URI 形态 (前导 '/', 盘符小写):
    //   codeblitz watch/BrowserFS 路径是 /d:/... (小写盘符), WORKSPACE_ROOT 必须同形态,
    //   否则 workspaceRel 的 startsWith 大小写不匹配 → 路径不 strip → explorer 列错目录.
    //   前导 '/' 必须: codeblitz workspaceDir 若无前导 '/', watch 会把相对路径拼成双份.
    if (/^[A-Za-z]:/.test(s)) s = '/' + s;
    s = s.replace(/^\/([A-Za-z]):/, function (_, drive) { return '/' + drive.toLowerCase() + ':'; });
    if (s === '/' || s === '') return '/workspace';
    return s;
}
export const WORKSPACE_ROOT = __numasWorkspaceRoot();`;

/** OverlayFS.renameSync 文件分支 patch: readable-only → 宿主机原子 move 桥. */
const OVERLAY_OLD = `        else {
            if (this.existsSync(newPath) && this.statSync(newPath, false).isDirectory()) {
                throw api_error_1.ApiError.EISDIR(newPath);
            }
            this.writeFileSync(newPath, this.readFileSync(oldPath, null, getFlag('r')), null, getFlag('w'), oldStats.mode);
        }`;

const OVERLAY_NEW = `        else {
            if (this.existsSync(newPath) && this.statSync(newPath, false).isDirectory()) {
                throw api_error_1.ApiError.EISDIR(newPath);
            }
            // numas patch (__numasRenameBridge): writable (本会话) 没有的文件 → 桥接宿主机原子 move
            // (写 /.browserfs_moves.log → runtime.ts _syncSync 拦截 → FsPty mv), 不走 copy —
            // copy 对 30MB+ 大文件经 SDK 读 + 分块写会损坏文件 (explorer 移动 PDF 实测).
            // 注: 不判断 readable.existsSync — DynamicRequest 懒加载, 未浏览目录 existsSync 恒 false, 会误走 copy.
            if (!this._writable.existsSync(oldPath)) {
                try {
                    this._writable.writeFileSync('/.browserfs_moves.log', 'm' + oldPath + '>' + newPath + '\\n', 'utf8', file_flag_1.FileFlag.getFileFlag('a'));
                    return;
                }
                catch (e) { /* 桥失败 → 原 copy 兜底 */ }
            }
            this.writeFileSync(newPath, this.readFileSync(oldPath, null, getFlag('r')), null, getFlag('w'), oldStats.mode);
        }`;

function patchConstant() {
  if (!fs.existsSync(CONST_FILE)) {
    console.warn('[patch-codeblitz] constant.js 不存在, 跳过 (deps 未装?)');
    return false;
  }
  let src = fs.readFileSync(CONST_FILE, 'utf8');
  if (src.includes(MARKER) && src.includes('__numasWsNormalize')) {
    console.log('[patch-codeblitz] constant.js 已 patch (新版本含 __numasWsNormalize), 跳过');
    return false;
  }
  const reverted = src.includes(MARKER)
    ? src.replace(/\/\/ numas patch \(postinstall\):[\s\S]*?export const WORKSPACE_ROOT = __numasWorkspaceRoot\(\);\n/, "export const WORKSPACE_ROOT = '/workspace';\n")
    : src;
  const out = reverted.replace("export const WORKSPACE_ROOT = '/workspace';", PATCH);
  if (out === reverted) {
    console.warn('[patch-codeblitz] 未找到 WORKSPACE_ROOT 定义, 版本可能变化, 请检查', CONST_FILE);
    return false;
  }
  fs.writeFileSync(CONST_FILE, out);
  console.log('[patch-codeblitz] WORKSPACE_ROOT → 运行时取真实 cwd (applied)');
  return true;
}

function patchOverlayRename() {
  if (!fs.existsSync(OVERLAY_FILE)) {
    console.warn('[patch-codeblitz] OverlayFS.js 不存在, 跳过');
    return false;
  }
  let src = fs.readFileSync(OVERLAY_FILE, 'utf8');
  if (src.includes(OVERLAY_MARKER)) {
    console.log('[patch-codeblitz] OverlayFS renameSync 已 patch, 跳过');
    return false;
  }
  if (!src.includes(OVERLAY_OLD)) {
    console.warn('[patch-codeblitz] OverlayFS renameSync 未匹配, 版本可能变化, 请检查', OVERLAY_FILE);
    return false;
  }
  fs.writeFileSync(OVERLAY_FILE, src.replace(OVERLAY_OLD, OVERLAY_NEW));
  console.log('[patch-codeblitz] OverlayFS renameSync → 宿主机原子 move (applied)');
  return true;
}

function patchDiskProviderMove() {
  if (!fs.existsSync(DISK_FILE)) {
    console.warn('[patch-codeblitz] disk-file-system.provider.js 不存在, 跳过');
    return false;
  }
  let src = fs.readFileSync(DISK_FILE, 'utf8');
  if (src.includes(DISK_MARKER)) {
    console.log('[patch-codeblitz] disk-provider doMove 已 patch, 跳过');
    return false;
  }
  // doMove else 分支: fse.move (fs-extra = copy+remove, 大文件损坏) → 宿主机原子 mv (FsPty)
  const old = `        else {
            await fse.move(_sourceUri.path, _targetUri.path, { overwrite });`;
  const next = `        else {
            // numas patch (__numasAtomicMove): fse.move 是 copy+remove (fs-extra 实现), 30MB+ 大文件会损坏.
            // 改桥接宿主机原子 mv (window.__APP_FS__.move → FsPty mv). 不可用时兜底原实现.
            try {
                const cfg = (typeof window !== 'undefined' && window.__APP_CONFIG__) ? window.__APP_CONFIG__ : null;
                const appFs = (typeof window !== 'undefined') ? window.__APP_FS__ : null;
                const cwd = (cfg && cfg.cwd) ? cfg.cwd : '';
                const strip = (p) => (cwd && p.startsWith(cwd)) ? p.slice(cwd.length) : p;
                if (cwd && appFs && typeof appFs.move === 'function') {
                    const ok = await appFs.move(strip(_sourceUri.path), strip(_targetUri.path));
                    if (ok === true || ok === undefined) {
                        // 宿主机已原子 mv, 跳过 fse.move; 后续 delete(_sourceUri) 因源已不存在而跳过
                    }
                    else {
                        await fse.move(_sourceUri.path, _targetUri.path, { overwrite });
                    }
                }
                else {
                    await fse.move(_sourceUri.path, _targetUri.path, { overwrite });
                }
            }
            catch (e) {
                await fse.move(_sourceUri.path, _targetUri.path, { overwrite });
            }`;
  if (!src.includes(old)) {
    console.warn('[patch-codeblitz] disk-provider doMove 未匹配, 版本可能变化, 请检查', DISK_FILE);
    return false;
  }
  fs.writeFileSync(DISK_FILE, src.replace(old, next));
  console.log('[patch-codeblitz] disk-provider doMove → 宿主机原子 move (applied)');
  return true;
}

const ok1 = patchConstant();
const ok2 = patchOverlayRename();
const ok3 = patchDiskProviderMove();
if (!ok1 || !ok2 || !ok3) process.exitCode = 1;

