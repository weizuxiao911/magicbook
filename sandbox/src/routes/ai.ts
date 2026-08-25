import type { Express, Request, Response } from 'express';
import httpProxy from 'http-proxy';

export function aiRoutes(app: Express, getTarget: () => string) {
  // 全量透传 /ai/* → opencode, 仅 rewrite /ai/ → /
  const proxy = httpProxy.createProxyServer({ changeOrigin: true });

  proxy.on('error', (err, _req, res) => {
    console.error('[ai] proxy error:', err.message);
    if (!res.headersSent) {
      try { (res as any).status(502).json({ error: err.message }); } catch { /* ignore */ }
    }
  });

  const handler = (req: Request, res: Response): void => {
    // rewrite /ai/xxx → /xxx
    req.url = req.originalUrl.replace(/^\/ai/, '') || '/';
    proxy.web(req, res, { target: getTarget() });
  };

  app.all('/ai', handler);
  app.all('/ai/*', handler);
}