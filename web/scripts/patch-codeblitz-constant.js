#!/usr/bin/env node
/**
 * patch-codeblitz-constant.js — postinstall 自动应用 WORKSPACE_ROOT patch
 *
 * 把 @codeblitzjs/ide-sumi-core 的 WORKSPACE_ROOT 从固定 '/workspace' 改为运行时取真实 cwd:
 *   file:///workspace/x  →  file:///{cwd}/x
 *
 * 为什么不用 webpack alias (web/src/patches/constant.js 方案):
 *   codeblitz 包内模块用相对路径互引 constant.js, webpack alias 只匹配包路径形式的请求,
 *   包内相对引用走原版 → 我们与 codeblitz 内部行为分裂. 就地改 node_modules 则所有引用一致.
 *
 * npm install 后自动重放 (package.json postinstall), 不会被重装覆盖.
 * 幂等: 已 patch 则跳过.
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '../node_modules/@codeblitzjs/ide-sumi-core/lib/common/constant.js');
const MARKER = '__numasWorkspaceRoot';

const PATCH = `// numas patch (postinstall): WORKSPACE_ROOT 运行时取真实工作目录 (file:///workspace/x → file:///{cwd}/x)
//   优先级: localStorage APP_CWD (用户选择) → sessionStorage APP_CWD_FALLBACK (hostCwd 兜底) → __APP_CONFIG__.cwd → '/workspace'
//   注意: constant.js 在 createApp 时首次求值, 此时 __APP_CONFIG__.cwd 可能尚未注入 (initRuntime 异步), 故 storage 优先
function __numasWorkspaceRoot() {
    try {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('APP_CWD') || sessionStorage.getItem('APP_CWD_FALLBACK');
            if (saved) return saved.replace(/\\/+$/, '');
        }
        if (typeof window !== 'undefined' && window.__APP_CONFIG__) {
            const c = window.__APP_CONFIG__;
            if (c.cwd) return c.cwd.replace(/\\/+$/, '');
        }
    }
    catch (e) { /* 存储不可用 → 默认 */ }
    return '/workspace';
}
export const WORKSPACE_ROOT = __numasWorkspaceRoot();`;

function main() {
  if (!fs.existsSync(FILE)) {
    console.warn('[patch-codeblitz] constant.js 不存在, 跳过 (deps 未装?)');
    return;
  }
  const src = fs.readFileSync(FILE, 'utf8');
  if (src.includes(MARKER) && src.includes("saved.replace(/\\/+$/, '')")) {
    console.log('[patch-codeblitz] constant.js 已 patch, 跳过');
    return;
  }
  // 旧版 patch (无 trim): 先还原为原始定义再应用新版
  const reverted = src.includes(MARKER)
    ? src.replace(/\/\/ numas patch \(postinstall\):[\s\S]*?export const WORKSPACE_ROOT = __numasWorkspaceRoot\(\);\n/, "export const WORKSPACE_ROOT = '/workspace';\n")
    : src;
  const out = reverted.replace("export const WORKSPACE_ROOT = '/workspace';", PATCH);
  if (out === reverted) {
    console.warn('[patch-codeblitz] 未找到 WORKSPACE_ROOT 定义, 版本可能变化, 请检查', FILE);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(FILE, out);
  console.log('[patch-codeblitz] WORKSPACE_ROOT → 运行时取真实 cwd (applied)');
}

main();
