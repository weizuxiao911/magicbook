/**
 * Sidecar 标注文件 IO — 读 / 写 / merge / 自写去重
 *
 * 文件路径: `/.{pdfBasename}.annotation` (IDE 相对路径, 前导 dot 隐藏)
 * 走 `__APP_FS__.read/write` (PTY 单例, 自动 mkdir 父目录, 4KB base64 分块).
 *
 * 写盘策略:
 *   - read-merge-write: 读已有 items, 合并新 items (按 id 幂等), 写回
 *   - debounce 500ms: 连续写合并一次
 *   - 自写去重: 写完前算 contentHash, 监听 fs:changed 时 hash 对比, 相同跳过 reload
 *   - 失败: 抛错给上层, 上层 toast + 保留 in-memory 状态 + 标"未保存"红点
 */

import {
  SidecarAnnot,
  SidecarAnnotFile,
  parseSidecarFile,
} from './annotations';

const WRITE_DEBOUNCE_MS = 500;
const TEXT_DECODER = new TextDecoder();

/** 算文件内容 SHA-256 (用 Web Crypto API), 用于自写去重. */
export async function contentHash(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 读取 sidecar 文件. 不存在 (404) 返空 {version:1, items:[]}, 解析失败同. */
export async function readSidecar(relPath: string): Promise<SidecarAnnotFile> {
  const fs = (window as any).__APP_FS__;
  if (!fs?.read) {
    console.warn('[sidecar] __APP_FS__ not available');
    return { version: 1, items: [] };
  }
  try {
    const bytes: Uint8Array = await fs.read(relPath);
    if (!bytes || bytes.byteLength === 0) return { version: 1, items: [] };
    const text = TEXT_DECODER.decode(bytes);
    const raw = JSON.parse(text);
    return parseSidecarFile(raw);
  } catch (e: any) {
    // 文件不存在 / 解析失败: 静默
    if (typeof e?.message === 'string' && /not.?found|404/i.test(e.message)) {
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
  private pending: SidecarAnnot[] = [];
  private deleteIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrittenHash: string = '';
  private retryCount: number = 0;
  private onError: (err: Error) => void;

  constructor(relPath: string, onError: (err: Error) => void = () => {}) {
    this.relPath = relPath;
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

  /** 立即 flush (用于关闭 tab / 立即保存). */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** 读最新文件 + 合并 pending + 过滤删除 + 写回. */
  private async flush(): Promise<void> {
    this.timer = null;
    if (this.pending.length === 0 && this.deleteIds.length === 0) return;
    const incoming = this.pending;
    const deletes = this.deleteIds;
    this.pending = [];
    this.deleteIds = [];
    const fs = (window as any).__APP_FS__;
    if (!fs?.write) {
      this.onError(new Error('__APP_FS__ not available'));
      this.pending.unshift(...incoming);
      this.deleteIds.unshift(...deletes);
      return;
    }
    try {
      const existing = await readSidecar(this.relPath);
      const merged = mergeItems(existing.items, incoming);
      const filtered = merged.filter((a) => !deletes.includes(a.id));
      const file: SidecarAnnotFile = { version: 1, items: filtered };
      const json = JSON.stringify(file, null, 2);
      const hash = await contentHash(json);
      if (hash === this.lastWrittenHash) return;
      await fs.write(this.relPath, json);
      this.lastWrittenHash = hash;
      this.retryCount = 0;
    } catch (e: any) {
      console.error('[sidecar] write failed (attempt ' + (this.retryCount + 1) + '):', e?.message || e);
      this.pending.unshift(...incoming);
      this.deleteIds.unshift(...deletes);
      this.retryCount++;
      if (this.retryCount === 1) {
        // 第一次失败, 大概率 FsPty 卡住 (PTY 内部状态异常), 立即 reset 让下次重建.
        // 不增加 retry 次数, 让第二次 retry 走新 PTY 真的有重试价值.
        try { fs.resetFsPty?.(); } catch { /* */ }
      }
      if (this.retryCount < 3) {
        const delay = 5000 * Math.pow(2, this.retryCount - 1);
        this.timer = setTimeout(() => this.flush(), delay);
        console.log('[sidecar] retry in', delay, 'ms');
      } else {
        this.onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** 更新 lastWrittenHash (监听 fs:changed 收到自写事件时调, 标记该 hash 是自己写的). */
  markWrittenHash(hash: string) {
    this.lastWrittenHash = hash;
  }

  get path() {
    return this.relPath;
  }
}
