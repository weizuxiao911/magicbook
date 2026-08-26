/**
 * 平台抽象 — service/shell-ops.ts
 *
 * fs 写操作 (write/rm/mkdir/move/stat/readBinary) 通过 PTY 跑 shell 命令, 命令语法
 * 按宿主平台分流:
 *   - macos / linux: POSIX 兼容 (bash / zsh), 原 /bin/sh 兜底
 *   - windows: PowerShell (pwsh / powershell / cmd 探测)
 *
 * 平台判定: 浏览器 UA 优先 (默认假设浏览器与 opencode 同机); 同时支持运行时按
 * opencode /pty/shells 探测实际可用 shell, 落到具体命令构造器.
 *
 * 路径: IDE 相对路径 (/foo) → 绝对路径 = cwd + '/' + rel; 路径里的特殊字符
 * 通过 shellQuote() 转义防注入.
 */

export type Platform = 'mac' | 'linux' | 'windows' | 'unknown';
export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellOps {
  kind: ShellKind;
  /** 把 base64 内容写入文件 (含 mkdir -p 父目录); 返回完整 shell 命令 */
  writeFile(absPath: string, base64Content: string): string;
  /** 读文件 base64 (供 readBinary 用) */
  readFileBase64(absPath: string): string;
  /** rm -rf 强制删除 */
  rm(absPath: string): string;
  /** mkdir -p 递归建目录 */
  mkdirp(absPath: string): string;
  /** 移动/重命名 */
  move(fromAbs: string, toAbs: string): string;
  /** stat: 输出 "<type>|<size>|<mtime-epoch-seconds>" 格式供 fs.ts 解析 */
  stat(absPath: string): string;
  /** 写文件成功后输出 marker; 失败 (命令 exit != 0) 不输出 */
  successMarker(): string;
  /** 包装完整命令: 命令本体 + successMarker, 整体由 PTY exec 一次跑 */
  wrapCommand(body: string): string;
}

/** POSIX (bash / zsh / sh) — macOS + Linux */
const POSIX: ShellOps = {
  kind: 'posix',
  writeFile: (p, b64) =>
    `mkdir -p $(dirname ${shellQuotePosix(p)}) && printf %s ${shellQuotePosix(b64)} | base64 -d > ${shellQuotePosix(p)}`,
  readFileBase64: (p) => `base64 ${shellQuotePosix(p)} 2>/dev/null`,
  rm: (p) => `rm -rf ${shellQuotePosix(p)}`,
  mkdirp: (p) => `mkdir -p ${shellQuotePosix(p)}`,
  move: (f, t) => `mv ${shellQuotePosix(f)} ${shellQuotePosix(t)}`,
  // 双 stat: GNU (-c) + BSD (-f) 兼容; 输出 "<type>|<size>|<mtime>"
  stat: (p) =>
    `stat -c '%F|%s|%.Y' ${shellQuotePosix(p)} 2>/dev/null || stat -f '%HT|%z|%m' ${shellQuotePosix(p)} 2>/dev/null`,
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => `${body} && echo __FS_OK__`,
};

/** PowerShell — Windows (pwsh / powershell) */
const POWERSHELL: ShellOps = {
  kind: 'powershell',
  writeFile: (p, b64) =>
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(p)}) | Out-Null; ` +
    `[System.IO.File]::WriteAllBytes(${psQuote(p)}, [System.Convert]::FromBase64String(${psQuote(b64)}))`,
  readFileBase64: (p) => `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes(${psQuote(p)}))`,
  rm: (p) => `Remove-Item -Recurse -Force ${psQuote(p)}`,
  mkdirp: (p) => `New-Item -ItemType Directory -Force -Path ${psQuote(p)} | Out-Null`,
  move: (f, t) => `Move-Item -Force ${psQuote(f)} ${psQuote(t)}`,
  // 输出 "<type>|<size>|<mtime-epoch>": Mode 字符含 'd' = directory
  stat: (p) =>
    `$f=Get-Item ${psQuote(p)} -ErrorAction SilentlyContinue; ` +
    `if ($f) { $t=if($f.PSIsContainer){'directory'}else{'file'}; Write-Output ($t + '|' + $f.Length + '|' + [int][double]::Parse((Get-Date -Date $f.LastWriteTime -UFormat %s))) } else { Write-Output 'MISSING' }`,
  successMarker: () => 'Write-Output __FS_OK__',
  wrapCommand: (body) => `${body}; if ($?) { Write-Output __FS_OK__ }`,
};

/** cmd.exe — Windows 兜底 (无 PowerShell 时的最后回退) */
const CMD: ShellOps = {
  kind: 'cmd',
  writeFile: (_p, _b64) => { throw new Error('cmd.exe not implemented for write (install PowerShell)'); },
  readFileBase64: (_p) => { throw new Error('cmd.exe not implemented for readBinary'); },
  rm: (p) => `rmdir /S /Q ${cmdQuote(p)} 2>NUL & exit /B 0`,
  mkdirp: (p) => `mkdir ${cmdQuote(p)} 2>NUL`,
  move: (f, t) => `move /Y ${cmdQuote(f)} ${cmdQuote(t)}`,
  stat: (_p) => { throw new Error('cmd.exe not implemented for stat'); },
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => body,
};

/** 浏览器 UA 探测宿主平台 (假设浏览器与 opencode 同机, 这是绝大多数 dev 用例) */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const uaData: any = (navigator as any).userAgentData;
  const p: string = (typeof uaData?.platform === 'string' ? uaData.platform : '') || navigator.platform || '';
  if (/mac/i.test(p)) return 'mac';
  if (/win/i.test(p)) return 'windows';
  if (/linux/i.test(p)) return 'linux';
  return 'unknown';
}

/** 按 opencode /pty/shells 探测的可用 shell 名, 选 shell kind */
export function pickShellKind(shellList: Array<{ name: string; path: string; acceptable: boolean }>, platform: Platform): ShellKind {
  const acc = shellList.filter((s) => s.acceptable);
  if (!acc.length) {
    // 无 acceptable: 兜底按平台
    return platform === 'windows' ? 'cmd' : 'posix';
  }
  const names = acc.map((s) => s.name.toLowerCase());
  // powershell 优先 (pwsh / powershell)
  if (names.some((n) => /pwsh|powershell/.test(n))) return 'powershell';
  // cmd
  if (names.some((n) => /^cmd$/.test(n)) && platform === 'windows') return 'cmd';
  // posix: bash / zsh / sh / fish
  if (names.some((n) => /bash|zsh|sh|fish/.test(n))) return 'posix';
  return platform === 'windows' ? 'powershell' : 'posix';
}

/** 按 shell kind 取命令构造器 */
export function getShellOps(kind: ShellKind): ShellOps {
  if (kind === 'powershell') return POWERSHELL;
  if (kind === 'cmd') return CMD;
  return POSIX;
}

// ---- shell 字符串转义 ----

/** POSIX 单引号包裹: 内容里的 ' 替换为 '"'"' */
function shellQuotePosix(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

/** PowerShell 双引号包裹: 内部双引号用 `\"`, 反引号转义保留 */
function psQuote(s: string): string {
  return `"${s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')}"`;
}

/** cmd.exe 双引号包裹: 内部双引号 `\"`, 路径斜杠保留 */
function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}
