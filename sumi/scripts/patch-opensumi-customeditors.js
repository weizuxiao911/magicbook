#!/usr/bin/env node
/**
 * patch-opensumi-customeditors.js — postinstall 自动应用 customEditor webview 挂载 patch
 *
 * 把 web/scripts/customEditors.patch.js (useRef 版, 只 fire DisplayEvent 不挂 container)
 * copy 到 node_modules/@opensumi/ide-extension/.../customEditors.js, 就地替换 opensumi 原版.
 *
 * 为什么不用 webpack alias: opensumi 包内用相对路径 require("./customEditors"),
 *   alias 只匹配包路径形式的请求 → 不生效. 就地改 node_modules 则所有引用一致.
 *
 * npm install 后自动重放 (package.json postinstall), 不会被重装覆盖.
 * 幂等: node_modules 目标已含 marker 则跳过.
 */
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.resolve(
  __dirname,
  '../node_modules/@opensumi/ide-extension/lib/browser/vscode/contributes/customEditors.js',
);
const SOURCE = path.resolve(__dirname, './customEditors.patch.js');
const MARKER = '__numasCustomEditorUseRef';

function main() {
  if (!fs.existsSync(TARGET)) {
    console.warn('[patch-customeditors] target not found:', TARGET);
    process.exit(0);
  }
  const cur = fs.readFileSync(TARGET, 'utf-8');
  if (cur.includes(MARKER)) {
    console.log('[patch-customeditors] already patched, skip');
    return;
  }
  const patched = fs.readFileSync(SOURCE, 'utf-8');
  if (!patched.includes(MARKER)) {
    throw new Error('[patch-customeditors] source missing marker: ' + SOURCE);
  }
  fs.writeFileSync(TARGET, patched);
  console.log('[patch-customeditors] applied useRef patch to node_modules customEditors.js');
}

main();
