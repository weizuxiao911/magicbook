/**
 * 文件系统监听 — infrastructure/fs/watcher.ts
 *
 * fs.watch 监听宿主机工作区根（workspaceRoot）目录变化,
 * 通过 SSE 向 client 推送变更事件（explorer 实时刷新）.
 *
 * 事件: { type: 'add' | 'change' | 'unlink', path: 相对路径, kind: 'file' | 'directory' }
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

export interface FsChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  kind: 'file' | 'directory';
}

type Listener = (e: FsChangeEvent) => void;

/** 监听器单例（每 server 一个） */
export class WorkspaceWatcher {
  private watchers: fs.FSWatcher[] = [];
  private listeners = new Set<Listener>();
  private running = false;

  constructor(private readonly root: string) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动监听（幂等） */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
    // macOS/Linux 用 recursive watch; 平台不支持时降级为单目录
    try {
      this.watchers.push(fs.watch(this.root, { recursive: true }, (event, filename) => {
        this.handle(event, filename);
      }));
    } catch {
      this.watchers.push(fs.watch(this.root, (event, filename) => {
        this.handle(event, filename);
      }));
    }
    console.log(`[fs-watcher] watching ${this.root}`);
  }

  stop(): void {
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    this.running = false;
  }

  private handle(event: string, filename: string | Buffer | null): void {
    if (!filename) return;
    const rel = filename.toString().replace(/\\/g, '/');
    const full = path.join(this.root, rel);
    let kind: 'file' | 'directory' = 'file';
    try {
      kind = fs.statSync(full).isDirectory() ? 'directory' : 'file';
    } catch {
      // 已删除, 用父目录推断 kind
      kind = rel.endsWith('/') ? 'directory' : 'file';
    }
    const type = event === 'rename'
      ? (fs.existsSync(full) ? 'add' : 'unlink')
      : 'change';
    const change: FsChangeEvent = { type, path: `/${rel}`, kind };
    this.listeners.forEach((fn) => fn(change));
  }
}

/** SSE 广播（连接管理） */
export class FsEventStream {
  private clients = new Set<ServerResponse>();

  constructor(private readonly watcher: WorkspaceWatcher) {
    this.watcher.on((e) => this.broadcast(e));
  }

  /** 挂载 SSE 连接（res 保持打开） */
  subscribe(res: ServerResponse): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    // 初始 ping 保活
    res.write(`: connected\n\n`);
  }

  private broadcast(e: FsChangeEvent): void {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    this.clients.forEach((c) => {
      try {
        c.write(data);
      } catch {
        this.clients.delete(c);
      }
    });
  }
}