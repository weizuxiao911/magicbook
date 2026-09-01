#!/usr/bin/env node
/**
 * numas dev.js — 根目录 dev 启动入口 (= npx bin 入口)
 *
 * 仓库根 package.json#bin = "./dev.js", `npx github:user/repo` 调此文件.
 *   启动 dev = 启动整个 numas (web + opencode), 一行命令用户无需关注子项目.
 *
 * 流程:
 *   0. Node 版本检查 (≥ 20, 用户唯一前置)
 *   1. 检查 web deps 完整性 (web/node_modules/.bin/webpack + 依赖 hash marker), 没装/版本变更才 npm install
 *   2. 检查 opencode (PATH 全局 + web 本地兜底), 没装就 npm i -g opencode-ai
 *   3. 检查 watchexec (fs watcher PTY 依赖 — node FSEvents 在 opencode pty 必炸, watchexec 实测可用), 没装按平台装
 *   4. 清掉端口残留 zombie (上轮跑剩的), 避免 listen EADDRINUSE
 *   5. 启 opencode (serve 模式, detached, 进程组 pgid=-pid)
 *   6. 注入 env (APP_BASE_URL / OPENCODE_PORT / WEB_PORT) → spawn npm run dev
 *   7. 4s 后自动打开浏览器 7788
 *   8. 父进程 SIGINT/SIGTERM → kill 两组子进程 (opencode + webpack)
 *
 * 命令行 flag (覆盖默认端口):
 *   --server-port <n>    opencode 端口 (默认 24096)
 *   --web-port <n>       webpack 端口 (默认 7788)
 *
 * 设计: 单文件入口, 跨平台, 不依赖额外进程编排器.
 *   用户唯一前置 = Node ≥ 20. 其他 (web deps / opencode / chokidar-cli) dev.js 自检自装.
 *   npx tarball 装 numas, web deps 走 web/ 一次性 install, opencode + chokidar-cli 走全局 npm i -g.
 *   进程树: dev.js → { opencode, webpack } (两个独立 detached 进程组).
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname);
const WEB = path.join(ROOT, 'web');

/** 跨平台 */
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

/** Node 版本检查 — 用户唯一前置条件是 Node ≥ 20 (LTS).
 *  process.versions.node 形如 '24.15.0' → parseInt('24.15.0') === 24
 */
function checkNodeVersion() {
  const major = parseInt(process.versions.node, 10);
  if (Number.isNaN(major) || major < 20) {
    console.error(`[numas] 需要 Node ≥ 20 (当前 v${process.versions.node})`);
    console.error('[numas] 安装: https://nodejs.org (推荐 LTS) 或 nvm install 20');
    process.exit(1);
  }
  console.log(`[numas] Node v${process.versions.node} ✓`);
}
checkNodeVersion();

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
/** opencode binary 解析: 优先 PATH 全局 (npm i -g 安装), 兜底 web local shim (兼容老环境) */
function resolveOpencodeBin() {
  if (whichCmd('opencode')) {
    const out = isWin ? spawnSync('where', ['opencode']) : spawnSync('which', ['opencode']);
    const p = String(out.stdout || '').split('\n')[0].trim();
    if (p) return p;
  }
  if (fs.existsSync(webOpencodeBin)) return webOpencodeBin;
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
 *  global=true: 全局 install (npm i -g), 不传 cwd, 用于 opencode 这种工具
 *  afterInstall: 装成功后回调 (写依赖 hash marker 等)
 */
function ensureInstalled(label, ready, installCmd, installArgs, cwd, opts = {}) {
  if (ready()) {
    console.log(`[numas] ${label} deps 已就绪 (复用)`);
    return;
  }
  console.log(`[numas] 首次运行, 装 ${label}${opts.global ? ' (全局)' : ''} ...`);
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(installCmd, installArgs, opts.global
      ? { stdio: 'inherit', shell: isWin }
      : { cwd, stdio: 'inherit', shell: isWin });
    if (r.status === 0) break;
    if (attempt < 3) console.warn(`[numas] ${label} 安装失败 (尝试 ${attempt}/3), 3s 后重试...`);
    if (attempt < 3) spawnSync(isWin ? 'powershell' : 'sleep', isWin
      ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3']
      : ['3']);
  }
  if (r.status !== 0) {
    console.error(`[numas] ${label} 安装失败 (status=${r.status})`);
    if (opts.global) {
      console.error(`[numas] 手动: ${installCmd} ${installArgs.join(' ')}`);
      console.error(`[numas] 系统 node 可能需 sudo, 或配置 npm prefix 到用户目录: npm config set prefix ~/.npm-global`);
    } else {
      console.error(`[numas] 手动: cd ${cwd} && ${installCmd} ${installArgs.join(' ')}`);
    }
    process.exit(1);
  }
  opts.afterInstall?.();
}

/** web deps 依赖声明 hash (package.json + package-lock.json) — 对比 node_modules/.numas-deps-hash,
 *  一致则依赖与上次安装时完全相同, 跳过 install 直接跑 */
const depsMarker = path.join(WEB, 'node_modules', '.numas-deps-hash');
function depsHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    try { h.update(fs.readFileSync(path.join(WEB, f))); } catch { h.update(f); }
  }
  return h.digest('hex');
}
function depsReady() {
  if (!fs.existsSync(webWebpackBin)) return false;
  if (!fs.existsSync(depsMarker)) {
    // 老环境 (无 marker, 升级前装的): bin 已就绪 → 补写 marker 视为就绪, 避免升级后首次重复 install
    try { fs.writeFileSync(depsMarker, depsHash()); } catch { /* */ }
    return true;
  }
  try { return fs.readFileSync(depsMarker, 'utf8').trim() === depsHash(); } catch { return false; }
}

// 1. web deps (react + codeblitz + webpack)
//   ready: webpack bin 存在 + 依赖 hash marker 一致 (package.json/lock 变更 → 重装)
//   --ignore-scripts: 跳过 spdlog 等 native postinstall (Python 3.14 没 distutils 必崩)
//   afterInstall: 写 marker, 下次同版本跳过 install 直接跑
ensureInstalled(
  'web',
  depsReady,
  npmCmd,
  ['install', '--include=dev', '--prefer-offline', '--ignore-scripts'],
  WEB,
  { afterInstall: () => { try { fs.writeFileSync(depsMarker, depsHash()); } catch { /* */ } } },
);
// 2. opencode (opencode-ai 提供二进制, 全局装到 PATH 让 opencode 命令随时可用)
ensureInstalled(
  'opencode',
  () => !!resolveOpencodeBin(),
  npmCmd,
  ['install', '-g', '--prefer-offline', '--ignore-scripts', 'opencode-ai'],
  WEB,
  { global: true },
);
const opencodeBin = resolveOpencodeBin();
if (!opencodeBin) {
  console.error('[numas] opencode 装上但找不到 binary, 检查 PATH 和 web/node_modules');
  process.exit(1);
}
// 3. watchexec (fs watcher PTY 依赖 — opencode pty 子进程里 node FSEvents 必炸 (EMFILE),
//    watchexec Rust 实现实测正常且覆盖轮询盲区; 按平台安装)
//
//    macOS: brew (标准)
//    Linux: apt-get (Debian/Ubuntu); root 时不加 sudo, 非 root 加 sudo
//    Windows: PowerShell 一条龙 — Invoke-RestMethod 查 GitHub API → Invoke-WebRequest 下 zip →
//      Expand-Archive → 复制到 %LOCALAPPDATA%\numas\bin\watchexec.exe → setx 写用户 PATH
//      (winget --id watchexec.watchexec 在很多环境查不到 — 仓库 ID 改名 / winget 源未同步;
//       改用直下更可控, 且 PowerShell 是 Windows 内置, 零额外依赖)
function installWatchexecCmd() {
  if (process.platform === 'darwin') return ['brew', ['install', 'watchexec']];
  if (process.platform === 'win32') {
    // Windows 走 PowerShell 一条龙 (内含 GitHub API 查询+下载+解压+setx), 同步阻塞
    installWatchexecWindows();
    return ['cmd', ['/c', 'echo', 'watchexec installed']];
  }
  // linux: 优先 apt (Debian/Ubuntu), 兜底 cargo
  return ['apt-get', ['install', '-y', 'watchexec']];
}

/** Windows: PowerShell 一条龙装 watchexec (GitHub release → 直下 zip → 解压 → setx PATH)
 *  失败抛错, 由 ensureInstalled 的 status=1 兜底提示 */
function installWatchexecWindows() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binDir = path.join(localAppData, 'numas', 'bin');
  const exePath = path.join(binDir, 'watchexec.exe');
  if (fs.existsSync(exePath)) {
    console.log(`[numas] watchexec 已存在 (复用) → ${exePath}`);
    return;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  // 资产名带版本号: watchexec-<ver>-<arch>-pc-windows-msvc.zip (ver = tag 去掉 'v' 前缀).
  // 旧代码拼成 watchexec-<arch>-...zip 漏了版本号, GitHub release 无此文件 → 404 Not Found.
  // PowerShell: 1) GitHub API 查 latest tag → 2) 下载 zip 到 bin 目录 → 3) 解压 → 4) setx PATH
  //   Invoke-RestMethod 解析 GitHub JSON (tag_name), Invoke-WebRequest 下载, Expand-Archive 解压
  const script = `
$ErrorActionPreference = 'Stop'
$tag = (Invoke-RestMethod -Uri 'https://api.github.com/repos/watchexec/watchexec/releases/latest' -Headers @{ 'User-Agent' = 'numas-dev'; 'Accept' = 'application/vnd.github+json' }).tag_name
if (-not $tag) { throw 'GitHub API 未返回 tag_name' }
$ver = $tag.TrimStart('v')
$arch = ${JSON.stringify(arch)}
$asset = "watchexec-$ver-$arch-pc-windows-msvc.zip"
$url = "https://github.com/watchexec/watchexec/releases/download/$tag/$asset"
$binDir = ${JSON.stringify(binDir)}
$zipPath = Join-Path $binDir $asset
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Write-Host "[numas] watchexec (Windows) 下载 ${asset} ($tag) ..."
Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
$extractDir = Join-Path $binDir "_extract_tmp"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
$src = Get-ChildItem -Path $extractDir -Recurse -Filter 'watchexec.exe' | Select-Object -First 1
if (-not $src) { throw '解压后未找到 watchexec.exe' }
Copy-Item -Path $src.FullName -Destination (Join-Path $binDir 'watchexec.exe') -Force
Remove-Item $zipPath -Force
Remove-Item $extractDir -Recurse -Force
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*${binDir}*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Host '[numas] 已将 bin 目录写入用户 PATH (新开 cmd 生效)'
} else {
  Write-Host '[numas] 用户 PATH 已包含 bin 目录 (复用)'
}
Write-Host "[numas] watchexec 装到 $binDir\\watchexec.exe"
`.trim();
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`PowerShell 安装失败 (status=${r.status})`);
  }
}

/** Windows: 把 %LOCALAPPDATA%\numas\bin 注入到 process.env.PATH 前部 (本进程 + 子进程继承) */
function prependWindowsBinToPath() {
  if (process.platform !== 'win32') return;
  const binDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'numas', 'bin');
  if (!fs.existsSync(path.join(binDir, 'watchexec.exe'))) return;
  const sep = path.delimiter; // Windows ;
  if (!(process.env.PATH || '').split(sep).some((p) => p.toLowerCase() === binDir.toLowerCase())) {
    process.env.PATH = `${binDir}${sep}${process.env.PATH || ''}`;
  }
}

ensureInstalled(
  'watchexec',
  () => whichCmd('watchexec'),
  ...(() => {
    const [cmd, args] = installWatchexecCmd();
    // apt-get 需要 sudo; cargo 兜底提示走 ensureInstalled 的失败分支
    return [cmd === 'apt-get' && process.getuid?.() !== 0 ? 'sudo' : cmd, cmd === 'apt-get' && process.getuid?.() !== 0 ? ['apt-get', ...args] : args];
  })(),
  WEB,
  { global: true },
);

// 3.1 Windows: 把刚装好的 watchexec.exe 注入 PATH (让 whichCmd / 子进程能找到)
prependWindowsBinToPath();

// 3. 端口冲突清理 (上轮跑剩的 zombie, 避免 listen EADDRINUSE)
//    macOS BSD lsof 必须用 `-ti :PORT` (带冒号), Linux 用 `-ti :PORT` 也 OK
function killPort(port) {
  try {
    const out = spawnSync('lsof', ['-ti', `:${port}`]);
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
