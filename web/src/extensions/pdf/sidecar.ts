/**
 * Sidecar 标注文件 IO — 读 / 写 / merge / 自写去重
 *
 * 文件路径: `/.{pdfBasename}.annotation` (IDE 相对路径, 前导 dot 隐藏)
 * 走 codeblitz `IFileServiceClient` (HTTP 走 opencode server fs API, 无长连接).
 *   跟 explorer / 其他 editor 走同一条路, 不再依赖 service 层 FsPty.
 *   依据 AGENTS.md 分层架构铁律: extensions 不得直连 service.
 *
 * 写盘策略:
 *   - read-merge-write: 读已有 items, 合并新 items (按 id 幂等), 写回
 *   - debounce 500ms: 连续写合并一次
 *   - 自写去重: 写完前算 contentHash, 监听 fs:changed 时 hash 对比, 相同跳过 reload
 *   - 失败: 抛错给上层, 上层 toast + 保留 in-memory 状态 + 标"未保存"红点
 *     (无 FsPty 退避重试, IFileServiceClient 走 HTTP 失败就失败, 用户手动重试)
 */

import { IFileServiceClient } from '@opensumi/ide-file-service';

import {
  SidecarAnnot,
  SidecarAnnotFile,
  parseSidecarFile,
} from './annotations';

const WRITE_DEBOUNCE_MS = 500;

/** 算文件内容 SHA-256 (用 Web Crypto API), 用于自写去重. */
export async function contentHash(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** IDE 相对路径 (/.foo.annotation) → file:// URI (拼 cwd). */
function sidecarUri(relPath: string): string {
  const cwd = (typeof window !== 'undefined'
    ? (window as any).__APP_CONFIG__?.cwd
    : '') || '';
  const abs = cwd + relPath.replace(/^\/+/, '');
  return `file://${abs}`;
}

/** 读取 sidecar 文件. 不存在 (404) 返空 {version:1, items:[]}, 解析失败同. */
export async function readSidecar(relPath: string, fileService: IFileServiceClient): Promise<SidecarAnnotFile> {
  if (!fileService?.getFileStat || !fileService?.readFile) {
    console.warn('[sidecar] IFileServiceClient not available');
    return { version: 1, items: [] };
  }
  const uri = sidecarUri(relPath);
  try {
    const stat = await fileService.getFileStat(uri);
    if (!stat) return { version: 1, items: [] };
    const { content } = await fileService.readFile(uri);
    if (!content) return { version: 1, items: [] };
    // BinaryBuffer.toString() 默认 utf-8; 兜底其他 string 类型
    const text: string = typeof (content as any).toString === 'function'
      ? (content as any).toString('utf8')
      : String(content);
    const raw = JSON.parse(text);
    return parseSidecarFile(raw);
  } catch (e: any) {
    // 文件不存在 / 解析失败: 静默
    if (typeof e?.message === 'string' && /not\s*found|ENOENT|404/i.test(e.message)) {
      return { version: 1, items: [] };
    }
    console.warn('[sidecar] read failed:', e?.message || e);
    return { version: 1, items: [] };
  }
}

/** 把 items 数组按 id 合并到已有 items (新 entries 覆盖同 id). */
export function mergeItems(existing: SidecarAnnot[], incoming: SidecarAnnot[]): SidecarAnnot[] {
  const map = new Map<string, SidecarAnnot>();
  for (const it of existing) map.set(it.id, it);
  for (const it of incoming) map.set(it.id, it);  // incoming wins
  return Array.from(map.values());
}

/** 写盘管理器. 每次 pushAnnot 合并到队列, 500ms debounce 后一次性 read-merge-write. */
export class SidecarWriter {
  private relPath: string;
  private fileService: IFileServiceClient;
  private pending: SidecarAnnot[] = [];
  private deleteIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _lastWrittenHash: string = '';
  private onError: (err: Error) => void;

  constructor(relPath: string, fileService: IFileServiceClient, onError: (err: Error) => void = () => {}) {
    this.relPath = relPath;
    this.fileService = fileService;
    this.onError = onError;
  }

  /** 加入待写 items, 触发 debounce. */
  push(annots: SidecarAnnot[]) {
    this.pending.push(...annots);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
  }

  /** 标记删除: 写入时过滤掉该 id. 多次调可累积. */
  pushDelete(id: string) {
    if (!this.deleteIds.includes(id)) this.deleteIds.push(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
  }

  /** 读最新文件 + 合并 pending + 过滤删除 + 写回. */
  private async flush(): Promise<void> {
    this.timer = null;
    if (this.pending.length === 0 && this.deleteIds.length === 0) return;
    const incoming = this.pending;
    const deletes = this.deleteIds;
    this.pending = [];
    this.deleteIds = [];
    try {
      const existing = await readSidecar(this.relPath, this.fileService);
      const merged = mergeItems(existing.items, incoming);
      const filtered = merged.filter((a) => !deletes.includes(a.id));
      const file: SidecarAnnotFile = { version: 1, items: filtered };
      const json = JSON.stringify(file, null, 2);
      const hash = await contentHash(json);
      if (hash === this._lastWrittenHash) return;
      await this.writeFile(json);
      this._lastWrittenHash = hash;
    } catch (e: any) {
      console.error('[sidecar] write failed:', e?.message || e);
      // 状态回滚, 留给下次 push 重新尝试 (不立即退避, HTTP 失败通常立即可重试)
      this.pending.unshift(...incoming);
      this.deleteIds.unshift(...deletes);
      this.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** 写文件: 先 getFileStat, 不存在 → createFile; 存在 → setContent.
   *  IFileServiceClient 没有 mkdirp, 但 sidecar 跟 PDF 同目录, PDF 已存则父目录已建. */
  private async writeFile(content: string): Promise<void> {
    const uri = sidecarUri(this.relPath);
    const stat = await this.fileService.getFileStat(uri).catch(() => null);
    if (!stat) {
      await this.fileService.createFile(uri, { content } as any);
    } else {
      await this.fileService.setContent(stat, content);
    }
  }

  /** 暴露 lastWrittenHash, 供外部 (PdfReaderView onFsChanged) 做自写去重. */
  get lastWrittenHash(): string {
    return this._lastWrittenHash;
  }

  get path() {
    return this.relPath;
  }
}
