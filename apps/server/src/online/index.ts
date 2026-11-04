/**
 * Online play on one HTTP server: a small JSON API under /api (accounts,
 * profiles, leaderboard, live games, finished games) and the game socket at
 * /online. CORS is open because sign-in uses a bearer token, never cookies.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, RatingCategory } from '@cr/chess-core';
import { Accounts, AuthError } from './accounts';
import { openDb, type Db } from './db';
import { Hub, type GameRow, type HubOptions } from './hub';

export interface Online {
  db: Db;
  accounts: Accounts;
  hub: Hub;
  wss: WebSocketServer;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
  close: () => Promise<void>;
}

const MAX_BODY = 4096;
const MAX_MESSAGE = 2048;

/** Per-address limit for sign-up, sign-in and guest accounts. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  ok(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export async function startOnline(server: Server, opts: { dbUrl?: string; dataDir?: string; hub?: HubOptions } = {}): Promise<Online> {
  const db = await openDb({ url: opts.dbUrl, dataDir: opts.dataDir });
  const accounts = new Accounts(db);
  const hub = new Hub(db, accounts, opts.hub);
  await hub.restore();
  const authLimit = new Limiter(20, 10 * 60_000);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  wss.on('connection', (ws: WebSocket) => {
    const conn = hub.connect((m) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    });
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);
    // Messages are handled one at a time, in order.
    let chain = Promise.resolve();
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      chain = chain.then(() => hub.receive(conn, msg)).catch((e) => console.error('online message failed', e));
    });
    ws.on('close', () => {
      clearInterval(beat);
      chain = chain.then(() => hub.disconnect(conn));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/online') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new AuthError('Too much data.', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch {
          reject(new AuthError('Bad request.'));
        }
      });
      req.on('error', reject);
    });
  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  };
  const ip = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim();

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const m = req.method ?? 'GET';
    if (m === 'POST' && (path === '/api/register' || path === '/api/login' || path === '/api/guest')) {
      if (!authLimit.ok(ip(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      const body = path === '/api/guest' ? {} : await readBody(req);
      if (path === '/api/guest') return send(res, 200, await accounts.guest());
      if (path === '/api/login') return send(res, 200, await accounts.login(body.name, body.password));
      const me = await accounts.fromToken(bearer(req));
      return send(res, 200, await accounts.register(body.name, body.password, me?.id));
    }
    if (m === 'POST' && path === '/api/logout') {
      const t = bearer(req);
      if (t) await accounts.logout(t);
      return send(res, 200, { ok: true });
    }
    if (m !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    if (path === '/api/me') {
      const me = await accounts.fromToken(bearer(req));
      if (!me) return send(res, 401, { error: 'Please sign in again.' });
      return send(res, 200, { user: await accounts.publicUser(me.id) });
    }
    if (path === '/api/leaderboard') {
      const cat = (url.searchParams.get('cat') === 'rapid' ? 'rapid' : 'blitz') as RatingCategory;
      return send(res, 200, { category: cat, players: await accounts.leaderboard(cat) });
    }
    if (path === '/api/live') return send(res, 200, { games: hub.live() });
    let hit = /^\/api\/users\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (hit) {
      const u = await accounts.byName(hit[1]!);
      if (!u) return send(res, 404, { error: 'No player with that name.' });
      const rows = await db.query<GameRow>(
        "select * from games where (white = $1 or black = $1) and status = 'over' order by ended_at desc limit 20",
        [u.id],
      );
      return send(res, 200, { user: await accounts.publicUser(u.id), games: await Promise.all(rows.map((r) => hub.record(r))) });
    }
    hit = /^\/api\/games\/([a-z0-9]{4,12})$/.exec(path);
    if (hit) {
      const row = (await db.query<GameRow>('select * from games where code = $1', [hit[1]]))[0];
      if (!row) return send(res, 404, { error: 'No game with that code.' });
      return send(res, 200, { game: await hub.record(row) });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  /** Handles /api/* and /health; returns false for anything else. */
  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path !== '/health' && !path.startsWith('/api/')) return false;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '86400');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (path === '/health') {
      send(res, 200, { ok: true, games: hub.games.size, online: hub.conns.size, db: db.kind });
      return true;
    }
    api(req, res, path, url).catch((e) => {
      if (e instanceof AuthError) send(res, e.status, { error: e.message });
      else {
        console.error('api error', e);
        send(res, 500, { error: 'Something went wrong on the server.' });
      }
    });
    return true;
  }

  return {
    db,
    accounts,
    hub,
    wss,
    handleHttp,
    close: async () => {
      hub.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await db.close();
    },
  };
}
