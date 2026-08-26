/**
 * registry build — 扫描 vsix/ 目录,解压到 dist/,生成 metadata.json
 *
 * vsix = zip 文件,内部结构:
 *   extension/package.json
 *   extension/out/extension.js
 *   ...
 *
 * 输出:
 *   dist/<publisher>.<name>-<version>/   (解压后的 vsix 内容)
 *   dist/metadata.json                   (IExtensionBasicMetadata[])
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VSIX_DIR = path.join(ROOT, 'vsix');
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost:7790';
const PICK_FIELDS = [
    'name',
    'publisher',
    'version',
    'repository',
    'displayName',
    'description',
    'icon',
    'activationEvents',
    'sumiContributes',
    'contributes',
    'browser',
    'main',
];
function pick(pkg) {
    const out = {};
    for (const k of PICK_FIELDS) {
        if (pkg[k] !== undefined)
            out[k] = pkg[k];
    }
    return out;
}
function mergeContributes(pkg) {
    const sumi = pkg.sumiContributes ?? {};
    const cur = pkg.contributes ?? {};
    const out = { ...cur };
    for (const [k, v] of Object.entries(sumi)) {
        if (Array.isArray(v) && Array.isArray(out[k])) {
            out[k] = [...out[k], ...v];
        }
        else if (out[k] === undefined) {
            out[k] = v;
        }
    }
    return out;
}
async function main() {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    if (!fs.existsSync(VSIX_DIR)) {
        console.log(`[registry-build] no vsix/ dir, skip (${VSIX_DIR})`);
        return;
    }
    const files = fs.readdirSync(VSIX_DIR).filter((f) => f.endsWith('.vsix'));
    if (files.length === 0) {
        console.log('[registry-build] no .vsix found, skip (dist 已存在则保留)');
        return;
    }
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const metas = [];
    for (const file of files) {
        const zip = new AdmZip(path.join(VSIX_DIR, file));
        const pkgEntry = zip.getEntry('extension/package.json');
        if (!pkgEntry) {
            console.warn(`[registry-build] skip ${file}: no extension/package.json`);
            continue;
        }
        const pkg = JSON.parse(pkgEntry.getData().toString('utf-8'));
        if (!pkg.name || !pkg.publisher || !pkg.version) {
            console.warn(`[registry-build] skip ${file}: missing name/publisher/version`);
            continue;
        }
        const id = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
        const outDir = path.join(DIST_DIR, id);
        fs.mkdirSync(outDir, { recursive: true });
        // 只解压 extension/ 前缀内容, 平铺到 dist/<id>/ 根 (与 codeblitz marketplace 布局一致,
        // 让 extensionLocation = kt-ext://<host>/<id> 直接命中 vsix 内容根)
        for (const entry of zip.getEntries()) {
            if (!entry.entryName.startsWith('extension/'))
                continue;
            const rel = entry.entryName.slice('extension/'.length);
            if (!rel)
                continue;
            const target = path.resolve(outDir, rel);
            if (!target.startsWith(path.resolve(outDir)))
                continue; // 防路径穿越
            if (entry.isDirectory) {
                fs.mkdirSync(target, { recursive: true });
            }
            else {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, entry.getData());
            }
        }
        const picked = pick(pkg);
        picked.contributes = mergeContributes(pkg);
        // 生成文件清单（client 安装管线: 下载每个文件写入本地 marketplace 目录）
        const files = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                const rel = path.relative(outDir, p).split(path.sep).join('/');
                if (e.isDirectory())
                    walk(p);
                else
                    files.push(rel);
            }
        };
        walk(outDir);
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(files, null, 0));
        metas.push({
            extension: { publisher: pkg.publisher, name: pkg.name, version: pkg.version },
            packageJSON: picked,
            // codeblitz IExtensionBasicMetadata 必需字段 (getExtension 里直接取, 缺失会崩)
            defaultPkgNlsJSON: {},
            pkgNlsJSON: {},
            nlsList: [],
            extendConfig: {},
            webAssets: [],
            // mode='local' + uri: 让 codeblitz 用自定义 uri 作为扩展根, 不走默认 OSS marketplace
            mode: 'local',
            uri: `kt-ext://${PUBLIC_HOST}/${id}`,
        });
        console.log(`[registry-build] extracted ${id}`);
    }
    fs.writeFileSync(path.join(DIST_DIR, 'metadata.json'), JSON.stringify(metas, null, 2));
    console.log(`[registry-build] wrote ${metas.length} metadata entries`);
}
main().catch((err) => {
    console.error('[registry-build] failed:', err);
    process.exit(1);
});
