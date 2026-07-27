import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Minimal static file server for the built client (client/dist). Unknown paths
 * fall back to index.html (single-page app). WebSocket upgrades are handled by
 * the WebSocketServer attached to this http.Server via its `upgrade` event, so
 * they never reach this request handler.
 */
export function createStaticServer(rootDir: string): Server {
  const root = normalize(rootDir);
  const index = join(root, 'index.html');

  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?', 1)[0] ?? '/');
      let filePath = normalize(join(root, urlPath));

      // Path-traversal guard: the resolved path must stay under root.
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = join(filePath, 'index.html');
        info = await stat(filePath).catch(() => null);
      }
      if (!info?.isFile()) filePath = index; // SPA fallback

      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('server error');
    }
  });
}
