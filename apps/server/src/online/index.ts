/**
 * Online play on one HTTP server: a JSON API under /api and the game socket
 * at /online. CORS is open (ALLOWED_ORIGINS narrows it) because sign-in uses
 * a bearer token, never cookies.
 *
 *   accounts     /api/register, /api/login, /api/guest, /api/logout, /api/me
 *   settings     /api/account/*   (password, email, reset, profile, picture, sign out everywhere, delete)
 *   people       /api/users/:name, /api/avatars/:id, /api/leaderboard, /api/friends*, /api/notifications*, /api/report
 *   games        /api/live, /api/games/:code
 *   clusters     /api/clusters*
 *   tournaments  /api/tournaments*
 *   admin        /api/admin/*     (names in ADMIN_NAMES)
 *   operations   /health, /metrics
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, RatingCategory } from '@cr/chess-core';
import { Accounts, AuthError, adminNames } from './accounts';
import { Admin } from './admin';
import { Clusters } from './clusters';
import { openDb, type Db } from './db';
import { Hub, type GameRow, type HubOptions } from './hub';
import { counters, log } from './log';
import { makeMailer, type Mailer } from './mailer';
import { Profiles } from './profile';
import { Friends, Notifier } from './social';
import { Tournaments } from './tournaments';

export interface Online {
  db: Db;
  accounts: Accounts;
  hub: Hub;
  tournaments: Tournaments;
  admin: Admin;
  wss: WebSocketServer;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
  close: () => Promise<void>;
}

export interface OnlineOptions {
  dbUrl?: string;
  dataDir?: string;
  hub?: HubOptions;
  mailer?: Mailer;
  /** Pause between tournament rounds (ms). */
  roundBreakMs?: number;
}

const MAX_BODY = 4096;
const MAX_AVATAR_BODY = 100 * 1024;
/** Room for a voice-chat session description (a few kB); everything else is far smaller. */
const MAX_MESSAGE = 20 * 1024;

/**
 * Where browsers look for a way to reach each other for voice chat. Public
 * STUN finds a direct route for most players; TURN_URLS (comma-separated, e.g.
 * "turn:turn.example.com:3478,turns:turn.example.com:5349") with TURN_USERNAME
 * and TURN_CREDENTIAL adds a relay for networks that block direct calls.
 */
function iceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const list: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean) },
  ];
  const turn = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length) list.push({ urls: turn, username: process.env.TURN_USERNAME ?? '', credential: process.env.TURN_CREDENTIAL ?? '' });
  return list;
}

/** Per-address limits. */
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

export async function startOnline(server: Server, opts: OnlineOptions = {}): Promise<Online> {
  const db = await openDb({ url: opts.dbUrl, dataDir: opts.dataDir });
  const timers = opts.hub?.timers ?? true;
  const accounts = new Accounts(db);
  const clusters = new Clusters(db, accounts);
  const notifier = new Notifier(db);
  const friends = new Friends(db, accounts, notifier);
  const profiles = new Profiles(db, accounts, clusters, opts.mailer ?? makeMailer((m) => log.info(String(m))));
  const admin = new Admin(db, accounts, notifier);
  const hub = new Hub(db, accounts, { log: (...a) => log.info(a.map(String).join(' ')), ...opts.hub }, clusters);
  const tournaments = new Tournaments(db, accounts, notifier, { timers, log: (...a) => log.warn(a.map(String).join(' ')), breakMs: opts.roundBreakMs });

  // Connect the pieces.
  hub.notifier = notifier;
  hub.friends = friends;
  notifier.push = (id, m) => {
    for (const c of hub.connsOf(id)) c.send(m);
  };
  notifier.online = (id) => hub.connsOf(id).length > 0;
  tournaments.host = hub;
  admin.kick = (id) => hub.kick(id);
  if (opts.hub?.now) admin.now = opts.hub.now;
  admin.broadcast = (text) => hub.announce(text);
  admin.liveStats = () => ({
    online: new Set([...hub.conns].map((c) => c.user?.id).filter(Boolean)).size,
    games: [...hub.games.values()].filter((g) => g.status === 'playing').length,
    clashes: [...(hub.clash?.clashes.values() ?? [])].filter((c) => c.status === 'playing').length,
  });
  hub.endListeners.push(async (e) => {
    counters.gamesFinished++;
    if (e.tournament) await tournaments.gameEnded({ code: e.code, winner: e.winner, status: e.status, reason: e.reason, ...(e.noShow ? { noShow: e.noShow } : {}) });
    if (e.status === 'over' && e.white && e.black) await admin.checkGame(e.white, e.black, e.rated, e.winner);
  });
  // Cluster join requests reach the King as a notification.
  const origJoin = clusters.requestJoin.bind(clusters);
  clusters.requestJoin = async (user, name) => {
    const out = await origJoin(user, name);
    const c = await clusters.byId(out.id);
    await notifier.notify(c.king, 'cluster', `${user.name} asks to join ${c.name}.`, { cluster: c.name });
    return out;
  };

  // Admins named in ADMIN_NAMES.
  for (const n of adminNames()) await db.query('update users set is_admin = true where name_key = $1', [n]);
  await hub.restore();
  await tournaments.restore();

  // Daily backups of the embedded database (7 kept), when there is one.
  let backupTimer: NodeJS.Timeout | null = null;
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? './data';
  if (db.backup && timers && !dataDir.startsWith('memory://')) {
    const backup = async () => {
      try {
        const dir = join(dataDir, '..', `${dataDir.split('/').filter(Boolean).pop() ?? 'data'}-backups`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `chessfront-${new Date().toISOString().slice(0, 10)}.tar.gz`), await db.backup!());
        const files = (await readdir(dir)).filter((f) => f.endsWith('.tar.gz')).sort();
        for (const f of files.slice(0, -7)) await rm(join(dir, f));
        log.info('backup written', { dir });
      } catch (e) {
        log.error('backup failed', e);
      }
    };
    backupTimer = setInterval(backup, 24 * 3600_000);
    setTimeout(backup, 60_000).unref();
  }

  const authLimit = new Limiter(20, 10 * 60_000);
  const resetLimit = new Limiter(5, 15 * 60_000);

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
      counters.messages++;
      chain = chain.then(() => hub.receive(conn, msg)).catch((e) => log.error('online message failed', e));
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
  const readBody = (req: IncomingMessage, limit = MAX_BODY) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new AuthError('Too much data.', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          resolve(v && typeof v === 'object' ? v : {});
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
  const signedIn = async (req: IncomingMessage) => {
    const me = await accounts.fromToken(bearer(req));
    if (!me) throw new AuthError('Please sign in again.', 401);
    return me;
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const m = req.method ?? 'GET';
    if (m === 'POST' && (path === '/api/register' || path === '/api/login' || path === '/api/guest')) {
      if (!authLimit.ok(ip(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      const body = path === '/api/guest' ? {} : await readBody(req);
      if (path === '/api/guest') return send(res, 200, await accounts.guest());
      if (path === '/api/login') return send(res, 200, await accounts.login(body.name, body.password));
      const me = await accounts.fromToken(bearer(req));
      counters.signups++;
      const out = await accounts.register(body.name, body.password, me?.id);
      if (typeof body.email === 'string' && body.email.trim()) {
        const u = (await accounts.user(out.user.id))!;
        await profiles.setEmail(u, body.email, body.password).catch((e: Error) => log.info('email not set at sign-up', e.message));
      }
      return send(res, 200, out);
    }
    if (path.startsWith('/api/clusters')) return clusterApi(req, res, path, url, m);
    if (path.startsWith('/api/tournaments')) return tournamentApi(req, res, path, m);
    if (path.startsWith('/api/admin/')) return adminApi(req, res, path, url, m);
    if (path.startsWith('/api/account/')) return accountApi(req, res, path, m);
    if (m === 'POST' && path === '/api/logout') {
      const t = bearer(req);
      if (t) await accounts.logout(t);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && path === '/api/report') {
      await admin.report(await signedIn(req), await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (path === '/api/friends' || path.startsWith('/api/friends/')) {
      const me = await signedIn(req);
      if (m === 'GET') return send(res, 200, { friends: await friends.list(me) });
      const body = await readBody(req);
      if (path === '/api/friends/add') return send(res, 200, await friends.request(me, body.name));
      if (path === '/api/friends/remove') {
        await friends.remove(me, body.name);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (path === '/api/notifications' || path === '/api/notifications/read') {
      const me = await signedIn(req);
      if (m === 'GET') return send(res, 200, await notifier.list(me.id));
      const body = await readBody(req);
      await notifier.markRead(me.id, Array.isArray(body.ids) ? (body.ids as number[]) : 'all');
      return send(res, 200, { ok: true });
    }
    if (m !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    if (path === '/api/me') {
      const me = await signedIn(req);
      return send(res, 200, { user: await profiles.me(me) });
    }
    if (path === '/api/leaderboard') {
      const cat = (url.searchParams.get('cat') === 'rapid' ? 'rapid' : 'blitz') as RatingCategory;
      return send(res, 200, { category: cat, players: await accounts.leaderboard(cat) });
    }
    if (path === '/api/live') return send(res, 200, { games: hub.live() });
    if (path === '/api/ice') {
      // Network helpers for voice chat. A TURN relay (if set) carries the call when two players can't reach each other directly.
      await signedIn(req);
      return send(res, 200, { iceServers: iceServers() });
    }
    let hit = /^\/api\/avatars\/(\d{1,10})$/.exec(path);
    if (hit) {
      const a = await profiles.avatar(Number(hit[1]));
      if (!a) return send(res, 404, { error: 'No picture.' });
      res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=31536000, immutable', 'content-length': a.bytes.length });
      res.end(a.bytes);
      return;
    }
    hit = /^\/api\/users\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (hit) {
      const u = await accounts.byName(hit[1]!);
      if (!u) return send(res, 404, { error: 'No player with that name.' });
      const rows = await db.query<GameRow>("select * from games where (white = $1 or black = $1) and status = 'over' order by ended_at desc limit 20", [u.id]);
      const me = await accounts.fromToken(bearer(req));
      const cl = await clusters.mine(u.id);
      return send(res, 200, {
        user: await accounts.publicUser(u.id),
        games: await Promise.all(rows.map((r) => hub.record(r))),
        rivals: await accounts.rivals(u.id),
        cluster: cl && cl.status !== 'spectator' ? (await clusters.byId(cl.clusterId)).name : null,
        // Your score against this player, when signed in.
        ...(me && me.id !== u.id ? { vsYou: await accounts.headToHead(me.id, u.id), friend: await friends.areFriends(me.id, u.id) } : {}),
      });
    }
    hit = /^\/api\/games\/([a-z0-9]{4,12})$/.exec(path);
    if (hit) {
      const row = (await db.query<GameRow>('select * from games where code = $1', [hit[1]]))[0];
      if (!row) return send(res, 404, { error: 'No game with that code.' });
      return send(res, 200, { game: await hub.record(row) });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  async function accountApi(req: IncomingMessage, res: ServerResponse, path: string, m: string) {
    if (m !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const action = path.slice('/api/account/'.length);
    // Password reset works signed out.
    if (action === 'reset-request' || action === 'reset') {
      if (!resetLimit.ok(ip(req))) return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
      const body = await readBody(req);
      if (action === 'reset-request') {
        await profiles.requestReset(body.name);
        return send(res, 200, { ok: true, message: 'If that account has an email address, a code is on its way.' });
      }
      const token = await profiles.reset(body.name, body.code, body.password);
      const me = (await accounts.fromToken(token))!;
      return send(res, 200, { token, user: await accounts.publicUser(me.id) });
    }
    const me = await signedIn(req);
    const body = await readBody(req, action === 'avatar' ? MAX_AVATAR_BODY : MAX_BODY);
    switch (action) {
      case 'password':
        await profiles.changePassword(me, body.current, body.password, bearer(req));
        break;
      case 'email':
        await profiles.setEmail(me, body.email, body.password);
        break;
      case 'profile':
        await profiles.update(me, body);
        break;
      case 'avatar':
        if (body.remove) await profiles.removeAvatar(me.id);
        else await profiles.setAvatar(me, body.data);
        break;
      case 'logout-all':
        await profiles.logoutAll(me);
        return send(res, 200, { ok: true });
      case 'delete':
        await profiles.deleteAccount(me, body.password);
        hub.kick(me.id);
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { error: 'Not found.' });
    }
    return send(res, 200, { user: await profiles.me((await accounts.user(me.id))!) });
  }

  async function adminApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL, m: string) {
    const me = admin.requireAdmin(await accounts.fromToken(bearer(req)));
    const action = path.slice('/api/admin/'.length);
    if (m === 'GET') {
      if (action === 'stats') return send(res, 200, { stats: await admin.stats() });
      if (action === 'reports') return send(res, 200, { reports: await admin.reports(url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open') });
      if (action === 'flags') return send(res, 200, { flags: await admin.flags() });
      if (action === 'users') return send(res, 200, { users: await admin.users(url.searchParams.get('q')) });
      if (action === 'audit') return send(res, 200, { audit: await admin.auditLog() });
      const hit = /^users\/(\d+)$/.exec(action);
      if (hit) return send(res, 200, { user: await admin.user(Number(hit[1])) });
      return send(res, 404, { error: 'Not found.' });
    }
    const body = await readBody(req);
    const uid = Number(body.user);
    switch (action) {
      case 'ban':
        await admin.ban(me, uid, body.days, body.reason);
        break;
      case 'unban':
        await admin.unban(me, uid);
        break;
      case 'rename':
        await admin.rename(me, uid, body.name);
        break;
      case 'clear-profile':
        await admin.clearProfile(me, uid);
        break;
      case 'resolve':
        await admin.resolve(me, Number(body.id), body.resolution);
        break;
      case 'review-flag':
        await admin.reviewFlag(me, Number(body.id));
        break;
      case 'close-cluster':
        await admin.closeCluster(me, body.name);
        break;
      case 'announce':
        return send(res, 200, { reached: await admin.announce(me, body.text) });
      default:
        return send(res, 404, { error: 'Not found.' });
    }
    return send(res, 200, { ok: true });
  }

  async function tournamentApi(req: IncomingMessage, res: ServerResponse, path: string, m: string) {
    const me = await accounts.fromToken(bearer(req));
    if (m === 'GET' && path === '/api/tournaments') return send(res, 200, { tournaments: await tournaments.list() });
    const hit = /^\/api\/tournaments\/([a-z0-9-]{1,60})(?:\/([a-z]+))?$/.exec(path);
    if (!hit) return send(res, 404, { error: 'Not found.' });
    const slug = hit[1]!;
    const action = hit[2];
    if (m === 'GET' && !action) return send(res, 200, { tournament: await tournaments.detail(slug, me) });
    if (m !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    if (!me) return send(res, 401, { error: 'Please sign in first.' });
    const body = await readBody(req);
    let out;
    if (slug === 'new' && !action) out = await tournaments.create(me, body);
    else if (action === 'join') out = await tournaments.join(me, slug);
    else if (action === 'leave') out = await tournaments.leave(me, slug);
    else if (action === 'start') out = await tournaments.start(me, slug);
    else if (action === 'cancel') out = await tournaments.cancel(me, slug);
    else if (action === 'feature') out = await tournaments.feature(me, slug, body.on !== false);
    else return send(res, 404, { error: 'Not found.' });
    return send(res, 200, { tournament: out });
  }

  async function clusterApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL, m: string) {
    const me = await accounts.fromToken(bearer(req));
    if (m === 'GET' && path === '/api/clusters') return send(res, 200, { clusters: await clusters.list(url.searchParams.get('q')) });
    if (m === 'GET' && path === '/api/clusters/mine') {
      if (!me) return send(res, 401, { error: 'Please sign in again.' });
      const mine = await clusters.mine(me.id);
      const pending = await db.query<{ name: string }>(
        "select c.name from cluster_members m join clusters c on c.id = m.cluster_id where m.user_id = $1 and m.status = 'pending'",
        [me.id],
      );
      return send(res, 200, { cluster: mine ? await clusters.detail(mine.clusterId, me) : null, requests: pending.map((p) => p.name) });
    }
    const hit = /^\/api\/clusters\/([^/]{1,40})(?:\/([a-z-]+))?$/.exec(path);
    if (!hit) return send(res, 404, { error: 'Not found.' });
    const name = decodeURIComponent(hit[1]!);
    const action = hit[2];
    if (m === 'GET' && !action) return send(res, 200, { cluster: await clusters.detail(name, me) });
    if (m !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    if (!me) return send(res, 401, { error: 'Please sign in first.' });
    const body = await readBody(req);
    const uid = Number(body.user);
    let out: unknown;
    switch (action) {
      case undefined:
        if (name !== 'new') return send(res, 404, { error: 'Not found.' });
        out = await clusters.create(me, body.name, body.motto);
        break;
      case 'join':
        out = await clusters.requestJoin(me, name);
        break;
      case 'decide':
        out = await clusters.decide(me, name, uid, body.as);
        if (body.as !== 'reject') await notifier.notify(uid, 'cluster', `You're in! ${name} took you in as ${body.as === 'member' ? 'a member' : body.as === 'sub' ? 'a substitute' : 'a spectator'}.`, { cluster: name });
        break;
      case 'role':
        out = await clusters.setRole(me, name, uid, body.role);
        break;
      case 'sub':
        out = await clusters.substitute(me, name, Number(body.out), Number(body.in));
        break;
      case 'remove':
        out = await clusters.remove(me, name, uid);
        break;
      case 'motto':
        out = await clusters.setMotto(me, name, body.motto);
        break;
      case 'leave':
        return send(res, 200, await clusters.leave(me, name));
      default:
        return send(res, 404, { error: 'Not found.' });
    }
    return send(res, 200, { cluster: out });
  }

  const allowed = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());

  /** Handles /api/*, /health and /metrics; returns false for anything else. */
  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path !== '/health' && path !== '/metrics' && !path.startsWith('/api/')) return false;
    counters.requests++;
    const origin = req.headers.origin ?? '';
    res.setHeader('access-control-allow-origin', allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0]!);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '86400');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (path === '/health') {
      send(res, 200, { ok: true, games: hub.games.size, online: hub.conns.size, db: db.kind });
      return true;
    }
    if (path === '/metrics') {
      // Prometheus text format; protected by METRICS_TOKEN when set.
      const token = process.env.METRICS_TOKEN;
      if (token && bearer(req) !== token && url.searchParams.get('token') !== token) {
        send(res, 401, { error: 'Unauthorized.' });
        return true;
      }
      const live = admin.liveStats();
      const lines = [
        `chessfront_connections ${hub.conns.size}`,
        `chessfront_players_online ${live.online}`,
        `chessfront_games_playing ${live.games}`,
        `chessfront_clashes_playing ${live.clashes}`,
        `chessfront_http_requests_total ${counters.requests}`,
        `chessfront_http_errors_total ${counters.errors}`,
        `chessfront_socket_messages_total ${counters.messages}`,
        `chessfront_signups_total ${counters.signups}`,
        `chessfront_games_finished_total ${counters.gamesFinished}`,
        `chessfront_memory_bytes ${process.memoryUsage().rss}`,
        `chessfront_uptime_seconds ${Math.round(process.uptime())}`,
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(`${lines.join('\n')}\n`);
      return true;
    }
    api(req, res, path, url).catch((e) => {
      if (e instanceof AuthError) send(res, e.status, { error: e.message });
      else {
        counters.errors++;
        log.error('api error', { path, error: (e as Error).message, stack: (e as Error).stack });
        send(res, 500, { error: 'Something went wrong on the server.' });
      }
    });
    return true;
  }

  return {
    db,
    accounts,
    hub,
    tournaments,
    admin,
    wss,
    handleHttp,
    close: async () => {
      hub.close();
      tournaments.close();
      if (backupTimer) clearInterval(backupTimer);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await db.close();
    },
  };
}
