/**
 * 本地 vsix 仓储实现 — infrastructure/extension/local.ts
 *
 * vsix 元数据/包存储（本地磁盘）:
 *   extensions/vsix/       原始 .vsix
 *   extensions/dist/<id>/  解压产物（package.json + 资源）
 */

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

import type { ServerConfig } from '../config';
import type { ExtensionRepository } from '../../domain/repositories/extension-repository';
import type { ExtensionMeta } from '../../domain/models/extension';

const PICK_FIELDS = [
  'name', 'publisher', 'version', 'displayName', 'description', 'icon',
  'activationEvents', 'contributes', 'engines', 'main', 'browser',
] as const;

function pickPkg(pkg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PICK_FIELDS) {
    if (pkg[k] !== undefined) out[k] = pkg[k];
  }
  return out;
}

export class LocalExtensionRepository implements ExtensionRepository {
  private readonly vsixDir: string;
  private readonly distDir: string;
  private readonly uploadDir: string;

  constructor(
    config: ServerConfig,
    private readonly publicHost: string,
  ) {
    this.vsixDir = path.join(config.extensionDir, 'vsix');
    this.distDir = path.join(config.extensionDir, 'dist');
    this.uploadDir = path.join(config.extensionDir, 'uploads');
    fs.mkdirSync(this.vsixDir, { recursive: true });
    fs.mkdirSync(this.distDir, { recursive: true });
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  async listMetadata(): Promise<ExtensionMeta[]> {
    const metas: ExtensionMeta[] = [];
    if (!fs.existsSync(this.distDir)) return metas;
    for (const id of fs.readdirSync(this.distDir)) {
      const pkgPath = path.join(this.distDir, id, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        metas.push({
          extension: { publisher: pkg.publisher, name: pkg.name, version: pkg.version },
          packageJSON: pickPkg(pkg),
          uri: `kt-ext://${this.publicHost}/${id}`,
        });
      } catch {
        /* skip bad entry */
      }
    }
    return metas;
  }

  async getVsixPath(name: string): Promise<string | null> {
    const full = path.join(this.vsixDir, path.basename(name));
    if (!full.startsWith(this.vsixDir) || !fs.existsSync(full)) return null;
    return full;
  }

  async upload(tmpPath: string): Promise<ExtensionMeta> {
    const zip = new AdmZip(tmpPath);
    const pkgEntry = zip.getEntry('extension/package.json');
    if (!pkgEntry) {
      throw new Error('invalid vsix: no extension/package.json');
    }
    const pkg = JSON.parse(pkgEntry.getData().toString('utf-8'));
    if (!pkg.name || !pkg.publisher || !pkg.version) {
      throw new Error('invalid vsix: missing name/publisher/version');
    }

    const id = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
    const vsixFile = path.join(this.vsixDir, `${id}.vsix`);
    fs.copyFileSync(tmpPath, vsixFile);
    fs.unlinkSync(tmpPath);

    const outDir = path.join(this.distDir, id);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith('extension/')) continue;
      const rel = entry.entryName.slice('extension/'.length);
      if (!rel) continue;
      const target = path.resolve(outDir, rel);
      if (!target.startsWith(path.resolve(outDir))) continue;
      if (entry.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
      }
    }

    return {
      extension: { publisher: pkg.publisher, name: pkg.name, version: pkg.version },
      packageJSON: pickPkg(pkg),
      uri: `kt-ext://${this.publicHost}/${id}`,
    };
  }

  async remove(name: string): Promise<void> {
    const vsixFile = path.join(this.vsixDir, path.basename(name));
    if (vsixFile.startsWith(this.vsixDir) && fs.existsSync(vsixFile)) {
      fs.unlinkSync(vsixFile);
    }
    const id = path.basename(name).replace(/\.vsix$/, '');
    const dist = path.join(this.distDir, id);
    if (dist.startsWith(this.distDir) && fs.existsSync(dist)) {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  }

  async getDistAsset(id: string, rel: string): Promise<string | null> {
    const full = path.normalize(path.join(this.distDir, path.basename(id), rel));
    if (!full.startsWith(this.distDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return null;
    }
    return full;
  }
}