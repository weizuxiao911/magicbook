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
 *   - 缺 registry deps → npm install 在 registry/ (typescript)
 * 每个检查 idempotent, 首次 ~30s 装完, 之后秒级.
 *
 * 守卫统一用 "关键 bin 是否就绪" (deps 完整性), 不用 build 产物:
 *   早期 registry 守卫看 server.js 存在性, 但 server.js 在 git 里被跟踪
 *   (dev 模式跑 `node src/server.js` 不走 build:config), 守卫误判 deps 已就绪
 *   → npx 模式 registry install 跳过 → tsc 找不到 → build:config 失败.
 *   改用 .bin/tsc 看 typescript 装没装, deps 完整性才准.
 *
 * 默认 opencode 端口 24096 (匹配 web/.env.development 的 APP_BASE_URL);
 * CORS 默认 http://127.0.0.1:7788 (webpack-dev-server 默认地址). 用户可命令行覆盖.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 跨平台 win 判定 (cli 启动时用) */
function isWin() { return process.platform === 'win32'; }

const root = path.resolve(__dirname, '../..');  // cli/bin → 项目根
const cliDir = path.resolve(__dirname, '..');    // cli/bin → cli/
const webDir = path.join(root, 'web');
const registryDir = path.join(root, 'registry');
const REGISTRY_PORT = 7790;

/** 关键 bin 路径 (用于 install 守卫: 看 deps 完整性, 不看 build 产物) */
const tsxBin = path.join(root, 'node_modules', '.bin', isWin() ? 'tsx.cmd' : 'tsx');
const opencodeBin = path.join(cliDir, 'node_modules', '.bin', isWin() ? 'opencode.cmd' : 'opencode');
const webTscBin = path.join(webDir, 'node_modules', '.bin', isWin() ? 'tsc.cmd' : 'tsc');
const registryTscBin = path.join(registryDir, 'node_modules', '.bin', isWin() ? 'tsc.cmd' : 'tsc');
const cliEntry = path.join(cliDir, 'src', 'main.ts');  // cli/bin → cli/src/main.ts

/** 跨平台 npm script runner (win: npm.cmd + shell, posix: 直接 npm) */
function runNpmScript(cwd, script) {
  const r = spawnSync(isWin() ? 'npm.cmd' : 'npm', ['run', script], { cwd, stdio: 'inherit', shell: isWin() });
  if (r.status !== 0) {
    console.error(`[cli] ${script} 失败 (status=${r.status})`);
    process.exit(1);
  }
}

/** 跨平台 sleep (win: powershell, posix: sleep) */
function sleepSec(sec) {
  if (isWin()) {
    spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${sec}`]);
  } else {
    spawnSync('sleep', [String(sec)]);
  }
}

/** 跨平台 which (win: where, posix: which) */
function whichCmd(cmd) {
  if (isWin()) return spawnSync('where', [cmd]).status === 0;
  return spawnSync('which', [cmd]).status === 0;
}

function ensureInstalled(label, depsReadyCheck, cmd, args, cwd) {
  if (depsReadyCheck()) {
    console.log(`[cli] ${label} deps 已就绪 (复用)`);
    return;
  }
  console.log(`[cli] 首次运行, 装 ${label} ...`);
  // 网络抖动重试 2 次 (registry 抽风, ECONNRESET 等)
  // Windows: npm 命令是 npm.cmd, 需要 shell: true
  const finalCmd = isWin() ? 'npm.cmd' : cmd;
  const finalArgs = isWin() && cmd === 'npm' ? args : args;
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(finalCmd, finalArgs, { cwd, stdio: 'inherit', shell: isWin() });
    if (r.status === 0) break;
    if (attempt < 3) {
      console.warn(`[cli] ${label} 安装失败 (尝试 ${attempt}/3), 等 3s 重试...`);
      sleepSec(3);
    }
  }
  if (r.status !== 0) {
    console.error(`[cli] ${label} 安装失败 (status=${r.status})`);
    console.error(`[cli] 网络可能抽风, 请手动: cd ${cwd} && ${cmd} ${args.join(' ')}`);
    console.error(`[cli] 装好后重跑 npx 即可, bin 会跳过已装的`);
    process.exit(1);
  }
}

// 守卫统一用 "关键 bin 是否就绪" (deps 完整性), 不用 build 产物
// (npx 缓存复用 + git 跟踪的产物会误导守卫, 导致 install 跳过 → tsc 找不到)
ensureInstalled(
  'tsx',
  () => fs.existsSync(tsxBin) || whichCmd('tsx'),
  'npm',
  ['install', '--no-save', '--prefer-offline', 'tsx'],
  root,
);
ensureInstalled(
  'opencode',
  () => fs.existsSync(opencodeBin) || whichCmd('opencode'),
  'npm',
  ['install', '--no-save', '--prefer-offline', 'opencode-ai'],
  cliDir,
);
ensureInstalled(
  'web',
  () => fs.existsSync(webTscBin),
  'npm',
  ['install', '--include=dev', '--prefer-offline'],
  webDir,
);
ensureInstalled(
  'registry',
  () => fs.existsSync(registryTscBin),
  'npm',
  ['install', '--include=dev', '--prefer-offline'],
  registryDir,
);
// 配置预编译 (registry server.ts/build.ts → JS; webpack.config 已是 JS 直接用, 不再 tsc 编译)
// 运行时不需要 tsx 编译 ts 配置; 删了 webpack.config.ts 后 web build:config 也无意义
runNpmScript(registryDir, 'build:config');

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
// registry 端口注入 web 端 (跟 opencode 同模式: 单一事实源 = cli 决定 url)
process.env.REGISTRY_BASE_URL = process.env.REGISTRY_BASE_URL || `http://${hostname}:${REGISTRY_PORT}`;

// spawn 决策: 优先本地 node_modules/.bin/tsx (保证版本一致), 否则用 PATH 的 tsx (用户全局装)
const useLocalTsx = fs.existsSync(tsxBin);
const tsxCmd = useLocalTsx ? tsxBin : 'tsx';
if (!useLocalTsx && !whichCmd('tsx')) {
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
