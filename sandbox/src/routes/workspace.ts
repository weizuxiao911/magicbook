import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureOpencode, restartOpencode } from '../service/opencode.js';
import { watchWorkspace } from '../service/fswatch.js';

/** 宿主机默认 shell（sandbox 与 opencode 同宿主, process.platform 为事实源） */
export function hostDefaultShell(): string {
  if (process.platform === 'darwin') return '/bin/zsh';
  if (process.platform === 'win32') return 'powershell.exe';
  return '/bin/bash';
}

export function workspaceRoutes(app: Express, getRoot: () => string, setRoot: (v: string) => void, setAiTarget: (v: string) => void) {
  app.get('/workspace/browse', (req, res) => {
    try {
      let dir = (req.query.path as string) || '/';
      if (dir.startsWith('~')) dir = dir.replace('~', os.homedir());
      const abs = path.resolve(dir);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: abs, directories: dirs });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 有 APP_CWD 时调用: 确保 opencode + fs 监听的是目标 cwd (不匹配则重启)
  app.get('/workspace/ensure', async (req, res) => {
    try {
      const cwd = req.query.cwd as string;
      if (!cwd) { res.status(400).json({ error: 'cwd 必填' }); return; }
      setRoot(cwd);
      fs.mkdirSync(getRoot(), { recursive: true });
      fs.mkdirSync(path.join(getRoot(), '.codeblitz'), { recursive: true });
      watchWorkspace(getRoot());
      const opencodeUrl = await ensureOpencode(getRoot());
      setAiTarget(opencodeUrl);
      res.json({ ok: true, cwd: getRoot(), ai_base_url: '/ai', fs_base_url: '/fs', default_shell: hostDefaultShell() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 用户显式切换工作目录: 强制重启 opencode + fs watch
  app.post('/workspace/select', async (req, res) => {
    try {
      const { directory } = req.body;
      if (!directory) { res.status(400).json({ error: 'directory 必填' }); return; }
      setRoot(directory);
      fs.mkdirSync(getRoot(), { recursive: true });
      // codeblitz 配置目录
      fs.mkdirSync(path.join(getRoot(), '.codeblitz'), { recursive: true });
      // 启动 opencode（新 cwd）+ 启动 fs watch
      const opencodeUrl = await restartOpencode(getRoot());
      watchWorkspace(getRoot());
      setAiTarget(opencodeUrl);
      res.json({ ok: true, cwd: getRoot(), ai_base_url: '/ai', fs_base_url: '/fs', default_shell: hostDefaultShell() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}