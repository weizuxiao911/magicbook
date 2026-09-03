/**
 * infra/path.ts — 跨平台路径处理
 *
 * 统一 path normalize / 跨平台 URI ↔ workspace 相对路径转换.
 * service 层严禁直接 `\\` 替换 / Windows 盘符判断, 一律走这里.
 *
 * 设计:
 *   - 所有路径内部统一用 `/` 分隔 (opencode /api/fs/* 协议是 POSIX 风格)
 *   - Windows 路径 ('C:\\foo' 或 '/D:/foo') 走 normalizeCwdPath 规范化
 *   - 平台探测来自 infra/os
 */

import { isWindows } from './os';

/** \\ → / (跨平台路径规范化). server 端 /api/fs/* 协议用 POSIX 分隔符. */
export function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Windows 盘符判定: 'D:' / 'D:\\...' / 'D:/...' / 错误形态 '/D:/...' */
export function isWindowsDrive(p: string): boolean {
  return /^\/?[A-Za]:/.test(p);
}

/** 跨平台 cwd 规范化:
 *  - 反斜杠转正斜杠
 *  - Windows 盘符: 去前导 '/' (server 端 path.win32 处理; 前导 '/' 会让 server 按 POSIX 根解析 → 500)
 *  - 去尾斜杠 (保留根 '/' / 盘符根 'D:')
 *  返回空字符串表示空 cwd. */
export function normalizeCwdPath(p: string): string {
  if (!p) return p;
  let s = normalizeSep(p);
  if (isWindowsDrive(s)) s = s.replace(/^\/+/, '');
  if (s === '/' || s === '') return s;
  if (/^[A-Za-z]:$/.test(s)) return s;
  return s.replace(/\/+$/, '');
}

/** 跨平台 basename (兼容 / 和 \\ 分隔). server Entry.path 在 Windows 目录尾带 '\\'. */
export function pathBase(p: string): string {
  const s = normalizeSep(p).replace(/\/+$/, '');
  const seg = s.split('/').pop();
  return seg ? seg : p;
}

/** 宿主机绝对路径 → 相对 workspace 的相对路径.
 *  返回 null 表示路径不在 workspace 下 (server 端 FSUtil.contains 校验会失败).
 *  跨平台: macOS/Linux '/Users/foo' 跟 workspace '/Users/foo' → '.'; Windows 'C:\\foo' 跟 'C:/foo' → '.'. */
export function absToRel(absPath: string, workspace: string): string | null {
  if (!workspace) {
    return normalizeAbs(absPath).replace(/^\/+/, '');
  }
  const a = normalizeAbs(absPath).replace(/\/+$/, '');
  const w = normalizeAbs(workspace).replace(/\/+$/, '');
  if (a === w) return '.';
  if (a.startsWith(w + '/')) return a.slice(w.length + 1);
  return null;
}

/** 绝对路径规范化: 盘符形态去前导 '/' + 反斜杠转正斜杠; POSIX 原样. */
export function normalizeAbs(p: string): string {
  const s = normalizeSep(p);
  return isWindowsDrive(s) ? s.replace(/^\/+/, '') : s;
}

/** idePath → opencode /api/fs/*  用相对路径.
 *  workspace 内直接取 rel; workspace 外兜底 strip 前导 '/', 让 server FSUtil.contains 抛错并暴露. */
export function relForApi(idePath: string, workspace: string): string {
  if (workspace) {
    const r = absToRel(idePath, workspace);
    if (r !== null) return r;
  }
  let p = normalizeSep(idePath).replace(/^\/+/, '');
  if (p.startsWith('workspace/')) p = p.slice('workspace/'.length);
  return p;
}

/** MacOS /home 是 socket mount (mkdir ENOTSUP). codeblitz 框架硬编码 /home/.codeblitz 做 storage,
 *  我们 URI 层重写到 ${workspaceWorkspace}/.codeblitz (用户 home, 跨平台可写).
 *  cwd 格式 (POSIX '/Users/foo/Documents' 或 Windows 'C:/Users/foo/Documents') 都兼容.
 *  注: 只重写 /home/.codeblitz 前缀, 不影响其他 /home 路径. */
export function rewriteCodeblitzHome(p: string, workspace: string): string {
  if (!p.startsWith('/home/.codeblitz')) return p;
  const home = workspace ? workspace.replace(/[\\/][^\\/]+[\\/]?$/, '') : '';
  if (!home) return p; // 拿不到 home 兜底原样 (Linux 上 /home/.codeblitz 实际能 mkdir)
  const rest = p.slice('/home/.codeblitz'.length);
  return `${home}/.codeblitz${rest}`;
}