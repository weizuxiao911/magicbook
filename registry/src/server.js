/**
 * registry server — HTTP/HTTPS 静态文件服务,把 dist/ 暴露给 web 端
 *
 * 路由:
 *   GET /metadata.json       → IExtensionBasicMetadata[] (供 codeblitz 拉取)
 *   GET /<id>/out/*.js       → vsix 资源 (kt-ext 协议)
 *   GET /<id>/package.json   → vsix 内的 package.json
 *
 * 协议: kt-ext 不强制 https, http 即可 (codeblitz 注册 StaticResourceProvider 时按 base scheme 走).
 *   证书存在 → 启 https (推荐, 避免某些 strict-origin 环境拦截 http://127.0.0.1)
 *   证书缺失 → fallback http (本地 dev 够用)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const CERT_DIR = path.resolve(__dirname, '..', 'certs');
const PORT = Number(process.env.PORT || 7790);
const MIME = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.html': 'text/html; charset=utf-8',
    '.wasm': 'application/wasm',
};
function send(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'no-cache',
    });
    res.end(body);
}
const handler = (req, res) => {
    if (req.method === 'OPTIONS') {
        send(res, 204, '');
        return;
    }
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '/health') {
        send(res, 200, 'numas-registry ok\n');
        return;
    }
    const filePath = path.normalize(path.join(DIST_DIR, urlPath));
    if (!filePath.startsWith(DIST_DIR)) {
        send(res, 403, 'Forbidden');
        return;
    }
    try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            send(res, 200, fs.readFileSync(filePath), MIME[ext] || 'application/octet-stream');
            return;
        }
    }
    catch {
        // fallthrough
    }
    send(res, 404, 'Not Found');
};
// codeblitz kt-ext 协议强制 https; 证书存在时用 https, 缺失 fallback http
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    https
        .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
        .listen(PORT, () => {
        console.log(`[registry-server] listening https on :${PORT}, dist=${DIST_DIR}`);
    });
}
else {
    http.createServer(handler).listen(PORT, () => {
        console.log(`[registry-server] listening http on :${PORT} (kt-ext 兼容, 本地 dev 够用), dist=${DIST_DIR}`);
        console.log(`[registry-server] certs missing (registry/certs/key.pem + cert.pem), 用 http. 要 https 跑 'openssl req -x509 ...' 生成证书`);
    });
}
