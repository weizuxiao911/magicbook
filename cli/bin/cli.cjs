#!/usr/bin/env node
/**
 * cli — npx bin 入口
 *
 * 转发到 cli/src/main.ts (通过 tsx 执行); 默认子命令 web.
 *
 * 使用:
 *   npx github:user/repo            → 等价 web (默认 :24096 + :7788)
 *   npx github:user/repo web        → 启 web (codeblitz) + opencode
 *   npx github:user/repo serve      → 只起 opencode
 *   npx github:user/repo --help     → 帮助
 *
 * 设计: npx 调起本文件 (package.json bin), 内部 spawn tsx 跑 cli/src/main.ts.
 *   不再依赖 npm --prefix 间接调, 少一层 fork, 冷启 -300ms.
 *
 * npx github: 不会自动装 numas 的 deps, 所以 bin 自检 + 自装:
 *   - 缺 tsx          → 装到 root/node_modules
 *   - 缺 opencode     → 装到 web/node_modules (opencode-ai 提供二进制)
 *   - 缺 web deps     → npm install 在 web/ (react + codeblitz + webpack)
 * 每个检查 idempotent, 首次 ~30s 装完, 之后秒级.
 *
 * 默认 opencode 端口 24096 (匹配 web/.env.development 的 APP_BASE_URL);
 * CORS 默认 http://127.0.0.1:7788 (webpack-dev-server 默认地址). 用户可命令行覆盖.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');  // cli/bin → 项目根
const cliDir = path.resolve(__dirname, '..');    // cli/bin → cli/
const webDir = path.join(root, 'web');

const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
const opencodeBin = path.join(cliDir, 'node_modules', '.bin', 'opencode');
const cliEntry = path.join(cliDir, 'src', 'main.ts');  // cli/bin → cli/src/main.ts

/** 缺啥装啥, idempotent; opencode/tsx 优先用 PATH 里用户全局装的 (任意版本, 不锁) */
function ensureInstalled(label, cmd, args, cwd) {
  if (label === 'tsx' && fs.existsSync(tsxBin)) return;
  if (label === 'tsx') {
    // PATH 有 tsx (用户 npm i -g tsx) 也跳过本地装
    if (spawnSync('which', ['tsx']).status === 0) {
      console.log('[cli] 检测到 PATH tsx, 复用 (跳过安装)');
      return;
    }
  }
  if (label === 'opencode') {
    if (fs.existsSync(opencodeBin)) return;
    if (spawnSync('which', ['opencode']).status === 0) {
      console.log('[cli] 检测到 PATH opencode, 复用 (跳过安装)');
      return;
    }
  }
  if (label === 'web') {
    if (fs.existsSync(path.join(webDir, 'node_modules', 'webpack'))) return;
  }
  console.log(`[cli] 首次运行, 装 ${label} ...`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[cli] ${label} 安装失败 (status=${r.status}), 请手动: cd ${cwd} && ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

ensureInstalled('tsx', 'npm', ['install', '--no-save', '--prefer-offline', 'tsx'], root);
ensureInstalled('opencode', 'npm', ['install', '--no-save', '--prefer-offline', 'opencode-ai'], cliDir);
// NODE_ENV=production (npx 默认传) 会让 npm install 跳 devDeps, 强制 include
ensureInstalled('web', 'npm', ['install', '--include=dev', '--prefer-offline'], webDir);

const args = process.argv.slice(2);
if (args.length === 0) args.push('web'); // 默认 web 模式

// 解析 cli 自己的参数 (不传给 opencode)
let webPort = '7788';
const wpIdx = args.indexOf('--web-port');
if (wpIdx >= 0 && args[wpIdx + 1]) {
  webPort = args[wpIdx + 1];
  args.splice(wpIdx, 2);  // 移除, opencode 不识别
}

// 默认 opencode 参数
if (!args.includes('--port')) args.push('--port', '24096');
if (!args.includes('--hostname')) args.push('--hostname', '127.0.0.1');
// CORS 默认指向 web 端口
if (!args.includes('--cors')) args.push('--cors', `http://127.0.0.1:${webPort}`);

// 单一事实源: cli's --port 决定 APP_BASE_URL, 通过 env var 注入到 webpack
// (webpack 优先读 process.env, 兜底 .env; 用户运行时改 --port 即可全局生效)
const portIdx = args.indexOf('--port');
const hostnameIdx = args.indexOf('--hostname');
const port = portIdx >= 0 && args[portIdx + 1] ? args[portIdx + 1] : '24096';
const hostname = hostnameIdx >= 0 && args[hostnameIdx + 1] ? args[hostnameIdx + 1] : '127.0.0.1';
process.env.APP_BASE_URL = process.env.APP_BASE_URL || `http://${hostname}:${port}`;
// web 端口也通过 env var 传给 webpack-dev-server
process.env.WEB_PORT = webPort;

// spawn 决策: 优先本地 node_modules/.bin/tsx (保证版本一致), 否则用 PATH 的 tsx (用户全局装)
const useLocalTsx = fs.existsSync(tsxBin);
const tsxCmd = useLocalTsx ? tsxBin : 'tsx';
if (!useLocalTsx && spawnSync('which', ['tsx']).status !== 0) {
  console.error('[cli] 找不到 tsx; 请 npm i -g tsx');
  process.exit(1);
}

const child = spawn(tsxCmd, [cliEntry, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code || 0));
child.on('error', (e) => {
  console.error('[cli] 启动失败:', e.message);
  process.exit(1);
});
