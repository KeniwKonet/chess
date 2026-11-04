/**
 * Serves the built game (the ./dist folder from `npm run build`) from the
 * same server as the API, so one deployment runs everything: the pages at
 * /, the API at /api, the game socket at /online.
 *
 * STATIC_DIR overrides where the files are; if the folder doesn't exist the
 * server just runs the API.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};
const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.gltf', '.txt']);

/** The repo's ./dist, found from this file (apps/server/src → ../../../dist). */
export const defaultStaticDir = () => process.env.STATIC_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../dist');

export function makeStatic(dir = defaultStaticDir()) {
  const root = resolve(dir);
  const enabled = existsSync(join(root, 'index.html'));

  function file(path: string): string | null {
    // Never outside the folder.
    const p = normalize(join(root, decodeURIComponent(path)));
    if (p !== root && !p.startsWith(root + sep)) return null;
    try {
      return statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  }

  /** Serves a file for GET/HEAD; returns false if this isn't a page or file of the game. */
  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (!enabled || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const url = new URL(req.url ?? '/', 'http://x');
    let path: string | null = null;
    try {
      path = file(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      return false;
    }
    // Paths without a file extension are pages of the game (links like /?play=… or /t/…): send index.html.
    if (!path && !extname(url.pathname)) path = join(root, 'index.html');
    if (!path) return false;
    const ext = extname(path).toLowerCase();
    const size = statSync(path).size;
    const hashed = url.pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\./.test(url.pathname);
    res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('x-content-type-options', 'nosniff');
    // Built files with a hash in the name never change; everything else is checked each visit.
    res.setHeader('cache-control', hashed ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600');
    const gzip = COMPRESS.has(ext) && size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    res.setHeader('vary', 'accept-encoding');
    if (gzip) res.setHeader('content-encoding', 'gzip');
    else res.setHeader('content-length', size);
    res.writeHead(200);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    if (gzip) stream.pipe(createGzip()).pipe(res);
    else stream.pipe(res);
    return true;
  }

  return { enabled, root, handle };
}
