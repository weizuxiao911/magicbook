#!/usr/bin/env node
/**
 * numas dev.js — 根目录 dev 启动入口 (= npx bin 入口)
 *
 * 仓库根 package.json#bin = "./dev.js", `npx github:user/repo` 调此文件.
 *   启动 dev = 启动整个 numas (web + opencode), 一行命令用户无需关注子项目.
 *
 * 流程:
 *   1. 检查 web deps 完整性 (web/node_modules/.bin/webpack), 没装就 npm install
 *   2. 检查 opencode (web/node_modules/.bin/opencode), 没装就 npm install opencode-ai
 *   3. 启 opencode (serve 模式, detached, 进程组 pgid=-pid)
 *   4. 注入 env (APP_BASE_URL / OPENCODE_PORT / WEB_PORT) → spawn npm run dev
 *   5. 父进程 SIGINT/SIGTERM → kill 两组子进程 (opencode + webpack)
 *
 * 命令行 flag (覆盖默认端口):
 *   --server-port <n>    opencode 端口 (默认 24096)
 *   --web-port <n>       webpack 端口 (默认 7788)
 *
 * 设计: 单文件入口, 跨平台, 不依赖额外进程编排器.
 *   npx tarball 装 numas, deps 走 web/ 一次性 install (~30s 首次).
 *   进程树: dev.js → { opencode, webpack } (两个独立 detached 进程组).
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const WEB = path.join(ROOT, 'web');

/** 跨平台 */
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

/** 端口 (默认 + 命令行 flag 覆盖; npx 调用时传 --server-port / --web-port) */
function parsePortFlag(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}
const OPENCODE_PORT = parsePortFlag('--server-port', parseInt(process.env.OPENCODE_PORT || '24096', 10));
const WEB_PORT = parsePortFlag('--web-port', parseInt(process.env.WEB_PORT || '7788', 10));

/** 关键 bin 路径 (opencode 优先 web local → which 全局) */
const webWebpackBin = path.join(WEB, 'node_modules', '.bin', isWin ? 'webpack.cmd' : 'webpack');
const webOpencodeBin = path.join(WEB, 'node_modules', '.bin', isWin ? 'opencode.cmd' : 'opencode');
/** opencode binary 解析: 优先 web local shim, 退到 which 全局 */
function resolveOpencodeBin() {
  if (fs.existsSync(webOpencodeBin)) return webOpencodeBin;
  if (whichCmd('opencode')) {
    const out = isWin ? spawnSync('where', ['opencode']) : spawnSync('which', ['opencode']);
    const p = String(out.stdout || '').split('\n')[0].trim();
    if (p) return p;
  }
  return null;
}

/** 跨平台 which */
function whichCmd(cmd) {
  const probe = isWin ? spawnSync('where', [cmd]) : spawnSync('which', [cmd]);
  return probe.status === 0;
}

/** 检查 + 自装 (跨平台)
 *  --ignore-scripts: 跳过所有 postinstall (含 spdlog 的 node-gyp rebuild).
 *  spdlog 是 deprecated + native 包, Python 3.14 没 distutils 必崩.
 *  opensumi 用 JS fallback logger, 主流程不受影响.
 */
function ensureInstalled(label, ready, installCmd, installArgs, cwd) {
  if (ready()) {
    console.log(`[numas] ${label} deps 已就绪 (复用)`);
    return;
  }
  console.log(`[numas] 首次运行, 装 ${label} ...`);
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(installCmd, installArgs, { cwd, stdio: 'inherit', shell: isWin });
    if (r.status === 0) break;
    if (attempt < 3) console.warn(`[numas] ${label} 安装失败 (尝试 ${attempt}/3), 3s 后重试...`);
    if (attempt < 3) spawnSync(isWin ? 'powershell' : 'sleep', isWin
      ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3']
      : ['3']);
  }
  if (r.status !== 0) {
    console.error(`[numas] ${label} 安装失败 (status=${r.status})`);
    console.error(`[numas] 手动: cd ${cwd} && ${installCmd} ${installArgs.join(' ')}`);
    process.exit(1);
  }
}

// 1. web deps (react + codeblitz + webpack)
//   --ignore-scripts: 跳过 spdlog 等 native postinstall (Python 3.14 没 distutils 必崩)
ensureInstalled(
  'web',
  () => fs.existsSync(webWebpackBin),
  npmCmd,
  ['install', '--include=dev', '--prefer-offline', '--ignore-scripts'],
  WEB,
);
// 2. opencode (opencode-ai 提供二进制, --no-save 装到 web/; 也可全局 opencode)
ensureInstalled(
  'opencode',
  () => !!resolveOpencodeBin(),
  npmCmd,
  ['install', '--no-save', '--prefer-offline', '--ignore-scripts', 'opencode-ai'],
  WEB,
);
const opencodeBin = resolveOpencodeBin();
if (!opencodeBin) {
  console.error('[numas] opencode 装上但找不到 binary, 检查 web/node_modules');
  process.exit(1);
}

// 3. 端口冲突清理 (上轮跑剩的 zombie, 避免 listen EADDRINUSE)
function killPort(port) {
  try {
    const out = spawnSync('lsof', ['-ti', String(port)]);
    const pids = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* */ }
    }
  } catch { /* ignore */ }
}
killPort(OPENCODE_PORT);
killPort(WEB_PORT);

// 4. 启 opencode (独立 detached 进程组, cli.js 持有 pgid)
//   显式 --cors * 兼容 opencode 默认 CORS = *; --hostname 0.0.0.0 允许外部访问
console.log(`[numas] 启动 opencode (port=${OPENCODE_PORT}, hostname=0.0.0.0, cors=*)`);
console.log(`[numas]   cmd: ${opencodeBin}`);
const opencodeProc = spawn(opencodeBin, [
  'serve',
  '--hostname', '0.0.0.0',
  '--port', String(OPENCODE_PORT),
  '--cors', '*',
], {
  cwd: WEB,
  stdio: 'inherit',
  detached: true,   // 独立进程组, cli.js 杀整组
  shell: true,       // 跨平台, .cmd / .sh shim
});
if (!opencodeProc.pid) {
  console.error('[numas] opencode 启动失败 (no pid)');
  process.exit(1);
}
opencodeProc.on('error', (e) => console.warn('[numas] opencode spawn error:', e.message));
opencodeProc.on('exit', (code, sig) => {
  if (code !== 0 || sig) {
    console.error(`[numas] opencode 异常退出 (code=${code}, signal=${sig})`);
  }
});
console.log(`[numas] opencode pid=${opencodeProc.pid} (group=${opencodeProc.pid})`);

// 5. 注入 env 传给 webpack 子进程 (APP_BASE_URL 用 127.0.0.1, web 端本机连)
process.env.APP_BASE_URL = process.env.APP_BASE_URL || `http://127.0.0.1:${OPENCODE_PORT}`;
process.env.OPENCODE_PORT = String(OPENCODE_PORT);
process.env.WEB_PORT = String(WEB_PORT);
// registry 服务 dev 不启, 注入空 baseUrl 让 web 端代码降级
process.env.REGISTRY_BASE_URL = process.env.REGISTRY_BASE_URL || '';

// 6. 启 webpack (npm run dev, 独立 detached 进程组)
//   npm run dev 走 .cmd/.sh shim, macOS 也要 shell: true
console.log(`[numas] 启动 webpack (port=${WEB_PORT}, cwd=${WEB})`);
const webpackProc = spawn(npmCmd, ['run', 'dev'], {
  cwd: WEB,
  stdio: 'inherit',
  detached: true,   // 独立进程组, cli.js 杀整组
  shell: true,       // 跨平台, .cmd / .sh shim
});
if (!webpackProc.pid) {
  console.error('[numas] webpack 启动失败');
  try { process.kill(-opencodeProc.pid, 'SIGKILL'); } catch { /* */ }
  process.exit(1);
}
webpackProc.on('error', (e) => console.warn('[numas] webpack spawn error:', e.message));
console.log(`[numas] webpack pid=${webpackProc.pid} (group=${webpackProc.pid})`);

// 7. cleanup: 父进程 SIGINT/SIGTERM/exit → kill 两组子进程
const cleanup = (signal) => {
  console.log(`[numas] cleanup (${signal || 'exit'}) → kill opencode + webpack`);
  try { process.kill(-opencodeProc.pid, signal || 'SIGTERM'); } catch { /* */ }
  try { process.kill(-webpackProc.pid, signal || 'SIGTERM'); } catch { /* */ }
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT',  () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('exit',    () => {
  try { process.kill(-opencodeProc.pid, 'SIGTERM'); } catch { /* */ }
  try { process.kill(-webpackProc.pid, 'SIGTERM'); } catch { /* */ }
});

// 8. 自动打开浏览器 (sleep 4s 等 webpack-dev-server ready, 跨平台调用)
//    失败仅 warn, 不阻塞进程 (headless server / 无桌面环境也兼容)
const browserUrl = `http://localhost:${WEB_PORT}`;
console.log(`[numas] 4s 后自动打开浏览器 ${browserUrl}`);
setTimeout(() => {
  let opener, args;
  if (process.platform === 'darwin') { opener = 'open'; args = [browserUrl]; }
  else if (process.platform === 'win32') { opener = 'cmd'; args = ['/c', 'start', '', browserUrl]; }
  else { opener = 'xdg-open'; args = [browserUrl]; }
  try {
    const r = spawn(opener, args, { detached: true, stdio: 'ignore', shell: false });
    r.on('error', (e) => console.warn(`[numas] 自动打开浏览器失败 (${e.message}), 请手动访问 ${browserUrl}`));
    r.unref();
  } catch (e) {
    console.warn(`[numas] 自动打开浏览器失败 (${e.message}), 请手动访问 ${browserUrl}`);
  }
}, 4000);
