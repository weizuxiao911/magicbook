import fs from 'node:fs';
import type { Response } from 'express';

const watchers: fs.FSWatcher[] = [];
const clients: Response[] = [];

/** 启动对 cwd 的递归 watch（原生 recursive, 不手动遍历避免大目录卡死） */
export function watchWorkspace(cwd: string): void {
  stopWatch();
  console.log(`[fs-watch] watching: ${cwd}`);
  try {
    const w = fs.watch(cwd, { recursive: true }, (_event, filename) => {
      const rel = String(filename || '').replace(/\\/g, '/');
      broadcast({ type: 'change', path: `/${rel}` });
    });
    watchers.push(w);
  } catch (err: any) {
    console.warn('[fs-watch] recursive watch 失败, 退化为单层:', err?.message);
    try {
      const w = fs.watch(cwd, (_event, filename) => {
        const rel = String(filename || '').replace(/\\/g, '/');
        broadcast({ type: 'change', path: `/${rel}` });
      });
      watchers.push(w);
    } catch { /* ignore */ }
  }
}

/** 关闭所有 watcher */
export function stopWatch(): void {
  for (const w of watchers) w.close();
  watchers.length = 0;
}

/** 广播事件给所有 SSE 客户端 */
function broadcast(data: object): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(msg); } catch { /* ignore */ }
  }
}

/** 添加 SSE 客户端（express Response） */
export function addClient(res: Response): void {
  clients.push(res);
  res.on('close', () => {
    const i = clients.indexOf(res);
    if (i >= 0) clients.splice(i, 1);
  });
}
