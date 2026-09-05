#!/usr/bin/env node
/**
 * patch-opensumi-fixlayout.js — postinstall: 修补
 * @opensumi/ide-core-browser/lib/components/layout/default-layout.js 的
 * fixLayout(), 让它在「面板 size 缺失但 currentId 本就为 undefined」时不要把
 * currentId 清成 ''。
 *
 * 治本冷启动 left slot 强制折叠 bug:
 *   1. LayoutService.restoreTabbarService 用
 *      fixLayout(layoutState.getState(MAIN, defaultLayoutState)) 读持久化态。
 *   2. 冷启动无持久化时 getState 返回 defaultLayoutState, 其 left =
 *      { currentId: undefined, size: undefined }。
 *   3. 原 fixLayout 对每个槽位 `if (!layout[key].size) newLayout[key].currentId = ''`,
 *      无条件把 size 缺失的 currentId 清成 '' —— undefined 也被清成 ''。
 *   4. restoreTabbarService 随后按 currentId 三分支: undefined → 消费
 *      appConfig.defaultPanels 展开默认面板; '' → 保持折叠。被清成 '' 后
 *      defaultPanels 永远失效, 冷启动 left slot 恒折叠。
 *
 * 根治: 仅当 currentId 本就有值(truthy)但 size 缺失时才清空(这是 fixLayout 原本
 * 防「记录了展开却没宽度」的意图); currentId 为 undefined(冷启动)时保留, 交给
 * defaultPanels 分支处理。用户主动折叠存的是 currentId:''(falsy), 不受影响,
 * 折叠状态依旧尊重。
 *
 * 幂等: marker 检测已 patch 跳过. lib 版本升级 regex 模式还能命中就继续打.
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET_FILE = path.resolve(
  __dirname,
  '../node_modules/@opensumi/ide-core-browser/lib/components/layout/default-layout.js',
);
const MARKER = '__numasFixLayoutKeepDefault';

const OLD = `        if (!layout[key].size) {
            newLayout[key].currentId = '';
        }`;

const NEW = `        // numas patch (__numasFixLayoutKeepDefault): 仅当 currentId 本就有值但 size
        // 缺失时才清空; currentId 为 undefined (冷启动无持久化) 时保留, 让
        // restoreTabbarService 走 isUndefined 分支消费 appConfig.defaultPanels 展开默认
        // 面板. 原逻辑无条件清空会把 undefined 改成 '' → defaultPanels 永远失效 →
        // 冷启动 left slot 强制折叠. 用户折叠存 currentId:'' (falsy) 不受影响.
        if (!layout[key].size && newLayout[key].currentId) {
            newLayout[key].currentId = '';
        }`;

function patch() {
  if (!fs.existsSync(TARGET_FILE)) {
    console.warn('[patch-opensumi-fixlayout] target not found:', TARGET_FILE);
    return false;
  }
  let src = fs.readFileSync(TARGET_FILE, 'utf-8');
  if (src.includes(MARKER)) {
    console.log('[patch-opensumi-fixlayout] 已 patch, 跳过');
    return true;
  }
  if (!src.includes(OLD)) {
    console.warn('[patch-opensumi-fixlayout] OLD 未匹配, 包版本可能变化, 请检查', TARGET_FILE);
    return false;
  }
  fs.writeFileSync(TARGET_FILE, src.replace(OLD, NEW));
  console.log('[patch-opensumi-fixlayout] fixLayout 保留 undefined currentId patch applied');
  return true;
}

if (!patch()) process.exitCode = 1;
