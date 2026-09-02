#!/usr/bin/env node
/**
 * numas dev.js (集成模式) — npx 入口
 *
 * 流程 (3 步):
 *   1. sumi build (hash 增量) → mirror cp → opencode/packages/app/dist
 *   2. opencode build (hash 增量 + NUMAS_WEB_DIST=sumi/dist)
 *   3. 启 opencode web @ <port> --cors * --registry <url>
 *
 * CLI: --port / --registry / --fast (跳过 build/cp) / --force-build
 * 进程树: dev.js → opencode web (detached pgid=-pid), SIGINT 杀整组
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const SUMI = path.join(ROOT, 'sumi');
const OPENCODE_PKG = path.join(ROOT, 'opencode', 'packages', 'opencode');
const OPENCODE_APP_DIST = path.join(ROOT, 'opencode', 'packages', 'app', 'dist');

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const bunCmd = isWin ? 'bun.cmd' : 'bun';

function platformTag() {
  const osMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  return `${osMap[process.platform] || process.platform}-${process.arch}`;
}
const PLATFORM_TAG = platformTag();
const OPENCODE_BIN_REL = `dist/opencode-${PLATFORM_TAG}/bin/opencode`;
const OPENCODE_BIN = path.join(OPENCODE_PKG, OPENCODE_BIN_REL);
const OPENCODE_BIN_WIN = OPENCODE_BIN + '.exe';

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
const PORT = parseFlagInt('--port', parseInt(process.env.NUMAS_PORT || '24096', 10));
const REGISTRY = parseFlag('--registry', process.env.NUMAS_REGISTRY || 'http://127.0.0.1:7790');
const FORCE_BUILD = process.argv.includes('--force-build');
const FAST = process.argv.includes('--fast') || process.env.NUMAS_FAST === '1' || process.env.NUMAS_FAST === 'true';

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

// ============================================================================
// 1. sumi build → mirror cp → opencode/packages/app/dist
// ============================================================================
const sumiDist = path.join(SUMI, 'dist');
const sumiBuildMarker = path.join(sumiDist, '.numas-sumi-build-hash');

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
  try { return fs.readFileSync(sumiBuildMarker, 'utf8').trim() === sumiBuildHash(); } catch { return false; }
}

// ============================================================================
// 0. 清理占用端口 / 残留 opencode 进程
//    必须在 build 之前: Windows 上产物 exe 被运行中进程占用时无法删除 (rm 会报 Operation not permitted)
// ============================================================================
killPort(PORT);
killOpenCodeProcesses();

console.log(`[numas] step 1/3: sumi build (cwd=${SUMI})`);
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

console.log(`[numas] step 1.5: mirror sumi/dist → opencode/packages/app/dist`);
function mirrorDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
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
  const toDelete = [];
  for (const [rel, dstPath] of dstSet) {
    if (!srcSet.has(rel)) toDelete.push(dstPath);
  }
  toDelete.sort((a, b) => b.length - a.length);
  for (const p of toDelete) {
    try { fs.unlinkSync(p); } catch { /* */ }
  }
  console.log(`[numas]   mirror: cp ${copied}, 跳过 ${skipped}, 删 ${toDelete.length}`);
}
if (FAST) {
  console.log('[numas] --fast: 跳过 cp (opencode binary 内嵌的仍是上次 dist)');
} else {
  mirrorDir(sumiDist, OPENCODE_APP_DIST);
}

// ============================================================================
// 2. opencode build (NUMAS_WEB_DIST=sumi/dist 内嵌)
// ============================================================================
const modelsApiFixture = path.join(OPENCODE_PKG, 'test', 'tool', 'fixtures', 'models-api.json');
const opencodeBuildMarker = path.join(OPENCODE_PKG, 'dist', '.numas-opencode-build-hash');

function opencodeBuildHash() {
  const h = crypto.createHash('sha256');
  // opencode binary 编译整个 workspace (core/server/protocol/schema/...), 不是只编译 packages/opencode
  // hash 范围 = opencode/packages/* 全部源码 (walkSrc 自动跳过 node_modules/dist/.git)
  const packagesDir = path.join(ROOT, 'opencode', 'packages');
  const roots = [];
  let entries;
  try { entries = fs.readdirSync(packagesDir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    roots.push(path.join(packagesDir, e.name));
  }
  if (!roots.length) roots.push(OPENCODE_PKG);
  for (const root of roots) {
    for (const f of walkSrc(root)) {
      try { h.update(fs.readFileSync(f)); } catch { /* */ }
    }
  }
  h.update(sumiBuildHash());
  return h.digest('hex');
}
function opencodeBuildUpToDate() {
  if (FORCE_BUILD) return false;
  if (!fs.existsSync(OPENCODE_BIN) && !fs.existsSync(OPENCODE_BIN_WIN)) return false;
  if (!fs.existsSync(opencodeBuildMarker)) return false;
  try { return fs.readFileSync(opencodeBuildMarker, 'utf8').trim() === opencodeBuildHash(); } catch { return false; }
}

console.log(`[numas] step 2/3: opencode build (cwd=${OPENCODE_PKG})`);
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

// ============================================================================
// 3. 启 opencode web @ <port> --cors * --registry <url>
// ============================================================================
function killPort(port) {
  try {
    let pids = [];
    if (isWin) {
      // Windows: netstat -ano 找监听端口的 PID
      const out = spawnSync('netstat', ['-ano']);
      const lines = String(out.stdout || '').split('\n');
      for (const line of lines) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && m[1].endsWith(`:${port}`) && /LISTENING/i.test(m[3])) {
          const pid = parseInt(m[4], 10);
          if (pid && !pids.includes(pid)) pids.push(pid);
        }
      }
    } else {
      // mac/linux: lsof -ti :port
      const out = spawnSync('lsof', ['-ti', `:${port}`]);
      pids = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
    }
    for (const pid of pids) {
      if (pid === process.pid) continue; // 别杀掉自己
      try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
    }
    if (pids.length) console.log(`[numas] 清理端口 ${port} (${pids.length} 个 pid)`);
  } catch { /* ignore */ }
}

function killOpenCodeProcesses() {
  try {
    if (isWin) {
      const r = spawnSync('taskkill', ['/F', '/IM', 'opencode.exe', '/T']);
      if (r.status === 0) console.log('[numas] 已清理残留 opencode.exe 进程');
    } else {
      const r = spawnSync('pkill', ['-x', 'opencode']);
      if (r.status === 0) console.log('[numas] 已清理残留 opencode 进程');
    }
  } catch { /* ignore */ }
}
console.log(`[numas] step 3/3: 启 opencode web (hostname=0.0.0.0, port=${PORT}, cors=*, registry=${REGISTRY})`);
killPort(PORT);

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

// 自动开浏览器由 opencode web 命令内置 (1500ms 后 spawn /bin/sh -c "open $url &"),
// dev.js 不重复, 避免多次 spawn opener 导致多个 tab.
