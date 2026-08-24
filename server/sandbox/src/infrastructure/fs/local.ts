/**
 * 本地文件系统实现 — infrastructure/fs/local.ts
 *
 * 实现 domain FsRepository 端口: 基于沙箱 cwd 的本地磁盘操作.
 * 含路径穿越防护.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FsRepository } from '../../domain/repositories/fs-repository';
import type { FileEntry, FileMeta, FsWriteResult } from '../../domain/models/file-system';

function isPathSafe(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

/** 将 IDE 相对路径映射到 cwd 内绝对路径, 越界抛错 */
function resolveSafe(cwd: string, p: string): string {
  const full = path.normalize(path.join(cwd, (p || '/').replace(/^[/\\]+/, '')));
  if (!isPathSafe(cwd, full)) {
    const err = new Error(`path outside workspace: ${p}`) as Error & { status?: number };
    err.status = 403;
    throw err;
  }
  return full;
}

export class LocalFsRepository implements FsRepository {
  async listDir(cwd: string, p: string): Promise<FileEntry[]> {
    const full = resolveSafe(cwd, p);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true })
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
  }

  async mkdir(cwd: string, p: string): Promise<void> {
    fs.mkdirSync(resolveSafe(cwd, p), { recursive: true });
  }

  async readFile(cwd: string, p: string, binary = false): Promise<Buffer> {
    const full = resolveSafe(cwd, p);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      const err = new Error('file not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return fs.readFileSync(full);
  }

  async writeFile(cwd: string, p: string, body: unknown): Promise<FsWriteResult> {
    const full = resolveSafe(cwd, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const b = body as { content?: string; base64?: string } | undefined;
    if (b && typeof b.base64 === 'string') {
      fs.writeFileSync(full, Buffer.from(b.base64, 'base64'));
    } else if (b && typeof b.content === 'string') {
      fs.writeFileSync(full, b.content, 'utf-8');
    } else if (typeof body === 'string') {
      fs.writeFileSync(full, body, 'utf-8');
    } else {
      fs.writeFileSync(full, JSON.stringify(body ?? ''), 'utf-8');
    }
    return { ok: true, path: p };
  }

  async remove(cwd: string, p: string): Promise<void> {
    const full = resolveSafe(cwd, p);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }

  async stat(cwd: string, p: string): Promise<FileMeta> {
    const full = resolveSafe(cwd, p);
    if (!fs.existsSync(full)) {
      const err = new Error('not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    const st = fs.statSync(full);
    return {
      path: p,
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  }

  async search(cwd: string, p: string, pattern: string): Promise<string[]> {
    const full = resolveSafe(cwd, p);
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const results: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || !fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') && e.name !== '.env') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs, depth + 1);
        } else if (regex.test(e.name)) {
          results.push(abs.slice(full.length).replace(/^[/\\]+/, '') || e.name);
        }
      }
    };
    walk(full, 0);
    return results;
  }

  async move(cwd: string, from: string, to: string, overwrite?: boolean): Promise<void> {
    const src = resolveSafe(cwd, from);
    const dst = resolveSafe(cwd, to);
    if (fs.existsSync(dst)) {
      if (!overwrite) {
        const err = new Error(`target exists: ${to}`) as Error & { status?: number };
        err.status = 409;
        throw err;
      }
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }

  async copy(cwd: string, from: string, to: string, overwrite?: boolean): Promise<void> {
    const src = resolveSafe(cwd, from);
    const dst = resolveSafe(cwd, to);
    if (fs.existsSync(dst)) {
      if (!overwrite) {
        const err = new Error(`target exists: ${to}`) as Error & { status?: number };
        err.status = 409;
        throw err;
      }
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}