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

/** codeblitz 虚拟根前缀 → 真实宿主锚点的映射.
 *  铁律: 发往 opencode 的路径只能锚定 /path 接口返回的真实 directory/home.
 *    /home/<suffix>            → <真实 home>/<suffix>   (虚拟家目录, 覆盖 /home/AppData/Roaming 等)
 *    /workspace/<suffix>       → <真实 directory>/<suffix>
 *    WORKSPACE_ROOT/<suffix>   → <真实 directory>/<suffix>
 *  返回 null = 无法锚定到任何真实宿主路径 (虚拟路径但锚点缺失), 调用方必须当不存在处理, 不发请求.
 *  已经是真实宿主绝对路径 (在 directory/home 内或 Windows 盘符开头) 规范化后原样返回. */
export function toHostPath(p: string, anchors: { directory: string; home: string }, workspaceRoot = '/workspace'): string | null {
  if (!p) return null;
  const n = normalizeCwdPath(p);
  const directory = normalizeCwdPath(anchors.directory || '');
  const home = normalizeCwdPath(anchors.home || '');

  const prefixes: Array<[string, string]> = [
    ['/home', home],
    [normalizeCwdPath(workspaceRoot) || '/workspace', directory],
    ['/workspace', directory],
  ];
  for (const [vprefix, anchor] of prefixes) {
    if (!anchor) continue;
    if (n === vprefix) return anchor;
    if (n.startsWith(vprefix + '/')) return `${anchor.replace(/\/+$/, '')}/${n.slice(vprefix.length + 1)}`;
  }

  // 已是真实宿主路径: 在锚点内 (contains) 或 Windows 盘符开头 → 直接用
  const inside = (anchor: string) => !!anchor && (n === anchor || n.startsWith(anchor.replace(/\/+$/, '') + '/'));
  if (inside(directory) || inside(home) || isWindowsDrive(n)) return n;

  // POSIX 绝对路径但锚点都不在/不匹配 (e.g. 真实 /etc/hosts 或早期锚点缺失):
  // 锚点齐全时拒绝虚拟路径; 锚点缺失 (directory 为空, 启动极早期) 放行由服务端判定.
  if (n.startsWith('/')) return directory || home ? null : n;
  return n;
}