import { spawn, type ChildProcess } from 'node:child_process';
import { exec } from 'node:child_process';
import http from 'node:http';

const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || '24096');
let opencodeProc: ChildProcess | null = null;
let currentCwd: string | null = null;
let expectAlive = false;

/** 探活 opencode */
export function isAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 探测 opencode 实际 cwd（GET /path → directory）; 失败返回 null */
export function getOpencodeCwd(port: number = OPENCODE_PORT): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/path', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j?.directory || null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * 幂等确保 opencode 就绪（有 APP_CWD 时调用）:
 *  - opencode 活 且 实际 cwd === 目标 cwd → 保留（不重启）
 *  - 否则 → 重启（用目标 cwd 启动）
 */
export async function ensureOpencode(cwd: string): Promise<string> {
  const url = `http://127.0.0.1:${OPENCODE_PORT}`;
  if (await isAlive(OPENCODE_PORT)) {
    const actual = await getOpencodeCwd();
    if (actual === cwd) {
      return url; // cwd 匹配, 保留
    }
    console.log(`[opencode] cwd 不匹配 (actual=${actual}, want=${cwd}), 重启`);
  }
  return restartOpencode(cwd);
}

/** 精确杀掉 opencode 进程（按命令匹配, 不误杀 sandbox 自己）; 返回 promise 等 pkill 完成 */
function killOpencodeProcesses(): Promise<void> {
  if (opencodeProc) {
    opencodeProc.kill('SIGKILL');
    opencodeProc = null;
  }
  const cmd = `pkill -9 -f "opencode serve --port ${OPENCODE_PORT}" 2>/dev/null || true`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 3000 }, () => resolve());
  });
}

/** 杀掉 opencode 进程, 并等待端口释放 */
async function killAndWait(port: number): Promise<void> {
  expectAlive = false;
  await killOpencodeProcesses();
  // 等待端口完全释放（最多 8s）
  for (let i = 0; i < 16; i++) {
    if (!(await isAlive(port, 300))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 强制重启 opencode: 杀旧进程, 用新 cwd 启动 */
export async function restartOpencode(cwd: string): Promise<string> {
  await killAndWait(OPENCODE_PORT);
  currentCwd = cwd;
  return spawnOpencode(cwd);
}

/** 启动 opencode 子进程（独立进程组, sandbox 退出时杀进程组, 不逃逸） */
function spawnOpencode(cwd: string): Promise<string> {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('npm_config_')) delete env[k];
  }
  expectAlive = true;
  opencodeProc = spawn('opencode', ['serve', '--port', String(OPENCODE_PORT), '--hostname', '0.0.0.0'], {
    cwd,
    stdio: 'ignore',
    env,
    detached: true, // 独立进程组, 便于整组清理
  });
  opencodeProc.unref();
  opencodeProc.on('exit', (code) => {
    const wasExpect = expectAlive;
    const lastCwd = cwd;
    console.log(`[opencode] 进程退出 code=${code}, expectAlive=${wasExpect}`);
    opencodeProc = null;
    currentCwd = null;
    // 非主动关闭 && 还有 cwd → 自动重启, 避免崩溃后一直不可用
    if (wasExpect && lastCwd) {
      console.log('[opencode] 崩溃, 自动重启...');
      setTimeout(() => {
        if (expectAlive) void spawnOpencode(lastCwd);
      }, 1000);
    }
  });

  // 等待就绪
  return new Promise((resolve, reject) => {
    let done = false;
    const poll = async (n: number): Promise<void> => {
      if (await isAlive(OPENCODE_PORT)) {
        if (!done) {
          done = true;
          console.log(`[opencode] 就绪: http://127.0.0.1:${OPENCODE_PORT} (cwd=${cwd})`);
          resolve(`http://127.0.0.1:${OPENCODE_PORT}`);
        }
        return;
      }
      if (n <= 0) {
        if (!done) { done = true; expectAlive = false; reject(new Error('opencode 启动超时')); }
        return;
      }
      setTimeout(() => void poll(n - 1), 500);
    };
    void poll(24);
  });
}

/** 关闭当前 opencode 进程（切换/释放时） */
export function stopOpencode(): void {
  expectAlive = false;
  killOpencodeProcesses();
}

/** 注册 sandbox 退出清理: opencode 不逃逸 */
export function registerExitCleanup(): void {
  const cleanup = () => {
    expectAlive = false;
    killOpencodeProcesses();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}