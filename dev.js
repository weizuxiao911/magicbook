#!/usr/bin/env node
/**
 * numas dev.js (集成模式) — 根目录 dev 启动入口 (= npx bin 入口)
 *
 * 仓库根 package.json#bin = "./dev.js", `npx github:user/repo` 调此文件.
 *   启动 = 整个 numas IDE (sumi/opencode 二合一), 一行命令.
 *
 * 架构 (集成模式):
 *   sumi/ (webpack 客户端 IDE) + opencode/ (go-style bun 单文件服务)
 *   dev.js 编排: sumi build → cp 到 opencode/packages/app/dist → rebuild opencode (内嵌 sumi dist) → 启 opencode web.
 *   浏览器打开 4096 → opencode serve 内嵌的 numas IDE.
 *
 * 流程:
 *   0. Node 版本检查 (≥ 20, 用户唯一前置)
 *   1. sumi deps 完整性 (sumi/node_modules/.bin/webpack + 依赖 hash marker) → npm install
 *   2. opencode 全局 binary (PATH 全局 npm i -g opencode-ai)
 *   3. watchexec (fs watcher PTY 依赖) → brew / apt / PowerShell
 *   4. killPort(4096) 清理 zombie
 *   5. sumi build (hash 增量) → sumi/dist
 *   6. cp -r sumi/dist → opencode/packages/app/dist (替换官方 UI)
 *   7. opencode build (hash 增量 + NUMAS_WEB_DIST=.../sumi/dist) → 嵌入 sumi 的新二进制
 *   8. 启新 opencode web @ 4096 + --cors * + --registry 7790
 *   9. 4s 后自动开浏览器 → http://localhost:4096
 *  10. SIGINT/SIGTERM cleanup (杀整组)
 *
 * 命令行 flag:
 *   --port <n>        opencode web 端口 (默认 4096)
 *   --registry <url>  vsix registry 地址 (默认 http://127.0.0.1:7790)
 *   --force-build     强制重 build (sumi + opencode), 忽略 hash 缓存
 *
 * 设计: 单文件入口, 跨平台, 不依赖额外进程编排器.
 *   用户唯一前置 = Node ≥ 20. 其他 (sumi deps / opencode / watchexec) dev.js 自检自装.
 *   进程树: dev.js → opencode web (独立 detached 进程组, pgid=-pid).
 *   registry 7790 由用户手动启 (numas/registry/), 集成模式不自动启.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname);
const SUMI = path.join(ROOT, 'sumi');
const OPENCODE = path.join(ROOT, 'opencode');
const OPENCODE_PKG = path.join(OPENCODE, 'packages', 'opencode');
const OPENCODE_APP_DIST = path.join(OPENCODE, 'packages', 'app', 'dist');

/** 跨平台 */
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const bunCmd = isWin ? 'bun.cmd' : 'bun';

/** 平台标识 (opencode binary 输出目录: opencode-<os>-<arch>) */
function platformTag() {
  const osMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  return `${osMap[process.platform] || process.platform}-${process.arch}`;
}
const PLATFORM_TAG = platformTag();
const OPENCODE_BIN_REL = `dist/opencode-${PLATFORM_TAG}/bin/opencode`;
const OPENCODE_BIN = path.join(OPENCODE_PKG, OPENCODE_BIN_REL);
const OPENCODE_BIN_WIN = OPENCODE_BIN + '.exe';

// ----------------------------------------------------------------------------
// 0. Node 版本检查
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 命令行 flag
// ----------------------------------------------------------------------------
function parseFlag(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
function parseFlagInt(flag, fallback) {
  const v = parseFlag(flag, null);
  if (v != null) {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}
const PORT = parseFlagInt('--port', parseInt(process.env.NUMAS_PORT || '4096', 10));
const REGISTRY = parseFlag('--registry', process.env.NUMAS_REGISTRY || 'http://127.0.0.1:7790');
const FORCE_BUILD = process.argv.includes('--force-build');
const FAST = process.argv.includes('--fast') || process.env.NUMAS_FAST === '1' || process.env.NUMAS_FAST === 'true';

/** 跨平台 which */
function whichCmd(cmd) {
  const probe = isWin ? spawnSync('where', [cmd]) : spawnSync('which', [cmd]);
  return probe.status === 0;
}

// ----------------------------------------------------------------------------
// 1. 通用: 检查 + 自装 (跨平台, --ignore-scripts 跳过 spdlog native postinstall)
//    global=true: 全局 install (npm i -g)
//    afterInstall: 装成功后回调 (写 hash marker 等)
// ----------------------------------------------------------------------------
function ensureInstalled(label, ready, installCmd, installArgs, cwd, opts = {}) {
  if (ready()) {
    console.log(`[numas] ${label} 已就绪 (复用)`);
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

// ----------------------------------------------------------------------------
// 2. sumi deps: webpack bin + 依赖 hash marker
// ----------------------------------------------------------------------------
const sumiWebpackBin = path.join(SUMI, 'node_modules', '.bin', isWin ? 'webpack.cmd' : 'webpack');
const sumiDepsMarker = path.join(SUMI, 'node_modules', '.numas-deps-hash');
function sumiDepsHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    try { h.update(fs.readFileSync(path.join(SUMI, f))); } catch { h.update(f); }
  }
  return h.digest('hex');
}
function sumiDepsReady() {
  if (!fs.existsSync(sumiWebpackBin)) return false;
  if (!fs.existsSync(sumiDepsMarker)) {
    try { fs.writeFileSync(sumiDepsMarker, sumiDepsHash()); } catch { /* */ }
    return true;
  }
  try { return fs.readFileSync(sumiDepsMarker, 'utf8').trim() === sumiDepsHash(); } catch { return false; }
}

ensureInstalled(
  'sumi',
  sumiDepsReady,
  npmCmd,
  ['install', '--include=dev', '--prefer-offline', '--ignore-scripts'],
  SUMI,
  { afterInstall: () => { try { fs.writeFileSync(sumiDepsMarker, sumiDepsHash()); } catch { /* */ } } },
);

// ----------------------------------------------------------------------------
// 3. opencode 全局 binary (opencode-ai)
// ----------------------------------------------------------------------------
const webOpencodeBin = path.join(SUMI, 'node_modules', '.bin', isWin ? 'opencode.cmd' : 'opencode');
function resolveOpencodeBin() {
  if (whichCmd('opencode')) {
    const out = isWin ? spawnSync('where', ['opencode']) : spawnSync('which', ['opencode']);
    const p = String(out.stdout || '').split('\n')[0].trim();
    if (p) return p;
  }
  if (fs.existsSync(webOpencodeBin)) return webOpencodeBin;
  return null;
}

ensureInstalled(
  'opencode',
  () => !!resolveOpencodeBin(),
  npmCmd,
  ['install', '-g', '--prefer-offline', '--ignore-scripts', 'opencode-ai'],
  SUMI,
  { global: true },
);
const opencodeBin = resolveOpencodeBin();
if (!opencodeBin) {
  console.error('[numas] opencode 装上但找不到 binary, 检查 PATH 和 sumi/node_modules');
  process.exit(1);
}
console.log(`[numas] opencode: ${opencodeBin}`);

// ----------------------------------------------------------------------------
// 4. watchexec (fs watcher PTY 依赖 — opencode pty 子进程里 node FSEvents 必炸)
// ----------------------------------------------------------------------------
function installWatchexecCmd() {
  if (process.platform === 'darwin') return ['brew', ['install', 'watchexec']];
  if (process.platform === 'win32') return ['cmd', ['/c', 'echo', 'watchexec install skipped (Linux/Mac only)']];
  return ['apt-get', ['install', '-y', 'watchexec']];
}

function installWatchexecWindows() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binDir = path.join(localAppData, 'numas', 'bin');
  const exePath = path.join(binDir, 'watchexec.exe');
  if (fs.existsSync(exePath)) {
    console.log(`[numas] watchexec 已存在 (复用) → ${exePath}`);
    return;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const script = `
$ErrorActionPreference = 'Stop'
$binDir = $env:NUMAS_BINDIR
$arch   = $env:NUMAS_ARCH
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/watchexec/watchexec/releases/latest' -Headers @{ 'User-Agent' = 'numas-dev'; 'Accept' = 'application/vnd.github+json' }
$tag = $release.tag_name
if (-not $tag) { throw 'GitHub API 未返回 tag_name' }
$assetObj = $release.assets | Where-Object { $_.name -like ("*" + $arch + "-pc-windows-msvc.zip") -and $_.name -notlike "*.sha*" -and $_.name -notlike "*.b3" } | Select-Object -First 1
if (-not $assetObj) { throw "未找到 " + $arch + " windows asset" }
$url = $assetObj.browser_download_url
$asset = $assetObj.name
$zipPath = Join-Path $binDir $asset
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Write-Host "[numas] watchexec (Windows) 下载 $asset ($tag) ..."
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
if ($userPath -notlike ("*" + $binDir + "*")) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
}
Write-Host "[numas] watchexec 装到 $binDir\\watchexec.exe"
`.trim();
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    stdio: 'inherit',
    env: { ...process.env, NUMAS_BINDIR: binDir, NUMAS_ARCH: arch },
  });
  if (r.status !== 0) throw new Error(`PowerShell 安装失败 (status=${r.status})`);
}

ensureInstalled(
  'watchexec',
  () => whichCmd('watchexec'),
  ...(() => {
    if (process.platform === 'win32') {
      try { installWatchexecWindows(); } catch { /* swallow, let --force re-trigger */ }
      return ['cmd', ['/c', 'echo', 'watchexec check']];
    }
    const [cmd, args] = installWatchexecCmd();
    return [cmd === 'apt-get' && process.getuid?.() !== 0 ? 'sudo' : cmd,
            cmd === 'apt-get' && process.getuid?.() !== 0 ? ['apt-get', ...args] : args];
  })(),
  SUMI,
  { global: true },
);

function prependWindowsBinToPath() {
  if (process.platform !== 'win32') return;
  const binDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'numas', 'bin');
  if (!fs.existsSync(path.join(binDir, 'watchexec.exe'))) return;
  const sep = path.delimiter;
  if (!(process.env.PATH || '').split(sep).some((p) => p.toLowerCase() === binDir.toLowerCase())) {
    process.env.PATH = `${binDir}${sep}${process.env.PATH || ''}`;
  }
}
prependWindowsBinToPath();

// ----------------------------------------------------------------------------
// 5. killPort 清理 zombie
// ----------------------------------------------------------------------------
function killPort(port) {
  try {
    const out = spawnSync('lsof', ['-ti', `:${port}`]);
    const pids = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* */ }
    }
    if (pids.length) console.log(`[numas] 清理端口 ${port} (${pids.length} 个 pid)`);
  } catch { /* ignore */ }
}
console.log(`[numas] 清理端口 ${PORT} ...`);
killPort(PORT);

// ----------------------------------------------------------------------------
// 6. sumi build (hash 增量)
//    hash = sha256( package.json + lock + src/** + webpack.config.js + scripts/** )
// ----------------------------------------------------------------------------
const sumiDist = path.join(SUMI, 'dist');
const sumiBuildMarker = path.join(sumiDist, '.numas-sumi-build-hash');

function walkSrc(root) {
  const out = [];
  function recur(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recur(p);
      else out.push(p);
    }
  }
  recur(root);
  return out;
}
function sumiBuildHash() {
  const h = crypto.createHash('sha256');
  for (const f of ['package.json', 'package-lock.json', 'webpack.config.js', 'tsconfig.json']) {
    try { h.update(fs.readFileSync(path.join(SUMI, f))); } catch { h.update(f); }
  }
  for (const f of walkSrc(SUMI)) {
    try { h.update(fs.readFileSync(f)); } catch { /* */ }
  }
  return h.digest('hex');
}
function sumiBuildUpToDate() {
  if (FORCE_BUILD) return false;
  if (!fs.existsSync(sumiBuildMarker)) return false;
  try {
    return fs.readFileSync(sumiBuildMarker, 'utf8').trim() === sumiBuildHash();
  } catch { return false; }
}

console.log(`[numas] sumi build (cwd=${SUMI}) ...`);
if (FAST) {
  console.log('[numas] --fast: 跳过 sumi build (复用 dist)');
} else if (sumiBuildUpToDate()) {
  console.log('[numas] sumi 源码未变, 跳过 build (复用 dist)');
} else {
  const t0 = Date.now();
  const r = spawnSync(npmCmd, ['run', 'build'], { cwd: SUMI, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`[numas] sumi build 失败 (status=${r.status})`);
    process.exit(1);
  }
  console.log(`[numas] sumi build 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  try { fs.writeFileSync(sumiBuildMarker, sumiBuildHash()); } catch { /* */ }
}

if (!fs.existsSync(path.join(sumiDist, 'index.html'))) {
  console.error(`[numas] sumi build 产物缺 index.html: ${sumiDist}`);
  console.error('[numas] 提示: 首次启动或 --fast 但没产物, 去掉 --fast 或加 --force-build');
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 7. cp sumi/dist → opencode/packages/app/dist (替换官方 UI)
//    增量 mirror: 比 mtime+size, 只 cp 变化文件; dst 独有文件删 (避免 webpack
//    旧 hash 文件名残留). 复用场景下 86M 全量 cp → 几乎 0 cp.
// ----------------------------------------------------------------------------
console.log(`[numas] 复制 sumi/dist → opencode/packages/app/dist (替换官方 UI)`);
function mirrorDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  // 收集 src 文件 { rel: { srcPath, mtimeMs, size } }
  const srcSet = new Map();
  function collect(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p, r);
      else {
        const st = fs.statSync(p);
        srcSet.set(r, { srcPath: p, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  collect(src, '');
  // 收集 dst 已有文件 (含子目录)
  const dstSet = new Map();
  function collectDst(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collectDst(p, r);
      else dstSet.set(r, p);
    }
  }
  collectDst(dst, '');
  // cp 变更文件 (mtime+size 一致跳过)
  let copied = 0, skipped = 0;
  for (const [rel, { srcPath, mtimeMs, size }] of srcSet) {
    const dstPath = path.join(dst, rel);
    let dstStat = null;
    try { dstStat = fs.statSync(dstPath); } catch { /* */ }
    if (dstStat && dstStat.mtimeMs >= mtimeMs && dstStat.size === size) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    copied++;
  }
  // 删 dst 多余文件 (深层先删, 避免空目录残留)
  const toDelete = [];
  for (const [rel, dstPath] of dstSet) {
    if (!srcSet.has(rel)) toDelete.push(dstPath);
  }
  toDelete.sort((a, b) => b.length - a.length);
  for (const p of toDelete) {
    try { fs.unlinkSync(p); } catch { /* */ }
  }
  console.log(`[numas]   mirror: cp ${copied}, 跳过 ${skipped}, 删 ${toDelete.length} → ${dst}`);
}
if (FAST) {
  console.log('[numas] --fast: 跳过 cp (opencode binary 内嵌的仍是上次 dist)');
} else {
  mirrorDir(sumiDist, OPENCODE_APP_DIST);
}

// ----------------------------------------------------------------------------
// 8. opencode build (hash 增量 + NUMAS_WEB_DIST=.../sumi/dist 嵌入)
//    hash = sha256( opencode/packages/opencode/src/** + script/** + sumi dist 内 hash marker )
//    产物: opencode/packages/opencode/dist/opencode-<platform>/bin/opencode
// ----------------------------------------------------------------------------
const modelsApiFixture = path.join(OPENCODE_PKG, 'test', 'tool', 'fixtures', 'models-api.json');
const opencodeBuildMarker = path.join(OPENCODE_PKG, 'dist', '.numas-opencode-build-hash');

function opencodeBuildHash() {
  const h = crypto.createHash('sha256');
  // opencode 关键源码
  for (const root of [
    path.join(OPENCODE_PKG, 'src'),
    path.join(OPENCODE_PKG, 'script'),
  ]) {
    for (const f of walkSrc(root)) {
      try { h.update(fs.readFileSync(f)); } catch { /* */ }
    }
  }
  // NUMAS_WEB_DIST 指向的 sumi/dist hash (跟上一步的 sumi build hash 一致即可)
  h.update(sumiBuildHash());
  return h.digest('hex');
}
function opencodeBuildUpToDate() {
  if (FORCE_BUILD) return false;
  if (!fs.existsSync(OPENCODE_BIN) && !fs.existsSync(OPENCODE_BIN_WIN)) return false;
  if (!fs.existsSync(opencodeBuildMarker)) return false;
  try {
    return fs.readFileSync(opencodeBuildMarker, 'utf8').trim() === opencodeBuildHash();
  } catch { return false; }
}

console.log(`[numas] opencode build (cwd=${OPENCODE_PKG}, NUMAS_WEB_DIST=${sumiDist}) ...`);
if (FAST) {
  console.log('[numas] --fast: 跳过 opencode build (复用二进制)');
} else if (opencodeBuildUpToDate()) {
  console.log('[numas] opencode 源码 + sumi dist 未变, 跳过 build (复用二进制)');
} else {
  const t0 = Date.now();
  const env = {
    ...process.env,
    NUMAS_WEB_DIST: sumiDist,
    MODELS_DEV_API_JSON: modelsApiFixture,
  };
  const r = spawnSync(bunCmd, ['run', 'script/build.ts', '--single', '--skip-install'], {
    cwd: OPENCODE_PKG,
    stdio: 'inherit',
    shell: isWin,
    env,
  });
  if (r.status !== 0) {
    console.error(`[numas] opencode build 失败 (status=${r.status})`);
    process.exit(1);
  }
  console.log(`[numas] opencode build 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  try { fs.writeFileSync(opencodeBuildMarker, opencodeBuildHash()); } catch { /* */ }
}

const finalBin = fs.existsSync(OPENCODE_BIN) ? OPENCODE_BIN : OPENCODE_BIN_WIN;
if (!fs.existsSync(finalBin)) {
  console.error(`[numas] 找不到 opencode binary: ${finalBin}`);
  console.error('[numas] 提示: 首次启动或 --fast 但没产物, 去掉 --fast 或加 --force-build');
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 9. 启 opencode web (用刚 build 的二进制, 含内嵌 sumi)
// ----------------------------------------------------------------------------
console.log(`[numas] 启动 opencode web (port=${PORT}, cors=*, registry=${REGISTRY})`);
console.log(`[numas]   bin: ${finalBin}`);
const opencodeProc = spawn(finalBin, [
  'web',
  '--hostname', '0.0.0.0',
  '--port', String(PORT),
  '--cors', '*',
  '--registry', REGISTRY,
], {
  stdio: 'inherit',
  detached: true,
  shell: false,
});
if (!opencodeProc.pid) {
  console.error('[numas] opencode 启动失败 (no pid)');
  process.exit(1);
}
opencodeProc.on('error', (e) => console.warn('[numas] opencode spawn error:', e.message));
opencodeProc.on('exit', (code, sig) => {
  if (code !== 0 || sig) console.error(`[numas] opencode 异常退出 (code=${code}, signal=${sig})`);
});
console.log(`[numas] opencode pid=${opencodeProc.pid} (group=${opencodeProc.pid})`);

// ----------------------------------------------------------------------------
// 10. cleanup + 自动开浏览器
// ----------------------------------------------------------------------------
const cleanup = (signal) => {
  console.log(`[numas] cleanup (${signal || 'exit'}) → kill opencode`);
  try { process.kill(-opencodeProc.pid, signal || 'SIGTERM'); } catch { /* */ }
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT',  () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('exit',    () => {
  try { process.kill(-opencodeProc.pid, 'SIGTERM'); } catch { /* */ }
});

const browserUrl = `http://localhost:${PORT}`;
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
