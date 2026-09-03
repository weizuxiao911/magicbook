/**
 * service/pty/shell-ops.ts
 *
 * 跨平台 shell 命令构造器 (POSIX / PowerShell / cmd).
 *
 * 设计:
 *   - mac/linux → POSIX (bash/zsh/sh)
 *   - Windows   → PowerShell (pwsh), 兜底 cmd.exe
 *   - 路径转义防注入 (POSIX 单引号, PS 反引号, cmd 双引号)
 *   - 命令构造器返回 shell 命令字符串, 由 PTY exec 一次跑
 *
 * 注: 这层只造命令字符串, 不执行. 真正 exec 走 opencode pty.
 */

import { isMac, isWindows, isLinux } from '../../infra/os';

export type Platform = 'mac' | 'linux' | 'windows' | 'unknown';
export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellOps {
  kind: ShellKind;
  /** 把 base64 内容写入文件 (含 mkdir -p 父目录); 返回完整 shell 命令 */
  writeFile(absPath: string, base64Content: string): string;
  /** 读文件 base64 */
  readFileBase64(absPath: string): string;
  /** rm -rf 强制删除 */
  rm(absPath: string): string;
  /** rmdir -p 删空目录 (区分走 rmdir 避免 unlink ENOTSUP) */
  rmdir(absPath: string): string;
  /** mkdir -p 递归建目录 */
  mkdirp(absPath: string): string;
  /** 移动/重命名 */
  move(fromAbs: string, toAbs: string): string;
  /** stat: 输出 "<type>|<size>|<mtime-epoch-seconds>" 格式 */
  stat(absPath: string): string;
  /** 写成功后输出 marker; 失败 (命令 exit != 0) 不输出 */
  successMarker(): string;
  /** 包装完整命令: 命令本体 + successMarker, 整体由 PTY exec 一次跑 */
  wrapCommand(body: string): string;
}

/** POSIX 单引号包裹: 内容里的 ' 替换为 '"'"' */
export function shellQuotePosix(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

/** PowerShell 双引号包裹 */
function psQuote(s: string): string {
  return `"${s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')}"`;
}

/** cmd.exe 双引号包裹 */
function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** POSIX (bash / zsh / sh) — macOS + Linux */
const POSIX: ShellOps = {
  kind: 'posix',
  writeFile: (p, b64) =>
    `mkdir -p $(dirname ${shellQuotePosix(p)}) && printf %s ${shellQuotePosix(b64)} | base64 -d > ${shellQuotePosix(p)}`,
  readFileBase64: (p) => `base64 ${shellQuotePosix(p)} 2>/dev/null`,
  rm: (p) => `rm -rf ${shellQuotePosix(p)}`,
  rmdir: (p) => `rmdir ${shellQuotePosix(p)}`,
  mkdirp: (p) => `mkdir -p ${shellQuotePosix(p)}`,
  move: (f, t) => `mv ${shellQuotePosix(f)} ${shellQuotePosix(t)}`,
  stat: (p) =>
    `stat -c '%F|%s|%.Y' ${shellQuotePosix(p)} 2>/dev/null || stat -f '%HT|%z|%m' ${shellQuotePosix(p)} 2>/dev/null`,
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => `${body} && echo __FS_OK__`,
};

/** PowerShell — Windows */
const POWERSHELL: ShellOps = {
  kind: 'powershell',
  writeFile: (p, b64) =>
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(p)}) | Out-Null; ` +
    `[System.IO.File]::WriteAllBytes(${psQuote(p)}, [System.Convert]::FromBase64String(${psQuote(b64)}))`,
  readFileBase64: (p) => `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes(${psQuote(p)}))`,
  rm: (p) => `Remove-Item -Recurse -Force ${psQuote(p)}`,
  rmdir: (p) => `Remove-Item -Force ${psQuote(p)}`,
  mkdirp: (p) => `New-Item -ItemType Directory -Force -Path ${psQuote(p)} | Out-Null`,
  move: (f, t) => `Move-Item -Force ${psQuote(f)} ${psQuote(t)}`,
  stat: (p) =>
    `$f=Get-Item ${psQuote(p)} -ErrorAction SilentlyContinue; ` +
    `if ($f) { $t=if($f.PSIsContainer){'directory'}else{'file'}; Write-Output ($t + '|' + $f.Length + '|' + [int][double]::Parse((Get-Date -Date $f.LastWriteTime -UFormat %s))) } else { Write-Output 'MISSING' }`,
  successMarker: () => 'Write-Output __FS_OK__',
  wrapCommand: (body) => `${body}; if ($?) { Write-Output __FS_OK__ }`,
};

/** cmd.exe — Windows 兜底 */
const CMD: ShellOps = {
  kind: 'cmd',
  writeFile: (_p, _b64) => { throw new Error('cmd.exe not implemented for write (install PowerShell)'); },
  readFileBase64: (_p) => { throw new Error('cmd.exe not implemented for readBinary'); },
  rm: (p) => `rmdir /S /Q ${cmdQuote(p)} 2>NUL & exit /B 0`,
  rmdir: (p) => `rmdir ${cmdQuote(p)} 2>NUL & exit /B 0`,
  mkdirp: (p) => `mkdir ${cmdQuote(p)} 2>NUL`,
  move: (f, t) => `move /Y ${cmdQuote(f)} ${cmdQuote(t)}`,
  stat: (_p) => { throw new Error('cmd.exe not implemented for stat'); },
  successMarker: () => 'echo __FS_OK__',
  wrapCommand: (body) => body,
};

/** 当前平台 (复用 infra/os) */
export function detectPlatform(): Platform {
  if (isMac()) return 'mac';
  if (isWindows()) return 'windows';
  if (isLinux()) return 'linux';
  return 'unknown';
}

/** 按 opencode /pty/shells 探测的可用 shell 名选 kind */
export function pickShellKind(
  shellList: Array<{ name: string; path: string; acceptable: boolean }>,
  platform: Platform,
): ShellKind {
  const acc = shellList.filter((s) => s.acceptable);
  if (!acc.length) return platform === 'windows' ? 'cmd' : 'posix';
  const names = acc.map((s) => s.name.toLowerCase());
  if (names.some((n) => /pwsh|powershell/.test(n))) return 'powershell';
  if (names.some((n) => /^cmd$/.test(n)) && platform === 'windows') return 'cmd';
  if (names.some((n) => /bash|zsh|sh|fish/.test(n))) return 'posix';
  return platform === 'windows' ? 'powershell' : 'posix';
}

/** 按 kind 取命令构造器 */
export function getShellOps(kind: ShellKind): ShellOps {
  if (kind === 'powershell') return POWERSHELL;
  if (kind === 'cmd') return CMD;
  return POSIX;
}

/** 从 shell 列表按 kind 选具体命令路径 (pty.create 的 command 字段) */
export function pickShell(
  list: Array<{ name: string; path: string; acceptable: boolean }>,
  kind: ShellKind,
): string {
  const acc = list.filter((s) => s.acceptable);
  if (!acc.length) {
    return kind === 'powershell' ? 'powershell.exe' : kind === 'cmd' ? 'cmd.exe' : '/bin/sh';
  }
  if (kind === 'powershell') {
    return acc.find((s) => /pwsh/i.test(s.name))?.path
      || acc.find((s) => /powershell/i.test(s.name))?.path
      || acc[0].path;
  }
  if (kind === 'cmd') {
    return acc.find((s) => /^cmd$/i.test(s.name))?.path || acc[0].path;
  }
  return acc.find((s) => /zsh/i.test(s.name))?.path
    || acc.find((s) => /bash/i.test(s.name))?.path
    || acc.find((s) => /sh/i.test(s.name))?.path
    || acc[0].path;
}