import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { addClient } from '../service/fswatch.js';

export function fsRoutes(app: Express, getRoot: () => string) {
  // SSE 文件变更订阅
  app.get('/fs/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    addClient(res);
    req.on('close', () => res.end());
  });
  // 相对路径 → 绝对路径（在 cwd 下）
  const abs = (idePath: string): string => {
    const root = getRoot();
    const clean = idePath.startsWith('/') ? idePath : `/${idePath}`;
    return path.join(root, clean);
  };

  // 列目录
  app.get('/fs/dir', (req, res) => {
    try {
      const dir = abs(req.query.path as string || '/');
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const list = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
      res.json(list);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 创建目录
  app.post('/fs/dir', (req, res) => {
    try {
      const dir = abs(req.body?.path || (req.query.path as string) || '/');
      fs.mkdirSync(dir, { recursive: true });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 文件元信息
  app.get('/fs/stat', (req, res) => {
    try {
      const p = abs(req.query.path as string || '/');
      const s = fs.statSync(p);
      res.json({
        path: req.query.path as string,
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') res.status(404).json({ error: 'not found' });
      else res.status(500).json({ error: err.message });
    }
  });

  // 读文件
  app.get('/fs/file', (req, res) => {
    try {
      const p = abs(req.query.path as string);
      if (!p) { res.status(400).json({ error: 'path 必填' }); return; }
      const binary = req.query.binary === '1';
      const data = fs.readFileSync(p);
      if (binary) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(data);
      } else {
        res.send(data.toString('utf-8'));
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') res.status(404).json({ error: 'not found' });
      else res.status(500).json({ error: err.message });
    }
  });

  // 写文件 (client 格式: PUT /fs/file?path=xxx, body {content} 或 {base64})
  app.put('/fs/file', (req, res) => {
    try {
      const filepath = (req.query.path as string) || req.body?.path;
      const { content } = req.body;
      if (!filepath || content === undefined) { res.status(400).json({ error: 'path 和 content 必填' }); return; }
      const p = abs(filepath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = typeof content === 'object' && content?.base64
        ? Buffer.from(content.base64, 'base64')
        : Buffer.from(String(content), 'utf-8');
      fs.writeFileSync(p, buf);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 写文件 (兼容格式: POST /fs/file body {path, content})
  app.post('/fs/file', (req, res) => {
    try {
      const { path: filepath, content } = req.body;
      if (!filepath || content === undefined) { res.status(400).json({ error: 'path 和 content 必填' }); return; }
      const p = abs(filepath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = typeof content === 'object' && content?.base64
        ? Buffer.from(content.base64, 'base64')
        : Buffer.from(String(content), 'utf-8');
      fs.writeFileSync(p, buf);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 删除
  app.delete('/fs/file', (req, res) => {
    try {
      const p = abs(req.query.path as string);
      if (!p) { res.status(400).json({ error: 'path 必填' }); return; }
      fs.rmSync(p, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 移动/重命名
  app.post('/fs/move', (req, res) => {
    try {
      const { from, to } = req.body;
      if (!from || !to) { res.status(400).json({ error: 'from 和 to 必填' }); return; }
      fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
      fs.renameSync(abs(from), abs(to));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 递归查找
  app.get('/fs/search', (req, res) => {
    try {
      const base = abs(req.query.path as string || '/');
      const pattern = (req.query.pattern as string) || '';
      const results: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (!pattern || e.name.includes(pattern)) results.push(full);
        }
      };
      walk(base);
      res.json(results);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}