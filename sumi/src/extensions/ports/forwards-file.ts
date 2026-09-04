/**
 * forwards-file.ts — 端口转发记录文件 IO
 *
 * 文件位置: 工作台根目录 `.codeblitz/forwards.ports`
 * 格式: 每行一条记录 `icon:port:name`, `#` 开头为注释行, 空行忽略
 *  - icon: emoji 标记 (用户从预设图标选, 默认 🔌)
 *  - port: 1-65535 端口号
 *  - name: 应用名 (可空; 可含 `:` 取剩余全部)
 *
 * 跟服务端 ports whitelist 解耦:
 *  - 本文件是用户视角的"我转发过哪些端口"持久化记录
 *  - 重启后客户端从文件恢复, 同时把端口 re-add 到服务端 whitelist (确保 /proxy 可用)
 *  - 卸载/服务端 whitelist 删时同步删本文件对应行
 *
 * 写盘: 走 codeblitz IFileServiceClient → opencode server `/api/fs/write` (无长连接).
 */

import { IFileServiceClient } from '@opensumi/ide-file-service';
import { WORKSPACE_ROOT } from '@codeblitzjs/ide-core';

export interface ForwardRecord {
  port: number;
  icon: string;
  name: string;
}

const FORWARDS_FILE = '.codeblitz/forwards.ports';

/** 把记录路径转成 codeblitz file:// URI.
 *  WORKSPACE_ROOT 已是真实工作目录 (codeblitz constant.js 被 patch 过), 直接拼. */
function forwardsUri(): string {
  const sep = WORKSPACE_ROOT.endsWith('/') ? '' : '/';
  return `file://${WORKSPACE_ROOT}${sep}${FORWARDS_FILE}`;
}

/** 解析单行 → 记录. 格式 `icon:port:name`. 失败返 null. */
function parseLine(line: string): ForwardRecord | null {
  const s = line.replace(/\r$/, '').trim();
  if (!s || s.startsWith('#')) return null;
  // split(':') 限制 3 段, name 可包含 ':'
  const m = s.match(/^(\S+):(\d+):(.*)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, icon: m[1], name: m[2] ? m[3] : '' };
}

/** 记录 → 单行. */
function serializeLine(r: ForwardRecord): string {
  return `${r.icon}:${r.port}:${r.name}`;
}

/** 读文件 → 记录列表. 文件不存在/解析失败返空. */
export async function readForwards(fileService: IFileServiceClient): Promise<ForwardRecord[]> {
  if (!fileService?.getFileStat || !fileService?.readFile) return [];
  const uri = forwardsUri();
  try {
    const stat = await fileService.getFileStat(uri);
    if (!stat) return [];
    const { content } = await fileService.readFile(uri);
    if (!content) return [];
    const text: string = typeof (content as any).toString === 'function'
      ? (content as any).toString('utf8')
      : String(content);
    const out: ForwardRecord[] = [];
    const seen = new Set<number>();
    for (const ln of text.split('\n')) {
      const r = parseLine(ln);
      if (r && !seen.has(r.port)) {
        seen.add(r.port);
        out.push(r);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 写记录列表 → 文件 (覆盖式). records 为空会清空文件 (但保留头部注释). */
export async function writeForwards(fileService: IFileServiceClient, records: ForwardRecord[]): Promise<void> {
  if (!fileService?.getFileStat || !fileService?.createFile) return;
  const uri = forwardsUri();
  const body = serialize(records);
  try {
    const stat = await fileService.getFileStat(uri).catch(() => null);
    if (!stat) {
      await fileService.createFile(uri, { content: body } as any);
    } else {
      await fileService.setContent(stat, body);
    }
  } catch (e) {
    console.error('[forwards-file] write failed:', (e as Error)?.message || e);
    throw e;
  }
}

/** 序列化记录列表为文件内容 (含头部注释). */
function serialize(records: ForwardRecord[]): string {
  const head = [
    '# numas forward records',
    '# format: icon:port:name  (one per line)',
  ].join('\n');
  if (records.length === 0) return head + '\n';
  return head + '\n' + records.map(serializeLine).join('\n') + '\n';
}

/** 追加/更新一条记录 (同 port 覆盖 icon+name). 写回文件. */
export async function upsertForward(
  fileService: IFileServiceClient,
  port: number,
  icon: string,
  name: string,
): Promise<ForwardRecord[]> {
  const cur = await readForwards(fileService);
  const next = cur.filter((r) => r.port !== port);
  next.push({ port, icon, name });
  next.sort((a, b) => a.port - b.port);
  await writeForwards(fileService, next);
  return next;
}

/** 删除一条记录 (按 port). 写回文件. */
export async function removeForward(
  fileService: IFileServiceClient,
  port: number,
): Promise<ForwardRecord[]> {
  const cur = await readForwards(fileService);
  const next = cur.filter((r) => r.port !== port);
  if (next.length === cur.length) return cur;
  await writeForwards(fileService, next);
  return next;
}

/** 取端口对应的转发记录. */
export async function getForward(
  fileService: IFileServiceClient,
  port: number,
): Promise<ForwardRecord | null> {
  const cur = await readForwards(fileService);
  return cur.find((r) => r.port === port) ?? null;
}
