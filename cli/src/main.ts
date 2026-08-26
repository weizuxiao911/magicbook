/**
 * cli — opencode + codeblitz 容器入口
 *
 * 启动方式:
 *   npx tsx cli web   启动 client (webpack-dev-server) + opencode serve (HMR 生效)
 *   npx tsx cli serve 只启动 opencode serve (无 client)
 *
 * 职责:
 *   1. 子命令路由: web 拉起 opencode + client 两个子进程; serve 只拉 opencode
 *   2. 透传 opencode serve CLI 选项（端口/主机/CORS 等, 仅 web/serve 后的参数）
 *   3. 整进程组管理子进程（SIGINT/SIGTERM → 杀整组, 避免逃逸）
 *   4. 启动前清理上一次残留（同端口, 避免 Address already in use）
 *   5. 漂亮日志（统一前缀 + 子进程 stdout/stderr 直通 + 子进程退出码透传）
 *
 * 设计依据: 原 sandbox 服务以 tsx 运行为主, 现仅保留 opencode serve 调度 + 客户端拉起,
 *   client → opencode 直连无中间代理（见 AGENTS.md）.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---- 解析子命令 ----
const args = process.argv.slice(2);
const subcommand = args[0];
const restArgs = (subcommand === 'web' || subcommand === 'serve') ? args.slice(1) : args;

type Mode = 'web' | 'serve';

const mode: Mode = (() => {
  if (subcommand === 'web') return 'web';
  if (subcommand === 'serve') return 'serve';
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') return 'help';
  return 'web'; // 默认 web: 一次起 client + opencode
})();

if (mode === 'help' || args.includes('--help') || args.includes('-h')) {
  console.log(`cli — opencode + codeblitz 容器

用法:
  npx tsx cli web   启动 client (webpack-dev-server) + opencode serve
  npx tsx cli serve 只启动 opencode serve

未识别参数透传给 opencode serve（仅识别 --help/-h/help）.

示例:
  npx tsx cli web --port 24096 --hostname 127.0.0.1 --cors http://127.0.0.1:7788
  npx tsx cli serve --port 24096 --hostname 127.0.0.1
`);
  process.exit(0);
}

const PORT = (() => {
  const i = restArgs.indexOf('--port');
  return i >= 0 && restArgs[i + 1] ? parseInt(restArgs[i + 1], 10) : 24096;
})();
const CLIENT_PORT = 7788;
const REGISTRY_PORT = 7790;

// ---- 启动前清理: 同端口的残留进程 ----
async function cleanupOrphans(): Promise<void> {
  await new Promise<void>((resolve) => {
    const cmd = `lsof -ti tcp:${PORT} 2>/dev/null | xargs -r kill -9; pgrep -f "opencode serve" | xargs -r kill -9 2>/dev/null`;
    spawn('sh', ['-c', cmd], { stdio: 'ignore' }).on('exit', () => resolve());
  });
  if (mode === 'web') {
    await new Promise<void>((resolve) => {
      const cmd = `lsof -ti tcp:${CLIENT_PORT} 2>/dev/null | xargs -r kill -9; pgrep -f "webpack-dev-server" | xargs -r kill -9 2>/dev/null`;
      spawn('sh', ['-c', cmd], { stdio: 'ignore' }).on('exit', () => resolve());
    });
    await new Promise<void>((resolve) => {
      const cmd = `lsof -ti tcp:${REGISTRY_PORT} 2>/dev/null | xargs -r kill -9; pgrep -f "registry-server\\|src/server.ts" | xargs -r kill -9 2>/dev/null`;
      spawn('sh', ['-c', cmd], { stdio: 'ignore' }).on('exit', () => resolve());
    });
  }
}

// ---- 子进程: opencode serve (优先 cli/node_modules/.bin/opencode, 兜底 PATH 里的 opencode) ----
function spawnOpencode(): ChildProcess {
  console.log(`[cli] 启动 opencode serve (透传参数: ${restArgs.join(' ') || '(无)'})...`);
  const localBin = join(__dirname, '..', 'node_modules', '.bin', 'opencode');
  let cmd: string;
  let cmdArgs: string[];
  if (existsSync(localBin)) {
    cmd = localBin;
    cmdArgs = ['serve', ...restArgs];
  } else if (spawnSync('which', ['opencode']).status === 0) {
    // PATH 有 opencode, 复用 (任意版本, 不锁)
    cmd = 'opencode';
    cmdArgs = ['serve', ...restArgs];
  } else {
    console.error('[cli] 找不到 opencode 二进制; 请安装 opencode-ai 或确保 opencode 在 PATH');
    process.exit(1);
  }
  const child = spawn(cmd, cmdArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: process.env,
  });
  pipeLines(child, 'opencode');
  return child;
}

// ---- 子进程: codeblitz web 前端 (webpack-dev-server) ----
function spawnClient(): ChildProcess {
  // main.ts 在 cli/src/, 兄弟目录 ../web 是 codeblitz 前端
  const webDir = resolve(__dirname, '../../web');
  console.log(`[cli] 启动 web (webpack-dev-server, cwd: ${webDir})...`);
  // 直接调 npm 走 web 的 dev 脚本（dev 内部是 webpack-dev-server）
  const child = spawn('npm', ['--prefix', webDir, 'run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: process.env,
  });
  pipeLines(child, 'web');
  return child;
}

// ---- 子进程: registry (vsix 扩展分发, 仅 web 模式需要) ----
function spawnRegistry(): ChildProcess {
  const registryDir = resolve(__dirname, '../../registry');
  console.log(`[cli] 启动 registry (:${REGISTRY_PORT}, cwd: ${registryDir})...`);
  // registry 走 node --experimental-strip-types (Node 22+ 内置 TS 支持), 跑 src/server.ts
  const child = spawn('node', [
    '--experimental-strip-types',
    'src/server.ts',
  ], {
    cwd: registryDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(REGISTRY_PORT) },
  });
  pipeLines(child, 'registry');
  return child;
}

// ---- stdout/stderr 透传（带前缀） ----
function pipeLines(child: ChildProcess, name: string): void {
  const prefix = `[${name}]`;
  const tag = (line: string): string => `${prefix} ${line}`;
  const out = createInterface({ input: child.stdout! });
  const err = createInterface({ input: child.stderr! });
  out.on('line', (l) => console.log(tag(l)));
  err.on('line', (l) => console.error(tag(l)));

  child.on('error', (e) => {
    console.error(`${prefix} spawn 失败:`, e.message);
    process.exit(1);
  });
}

// ---- 退出跟踪: 任一子进程退出 → 包装也退出 ----
function trackExit(child: ChildProcess, name: string, peers: ChildProcess[]): void {
  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[${name}] 子进程被信号终止: ${signal}`);
    } else {
      console.log(`[${name}] 子进程退出, code=${code}`);
    }
    // 兄弟进程: 一起带走（避免半挂状态）
    for (const p of peers) {
      try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* ignore */ }
    }
    process.exit(signal ? 1 : (code ?? 0));
  });
}

// ---- 整进程组清理: SIGINT/SIGTERM/SIGHUP → 杀所有子进程组 ----
function installSignalHandlers(children: ChildProcess[]): void {
  const killAll = (sig: NodeJS.Signals) => {
    console.log(`\n[cli] 收到 ${sig}, 清理所有子进程组...`);
    for (const child of children) {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try { child.kill(sig); } catch { /* ignore */ }
      }
    }
  };
  process.on('SIGINT', killAll);
  process.on('SIGTERM', killAll);
  process.on('SIGHUP', killAll);

  // 包装自身崩溃时也带走子进程组
  process.on('uncaughtException', (e) => {
    console.error('[cli] 未捕获异常:', e);
    killAll('SIGKILL');
  });
  process.on('unhandledRejection', (e) => {
    console.error('[cli] 未处理拒绝:', e);
    killAll('SIGKILL');
  });
}

// ---- 启动 ----
async function main(): Promise<void> {
  console.log(`[cli] mode: ${mode}`);
  console.log(`[cli] 启动前清理端口 ${PORT}${mode === 'web' ? ` + ${CLIENT_PORT} + ${REGISTRY_PORT}` : ''} 上的残留进程...`);
  await cleanupOrphans();

  const children: ChildProcess[] = [];
  const opencode = spawnOpencode();
  children.push(opencode);
  if (mode === 'web') {
    const web = spawnClient();
    children.push(web);
    const registry = spawnRegistry();
    children.push(registry);
  }

  // 每个子进程: 退出时带走其他兄弟（peers 闭包捕获时已排除自己）
  trackExit(opencode, 'opencode', mode === 'web' ? [children[1], children[2]] : []);
  if (mode === 'web') {
    trackExit(children[1], 'web', [opencode, children[2]]);
    trackExit(children[2], 'registry', [opencode, children[1]]);
  }

  installSignalHandlers(children);
}

main().catch((e) => {
  console.error('[cli] 启动失败:', e);
  process.exit(1);
});
