/**
 * fs URI 工具 — core/commands/fs/uri.ts
 *
 * 文件 URI 契约（fs 协议层）:
 *   - cwd 根 = sandbox runtime 返回的相对路径（如 /workspace）
 *   - opensumi 文件 URI = file://{cwd}/{path}
 *   - opencode 在同一 cwd 下工作（URI 根与 opencode cwd 一致）
 */

/** cwd 根（sandbox runtime 返回的相对路径, 如 /workspace 或 /） */
export function cwdRoot(): string {
  const rt = (window as any).__APP_SANDBOX__?.getRuntime?.();
  const cwd = rt?.cwd || '/';
  return cwd.startsWith('/') ? cwd : `/${cwd}`;
}

/** 相对路径 → opensumi 文件 URI（file://{cwd}/{path}） */
export function toFileUri(path: string): string {
  const root = cwdRoot();
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `file://${root}${clean === '/' ? '' : clean}`;
}