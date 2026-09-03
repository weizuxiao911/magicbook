#!/usr/bin/env node
/**
 * patch-codeblitz-constant.js — postinstall: 修补 WORKSPACE_ROOT
 *
 * 1. WORKSPACE_ROOT 从固定 '/workspace' 改为运行时取真实 cwd:
 *    file:///workspace/x  →  file:///{cwd}/x
 *
 *    必要性: terminal.ts / agent.ts / extensions/pdf/* 大量代码通过
 *    `file://${WORKSPACE_ROOT}${rel}` 拼 URI. 不 patch 这些 URI 就是
 *    'file:///workspace/x' → 我们的 CustomFileSystemProvider.uriToRel 拿不到
 *    真实 cwd 路径 → server 500.
 *
 * 2. OverlayFS.renameSync / DiskFileSystemProvider doMove 补丁已不需要
 *    (BrowserFS 完全被替换, 详见 sumi/src/config/fs.ts).
 *
 * 为什么不用 webpack alias: codeblitz 包内模块用相对路径互引, alias 只匹配
 * 包路径形式请求 → 行为分裂. 就地改 node_modules 则所有引用一致.
 *
 * npm install 后自动重放 (package.json postinstall), 不会被重装覆盖.
 * 幂等: 已 patch 则跳过.
 */
const fs = require('node:fs');
const path = require('node:path');

const CONST_FILE = path.resolve(__dirname, '../node_modules/@codeblitzjs/ide-sumi-core/lib/common/constant.js');
const MARKER = '__numasWorkspaceRoot';

const PATCH = `// numas patch (postinstall): WORKSPACE_ROOT 运行时取真实工作目录 (file:///workspace/x → file:///{cwd}/x)
//   优先级: URL ?directory= (source-of-truth) → __APP_CONFIG__.cwd (opencode /path 注入) → '/workspace' (兜底)
//   注: constant.js 在 createApp 时首次求值. opencode service initRuntime 异步,
//   启动时无 URL ?directory 也没 __APP_CONFIG__.cwd → 兜底 '/workspace' → initRuntime 完 redirect + reload
//   二次求值时 URL 已有 ?directory, 直接读.
function __numasWorkspaceRoot() {
    try {
        if (typeof window !== 'undefined' && window.location) {
            const dir = new URL(window.location.href).searchParams.get('directory');
            console.log('[numas-patch] __numasWorkspaceRoot: dir=' + dir);
            if (dir) return dir.replace(/\\/+$/, '');
        }
        if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
            const c = window.__APP_CONFIG__;
            console.log('[numas-patch] __numasWorkspaceRoot: __APP_CONFIG__.cwd=' + c?.cwd);
            if (c.cwd) return c.cwd.replace(/\\/+$/, '');
        }
    }
    catch (e) { console.log('[numas-patch] __numasWorkspaceRoot: error', e); }
    console.log('[numas-patch] __numasWorkspaceRoot: fallback /workspace');
    return '/workspace';
}
export const WORKSPACE_ROOT = __numasWorkspaceRoot();`;

function patchConstant() {
    if (!fs.existsSync(CONST_FILE)) {
        console.warn('[patch-codeblitz] constant.js 不存在, 跳过 (deps 未装?)');
        return false;
    }
    let src = fs.readFileSync(CONST_FILE, 'utf8');
    if (src.includes(MARKER) && src.includes("saved.replace(/\\\\/+$/, '')")) {
        console.log('[patch-codeblitz] constant.js 已 patch, 跳过');
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

const ok = patchConstant();
if (!ok) process.exitCode = 1;