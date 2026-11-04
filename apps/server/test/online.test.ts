/**
 * Online chess against the real server: accounts, invites, quick pairing,
 * refereed moves and clocks, offers, abandonment, ratings, spectators,
 * reconnection and restart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, GameView, ServerMsg } from '@cr/chess-core';
import { startServer, type ServerHandle } from '../src/server';
import { testDb } from './pg';
import { rate, NEW_RATING } from '../src/online/glicko';

let server: ServerHandle | null = null;
let clock = 1_000_000;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await server?.close();
  server = null;
});

async function boot(dataDir = 'memory://', keep = false) {
  clock = 1_000_000;
  server = await startServer(0, { autoTick: false, ...(await testDb(dataDir, keep)), hub: { now: () => clock, timers: false, log: () => {} } });
  return server;
}

const base = () => `http://127.0.0.1:${server!.port}`;

async function post(path: string, body: unknown = {}, token?: string) {
  const r = await fetch(base() + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function get(path: string, token?: string) {
  const r = await fetch(base() + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

class Client {
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.res(m);
      }
    });
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    const seen = this.msgs.find((m) => m.t === t && pred(m as never));
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1);
      return Promise.resolve(seen as never);
    }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${t}; have ${JSON.stringify(this.msgs.map((m) => m.t))}`)), 5000);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as never),
        res: (m) => {
          clearTimeout(timer);
          const i = this.msgs.indexOf(m);
          if (i >= 0) this.msgs.splice(i, 1);
          res(m as never);
        },
      });
    });
  }
  async game(code?: string): Promise<GameView> {
    return (await this.next('game', (m) => !code || m.game.code === code)).game;
  }
}

async function connect(token?: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/online`);
  await new Promise((r) => ws.once('open', r));
  const c = new Client(ws);
  clients.push(c);
  if (token) {
    c.send({ t: 'auth', token });
    await c.next('ready');
  }
  return c;
}

async function account(name: string) {
  const r = await post('/api/register', { name, password: 'correct horse' });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

/** Two players in a started game; returns them by colour. */
async function pair(tc: GameView['tc'] = '5+3', rated = true, names = ['Ada', 'Bram']) {
  const ta = await account(names[0]!);
  const tb = await account(names[1]!);
  const a = await connect(ta);
  const b = await connect(tb);
  a.send({ t: 'invite', tc, colour: 'w', rated });
  const { code } = await a.next('invited');
  await a.game(code);
  b.send({ t: 'join', code });
  const gb = await b.game(code);
  const ga = await a.game(code);
  expect(gb.status).toBe('playing');
  expect(ga.you).toBe('w');
  expect(gb.you).toBe('b');
  return { code, w: a, b, tw: ta, tb };
}

const mv = (from: string, to: string) => ({ from, to });

describe('accounts', () => {
  it('registers, signs in, rejects bad names and passwords, and keeps guests games when they sign up', async () => {
    await boot();
    expect((await post('/api/register', { name: 'ab', password: 'longenough' })).status).toBe(400);
    expect((await post('/api/register', { name: 'Ada', password: 'short' })).status).toBe(400);
    expect((await post('/api/register', { name: 'admin', password: 'longenough' })).status).toBe(400);
    const t = await account('Ada');
    expect((await post('/api/register', { name: 'ada', password: 'longenough' })).status).toBe(409);
    expect((await post('/api/login', { name: 'ADA', password: 'wrong password' })).status).toBe(401);
    const login = await post('/api/login', { name: 'ada', password: 'correct horse' });
    expect(login.body.user.name).toBe('Ada');
    expect((await get('/api/me', t)).body.user.ratings.blitz.rating).toBe(1500);

    const guest = await post('/api/guest');
    expect(guest.body.user.guest).toBe(true);
    expect(guest.body.user.name).toMatch(/^Guest-\d+$/);
    const up = await post('/api/register', { name: 'Former_Guest', password: 'longenough' }, guest.body.token);
    expect(up.body.user.id).toBe(guest.body.user.id);
    expect(up.body.user.guest).toBe(false);
    // The guest token still works and now belongs to the account.
    expect((await get('/api/me', guest.body.token)).body.user.name).toBe('Former_Guest');

    await post('/api/logout', {}, t);
    expect((await get('/api/me', t)).status).toBe(401);
  });

  it('Glicko-2 moves ratings the expected way', () => {
    const win = rate(NEW_RATING, NEW_RATING, 1);
    const loss = rate(NEW_RATING, NEW_RATING, 0);
    expect(win.rating).toBeGreaterThan(1600);
    expect(loss.rating).toBeLessThan(1400);
    expect(win.rd).toBeLessThan(350);
    // Glickman's worked example: 1500/200 beats 1400/30 → about 1563.
    const ex = rate({ rating: 1500, rd: 200, vol: 0.06 }, { rating: 1400, rd: 30, vol: 0.06 }, 1);
    expect(ex.rating).toBeGreaterThan(1555);
    expect(ex.rating).toBeLessThan(1570);
  });
});

describe('online games', () => {
  it('plays a rated game by invite link to checkmate, with spectators, and updates ratings', async () => {
    await boot();
    const { code, w, b } = await pair();
    const watcher = await connect();
    watcher.send({ t: 'watch', code });
    const wv = await watcher.game(code);
    expect(wv.you).toBeNull();
    expect((await w.next('presence', (m) => m.presence.watchers === 1)).presence).toMatchObject({ w: true, b: true });

    // Fool's mate, Black wins.
    w.send({ t: 'move', code, ply: 0, move: mv('f2', 'f3') });
    expect((await b.next('move')).san).toBe('f3');
    clock += 2000;
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.ply === 2);
    clock += 3000;
    w.send({ t: 'move', code, ply: 2, move: mv('g2', 'g4') });
    const m3 = await b.next('move', (m) => m.ply === 3);
    // White's clock starts with Black's reply; every move adds the 3 s increment (first: +3, second: -3 +3).
    expect(m3.clocks!.w).toBe(5 * 60_000 + 3000);
    expect(m3.running).toBe('b');
    b.send({ t: 'move', code, ply: 3, move: mv('d8', 'h4') });
    const end = await w.next('end');
    expect(end.result).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(end.ratingChange!.b.after).toBeGreaterThan(1500);
    expect(end.ratingChange!.w.after).toBeLessThan(1500);
    expect((await watcher.next('end')).result.winner).toBe('b');
    const moves = (await watcher.next('move', (m) => m.ply === 4)).san;
    expect(moves).toBe('Qh4#');

    const prof = await get('/api/users/bram');
    expect(prof.body.user.record).toMatchObject({ games: 1, wins: 1 });
    expect(prof.body.games[0].moves).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    const board = await get('/api/leaderboard?cat=blitz');
    expect(board.body.players[0].name).toBe('Bram');
  });

  it('refuses illegal and out-of-turn moves and resends the true position', async () => {
    await boot();
    const { code, w, b } = await pair();
    b.send({ t: 'move', code, ply: 0, move: mv('e7', 'e5') });
    expect((await b.next('error')).message).toMatch(/turn/i);
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e5') });
    expect((await w.next('error')).message).toMatch(/not legal/);
    const v = await w.game(code);
    expect(v.moves).toEqual([]);
    // A stale ply gets the whole game back instead of a move.
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    await b.next('move');
    w.send({ t: 'move', code, ply: 0, move: mv('d2', 'd4') });
    expect((await w.game(code)).moves).toEqual(['e4']);
  });

  it('runs the clock on the server: a player who runs out loses on time', async () => {
    await boot();
    const { code, w, b } = await pair('3+2');
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    await b.next('move');
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.ply === 2);
    clock += 3 * 60_000 + 2_001; // starting time plus one increment
    server!.online!.hub.tick(code);
    const end = await b.next('end');
    expect(end.result).toEqual({ winner: 'b', reason: 'timeout' });
  });

  it('calls the game off when the first move never comes, with no rating change', async () => {
    await boot();
    const { code, w } = await pair();
    clock += 31_000;
    server!.online!.hub.tick(code);
    const end = await w.next('end');
    expect(end.status).toBe('aborted');
    expect(end.ratingChange).toBeUndefined();
    expect((await get('/api/users/ada')).body.user.ratings.blitz.games).toBe(0);
  });

  it('handles draw offers, declines and acceptance', async () => {
    await boot();
    const { code, w, b } = await pair('10+5', false);
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.ply === 2);
    w.send({ t: 'draw', code });
    expect((await b.next('offer')).drawOffer).toBe('w');
    b.send({ t: 'decline', code });
    expect((await w.next('offer', (m) => m.drawOffer === null)).drawOffer).toBeNull();
    w.send({ t: 'draw', code });
    await b.next('offer', (m) => m.drawOffer === 'w');
    b.send({ t: 'draw', code });
    const end = await w.next('end');
    expect(end.result).toEqual({ winner: null, reason: 'agreement' });
    expect(end.ratingChange).toBeUndefined(); // casual
  });

  it('lets a player reconnect, and the opponent claim the win once they stay away', async () => {
    await boot();
    const { code, w, b, tb } = await pair('untimed', false);
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.ply === 2);
    b.ws.close();
    const away = await w.next('presence', (m) => m.presence.awaySince.b !== undefined);
    expect(away.presence.awaySince.b).toBe(clock);
    // Back again: the whole game is sent.
    const b2 = await connect(tb);
    b2.send({ t: 'join', code });
    const back = await b2.game(code);
    expect(back.you).toBe('b');
    expect(back.moves).toEqual(['e4', 'e5']);
    await w.next('presence', (m) => m.presence.b);
    // Gone for good: too early to claim, then a win.
    w.msgs.length = 0;
    b2.ws.close();
    await w.next('presence', (m) => m.presence.awaySince.b !== undefined);
    w.send({ t: 'claim', code });
    expect((await w.next('error')).message).toMatch(/come back/);
    clock += 61_000;
    w.send({ t: 'claim', code });
    expect((await w.next('end')).result).toEqual({ winner: 'w', reason: 'abandoned' });
  });

  it('pairs two seekers with the same time control, and only them', async () => {
    await boot();
    const a = await connect(await account('Ada'));
    const b = await connect(await account('Bram'));
    const c = await connect(await account('Cleo'));
    a.send({ t: 'seek', tc: '5+3', rated: true });
    expect((await a.next('seeking')).waiting).toBe(0);
    c.send({ t: 'seek', tc: '10+5', rated: true });
    await c.next('seeking');
    b.send({ t: 'seek', tc: '5+3', rated: true });
    const ga = await a.game();
    const gb = await b.game();
    expect(ga.code).toBe(gb.code);
    expect(new Set([ga.you, gb.you])).toEqual(new Set(['w', 'b']));
    expect(ga.rated).toBe(true);
    c.send({ t: 'cancel' });
    await c.next('cancelled');
    expect(server!.online!.hub.pool.size).toBe(0);
    // Live games list.
    expect((await get('/api/live')).body.games.map((g: { code: string }) => g.code)).toEqual([ga.code]);
  });

  it('keeps guests out of rated invites but lets them play casual ones', async () => {
    await boot();
    const host = await connect(await account('Ada'));
    const guest = await connect((await post('/api/guest')).body.token);
    host.send({ t: 'invite', tc: '5+3', colour: 'random', rated: true });
    const { code } = await host.next('invited');
    guest.send({ t: 'join', code });
    expect((await guest.next('error')).code).toBe('rated-guest');
    host.send({ t: 'invite', tc: '5+3', colour: 'random', rated: false });
    const second = (await host.next('invited')).code;
    guest.send({ t: 'join', code: second });
    expect((await guest.game(second)).status).toBe('playing');
  });

  it('starts a rematch with colours swapped when both ask', async () => {
    await boot();
    const { code, w, b } = await pair();
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.ply === 2);
    w.send({ t: 'resign', code });
    await b.next('end');
    b.send({ t: 'rematch', code });
    expect((await w.next('rematch')).by).toBe('b');
    w.send({ t: 'rematch', code });
    const next = (await w.next('rematch', (m) => !!m.next)).next!;
    w.send({ t: 'join', code: next });
    b.send({ t: 'join', code: next });
    expect((await w.game(next)).you).toBe('b');
    expect((await b.game(next)).you).toBe('w');
  });

  it('resumes games in play after the server restarts', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/cf-online-${Date.now()}`;
    await boot(dir);
    const { code, w, b, tw } = await pair('10+5');
    w.send({ t: 'move', code, ply: 0, move: mv('d2', 'd4') });
    b.send({ t: 'move', code, ply: 1, move: mv('d7', 'd5') });
    await w.next('move', (m) => m.ply === 2);
    for (const c of clients.splice(0)) c.ws.close();
    await server!.close();
    await boot(dir, true);
    const w2 = await connect(tw);
    w2.send({ t: 'join', code });
    const g = await w2.game(code);
    expect(g.status).toBe('playing');
    expect(g.moves).toEqual(['d4', 'd5']);
    expect(g.you).toBe('w');
    w2.send({ t: 'move', code, ply: 2, move: mv('c2', 'c4') });
    expect((await w2.next('move')).san).toBe('c4');
  });
});
