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

  it('shows reactions to both players and spectators, from the fixed set only and not too fast', async () => {
    await boot();
    const { code, w, b } = await pair();
    const watcher = await connect();
    watcher.send({ t: 'watch', code });
    await watcher.game(code);

    w.send({ t: 'react', code, emoji: '🔥' });
    expect(await b.next('react')).toMatchObject({ code, by: 'w', emoji: '🔥' });
    expect((await watcher.next('react')).emoji).toBe('🔥');
    expect((await w.next('react')).by).toBe('w');

    // Too soon after the last one, or not in the set: dropped without a fuss.
    w.send({ t: 'react', code, emoji: '😂' });
    w.send({ t: 'react', code, emoji: 'free text' as never });
    // Messages are handled in order: once the pong is back, those two have been dealt with.
    w.send({ t: 'ping', at: 1 });
    await w.next('pong');
    clock += 1000;
    w.send({ t: 'react', code, emoji: '👏' });
    expect((await b.next('react')).emoji).toBe('👏');
    expect(b.msgs.filter((m) => m.t === 'react')).toHaveLength(0);

    // Spectators can't send them.
    watcher.send({ t: 'react', code, emoji: '😮' } as never);
    watcher.send({ t: 'ping', at: 1 });
    await watcher.next('pong');
    b.send({ t: 'react', code, emoji: '🤝' });
    expect((await w.next('react', (m) => m.by === 'b')).emoji).toBe('🤝');
    expect(w.msgs.some((m) => m.t === 'react' && m.emoji === '😮')).toBe(false);
  });

  it('relays voice chat signalling between the two players only, and only once both said yes', async () => {
    await boot();
    const { code, w, b, tw, tb } = await pair();
    const watcher = await connect();
    watcher.send({ t: 'watch', code });
    await watcher.game(code);

    // Network helpers for the call: signed-in players only.
    expect((await get('/api/ice')).status).toBe(401);
    const ice = await get('/api/ice', tw);
    expect(ice.body.iceServers[0].urls[0]).toMatch(/^stun:/);

    // An offer before both are on voice goes nowhere.
    w.send({ t: 'voice', code, signal: { kind: 'offer', sdp: 'v=0 early' } });
    w.send({ t: 'voice', code, signal: { kind: 'on', on: true } });
    expect((await b.next('voice')).signal).toEqual({ kind: 'on', on: true, muted: false });
    b.send({ t: 'voice', code, signal: { kind: 'on', on: true, muted: true } });
    expect((await w.next('voice')).signal).toEqual({ kind: 'on', on: true, muted: true });

    w.send({ t: 'voice', code, signal: { kind: 'offer', sdp: 'v=0 offer' } });
    expect(await b.next('voice')).toMatchObject({ from: 'w', signal: { kind: 'offer', sdp: 'v=0 offer' } });
    b.send({ t: 'voice', code, signal: { kind: 'answer', sdp: 'v=0 answer' } });
    expect((await w.next('voice')).signal).toEqual({ kind: 'answer', sdp: 'v=0 answer' });
    expect(watcher.msgs.some((m) => m.t === 'voice')).toBe(false);
    expect(b.msgs.some((m) => m.t === 'voice' && m.signal.kind === 'offer' && m.signal.sdp === 'v=0 early')).toBe(false);

    // Black drops off: White hears they left voice. Coming back, Black is told White is still on.
    b.ws.close();
    expect((await w.next('voice')).signal).toEqual({ kind: 'on', on: false });
    const b2 = await connect(tb);
    b2.send({ t: 'join', code });
    await b2.game(code);
    expect(await b2.next('voice')).toMatchObject({ from: 'w', signal: { kind: 'on', on: true, muted: false } });
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

describe('the live connection over plain HTTP', () => {
  /** A player whose browser can't use WebSockets. */
  async function httpPlayer(token: string) {
    const { body } = await post('/api/rt/open');
    const id = body.id as string;
    let after = 0;
    const got: ServerMsg[] = [];
    const say = (...msgs: ClientMsg[]) => post(`/api/rt/send?id=${id}`, { msgs });
    const poll = async () => {
      const r = await get(`/api/rt/poll?id=${id}&after=${after}`);
      for (const x of r.body.msgs as { n: number; m: ServerMsg }[]) {
        after = Math.max(after, x.n);
        got.push(x.m);
      }
      return r;
    };
    /** Polls until a message of type t arrives (a poll with nothing new waits on the server). */
    const next = async <T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) => {
      for (let i = 0; i < 10; i++) {
        const k = got.findIndex((m) => m.t === t && pred(m as never));
        if (k >= 0) return got.splice(k, 1)[0] as Extract<ServerMsg, { t: T }>;
        await poll();
      }
      throw new Error(`no ${t}; have ${JSON.stringify(got.map((m) => m.t))}`);
    };
    await say({ t: 'auth', token });
    await next('ready');
    return { id, say, next, poll };
  }

  it('plays a whole game against a WebSocket player, keeps messages until they are confirmed, and ends sessions', async () => {
    await boot();
    const ta = await account('Ada');
    const tb = await account('Bram');
    const a = await connect(ta);
    const b = await httpPlayer(tb);

    a.send({ t: 'invite', tc: '5+3', colour: 'w', rated: true });
    const { code } = await a.next('invited');
    await a.game(code);
    await b.say({ t: 'join', code });
    expect((await b.next('game', (m) => m.game.code === code)).game.status).toBe('playing');
    await a.game(code);

    a.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    expect((await b.next('move', (m) => m.ply === 1)).san).toBe('e4');
    await b.say({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    expect((await a.next('move', (m) => m.ply === 2)).san).toBe('e5');

    // A message is kept until a later poll confirms it: asking again from an older number gets it again.
    a.send({ t: 'move', code, ply: 2, move: mv('g1', 'f3') });
    const first = await b.poll();
    const again = await get(`/api/rt/poll?id=${b.id}&after=${(first.body.msgs as { n: number }[])[0]!.n - 1}`);
    expect((again.body.msgs as { n: number }[])[0]!.n).toBe((first.body.msgs as { n: number }[])[0]!.n);

    await post(`/api/rt/close?id=${b.id}`);
    expect((await get(`/api/rt/poll?id=${b.id}&after=0`)).status).toBe(404);
    expect((await post(`/api/rt/send?id=${b.id}`, { msgs: [{ t: 'ping', at: 1 }] })).status).toBe(404);
    expect((await get('/api/rt/poll?id=nonsense&after=0')).status).toBe(404);
  });
});

describe('the community', () => {
  /** White plays two moves with Black, then Black resigns. */
  async function playToWin(w: Client, b: Client, code: string) {
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    await b.next('move', (m) => m.code === code && m.ply === 1);
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.code === code && m.ply === 2);
    b.send({ t: 'resign', code });
    await w.next('end', (m) => m.code === code);
  }

  it('lets anyone read, accounts post, and keeps out guests, links, floods and suspended players', async () => {
    await boot();
    const reader = await connect();
    reader.send({ t: 'chat-open' });
    const first = await reader.next('chat');
    expect(first.messages).toEqual([]);
    expect(first.online).toBe(1);

    const ta = await account('Ada');
    const a = await connect(ta);
    a.send({ t: 'chat-open' });
    await a.next('chat');
    a.send({ t: 'chat-say', text: '  Hello   everyone!\u0007 ' });
    const said = await reader.next('chat-new');
    expect(said.message.text).toBe('Hello everyone!');
    expect(said.message.user.name).toBe('Ada');
    expect(said.message.card).toBeNull();

    // Too soon, a repeat, and a link.
    a.send({ t: 'chat-say', text: 'again' });
    expect((await a.next('error', (m) => m.code === 'chat')).message).toMatch(/Slow down/);
    clock += 3000;
    a.send({ t: 'chat-say', text: 'hello EVERYONE!' });
    expect((await a.next('error', (m) => m.code === 'chat')).message).toMatch(/just said/);
    clock += 3000;
    a.send({ t: 'chat-say', text: 'free stuff at https://spam.example' });
    expect((await a.next('error', (m) => m.code === 'chat')).message).toMatch(/Links/);
    clock += 3000;
    a.send({ t: 'chat-say', text: 'play me at https://chessfront.app/?play=abc' });
    expect((await reader.next('chat-new')).message.text).toContain('chessfront.app');

    // A guest reads but can't post.
    const guest = await post('/api/guest');
    const g = await connect(guest.body.token);
    g.send({ t: 'chat-say', text: 'hi' });
    expect((await g.next('error', (m) => m.code === 'chat')).message).toMatch(/account/);

    // Someone new sees the history.
    const late = await connect();
    late.send({ t: 'chat-open' });
    const hist = await late.next('chat');
    expect(hist.messages.map((m) => m.text)).toEqual(['Hello everyone!', 'play me at https://chessfront.app/?play=abc']);

    // A suspended player can't post.
    await server!.online!.db.query("update users set banned_until = now() + interval '1 day' where name_key = 'ada'");
    clock += 3000;
    a.send({ t: 'chat-say', text: 'still here?' });
    expect((await a.next('error', (m) => m.code === 'chat')).message).toMatch(/suspended/);
  });

  it('shares real streaks and wins, congratulates milestones, and lets owners and admins remove messages', async () => {
    await boot();
    const { code, w, b, tb } = await pair('5+3', true, ['Ada', 'Bram']);
    w.send({ t: 'chat-open' });
    await w.next('chat');
    // Nothing to share yet.
    w.send({ t: 'chat-share', what: 'streak' });
    expect((await w.next('error', (m) => m.code === 'chat')).message).toMatch(/not on a winning streak/);

    await playToWin(w, b, code);
    w.send({ t: 'chat-share', what: 'streak', text: 'on fire' });
    const streak = await w.next('chat-new');
    expect(streak.message.card).toEqual({ kind: 'streak', streak: 1, best: 1 });
    expect(streak.message.text).toBe('on fire');
    w.send({ t: 'chat-share', what: 'win' });
    const win = await w.next('chat-new');
    expect(win.message.card).toMatchObject({ kind: 'win', code, opponent: 'Bram', rated: true, tc: '5+3' });
    w.send({ t: 'chat-share', what: 'streak' });
    expect((await w.next('error', (m) => m.code === 'chat')).message).toMatch(/a moment ago/);

    // Bram can't remove Ada's message; an admin can, and everyone is told.
    b.send({ t: 'chat-delete', id: streak.message.id });
    expect((await b.next('error', (m) => m.code === 'chat')).message).toMatch(/your own/);
    await server!.online!.db.query("update users set is_admin = true where name_key = 'bram'");
    b.send({ t: 'chat-delete', id: streak.message.id });
    expect((await w.next('chat-gone')).id).toBe(streak.message.id);
    expect(tb).toBeTruthy();

    // A third straight win is a milestone: ChessFront posts it.
    for (let i = 0; i < 2; i++) {
      w.send({ t: 'invite', tc: '5+3', colour: 'w', rated: false });
      const { code: c2 } = await w.next('invited');
      await w.game(c2);
      b.send({ t: 'join', code: c2 });
      await b.game(c2);
      await playToWin(w, b, c2);
    }
    const shout = await w.next('chat-new', (m) => m.message.card?.kind === 'milestone');
    expect(shout.message.card).toEqual({ kind: 'milestone', streak: 3 });
    expect(shout.message.user.name).toBe('Ada');
  });
});

describe('analytics', () => {
  it('counts games against the computer and visits sent by browsers, and gives admins the full report', async () => {
    await boot();
    const v1 = 'visitor-one-1234';
    const v2 = 'visitor-two-5678';
    // A visit, then two games against the computer (one won, one resigned) and a pass-and-play game.
    let r = await post('/api/track', {
      visitor: v1,
      events: [
        { kind: 'visit', device: 'phone', referrer: 'l.facebook.com' },
        { kind: 'game-start', mode: 'ai', level: 'knight', game: 'gameaaaa1' },
        { kind: 'game-end', mode: 'ai', level: 'knight', game: 'gameaaaa1', result: 'win', moves: 31, seconds: 600 },
        { kind: 'game-start', mode: 'ai', level: 'warlord', game: 'gamebbbb2' },
        { kind: 'game-end', mode: 'ai', level: 'warlord', game: 'gamebbbb2', result: 'resigned', moves: 12, seconds: 200 },
        // The same event twice is counted once.
        { kind: 'game-start', mode: 'ai', level: 'warlord', game: 'gamebbbb2' },
        { kind: 'game-start', mode: 'local', game: 'gamecccc3' },
        // Not allowed: unknown kinds and modes are dropped.
        { kind: 'hack', mode: 'ai' },
        { kind: 'game-start', mode: 'online', game: 'gamedddd4' },
      ],
    });
    expect(r.body.kept).toBe(7);
    await post('/api/track', { visitor: v2, events: [{ kind: 'visit', device: 'desktop' }, { kind: 'game-start', mode: 'ai', level: 'squire', game: 'gameeeee5' }] });
    // A bad visitor id keeps nothing.
    expect((await post('/api/track', { visitor: 'x', events: [{ kind: 'visit' }] })).body.kept).toBe(0);

    const ta = await account('Ada');
    expect((await get('/api/admin/analytics', ta)).status).toBe(403);
    await server!.online!.db.query("update users set is_admin = true where name_key = 'ada'");
    const a = (await get('/api/admin/analytics?days=30', ta)).body.analytics;
    expect(a.computer).toMatchObject({ started: 3, finished: 2, startedToday: 3, players: 2, avgMoves: 22 });
    expect(a.computer.levels.find((l: { level: string }) => l.level === 'warlord')).toMatchObject({ started: 1, finished: 1, wins: 0, losses: 1 });
    expect(a.computer.results).toEqual(expect.arrayContaining([{ result: 'win', n: 1 }, { result: 'resigned', n: 1 }]));
    expect(a.local).toMatchObject({ started: 1, finished: 0 });
    expect(a.visitors).toMatchObject({ today: 2, ever: 2, visits: 2 });
    expect(a.visitors.referrers).toEqual([{ referrer: 'facebook.com', n: 1 }]);
    expect(a.visitors.devices).toEqual(expect.arrayContaining([{ device: 'phone', n: 1 }, { device: 'desktop', n: 1 }]));
    expect(a.players.accounts).toBe(1);
    expect(a.daily).toHaveLength(30);
    expect(a.daily.at(-1).computer).toBe(3);
    expect(a.trackingSince).toBeGreaterThan(0);
    expect(a.online.ever).toBe(0);
  });
});

describe('points', () => {
  it('awards points for online games and verified games against the computer, with limits', async () => {
    await boot();
    // A rated online game: the winner gets 10, the loser 2, and both are told.
    const { code, w, b, tw, tb } = await pair('5+3', true, ['Ada', 'Bram']);
    w.send({ t: 'move', code, ply: 0, move: mv('e2', 'e4') });
    await b.next('move', (m) => m.code === code && m.ply === 1);
    b.send({ t: 'move', code, ply: 1, move: mv('e7', 'e5') });
    await w.next('move', (m) => m.code === code && m.ply === 2);
    b.send({ t: 'resign', code });
    const end = await w.next('end', (m) => m.code === code);
    expect(end.points).toEqual({ w: 10, b: 2 });
    expect((await get('/api/users/Ada')).body.user.points).toBe(10);

    // Against the computer: signed in only; the server times the game.
    expect((await post('/api/computer/start', { level: 'knight' })).status).toBe(401);
    expect((await post('/api/computer/start', { level: 'grandmaster' }, tw)).status).toBe(400);
    let g = (await post('/api/computer/start', { level: 'knight' }, tw)).body;
    clock += 5_000;
    let r = (await post('/api/computer/end', { id: g.id, result: 'win', moves: 3 }, tw)).body;
    expect(r.points).toBe(0); // too short
    expect(r.note).toMatch(/30 seconds/);
    g = (await post('/api/computer/start', { level: 'warlord' }, tw)).body;
    clock += 10 * 60_000;
    r = (await post('/api/computer/end', { id: g.id, result: 'win', moves: 34 }, tw)).body;
    expect(r).toMatchObject({ points: 12, total: 22, level: 'warlord' });
    // The same game can't be counted twice.
    expect((await post('/api/computer/end', { id: g.id, result: 'win', moves: 34 }, tw)).status).toBe(409);
    // Someone else's game can't be ended.
    g = (await post('/api/computer/start', { level: 'lord' }, tw)).body;
    expect((await post('/api/computer/end', { id: g.id, result: 'win', moves: 30 }, tb)).status).toBe(409);
    clock += 60_000;
    expect((await post('/api/computer/end', { id: g.id, result: 'draw', moves: 30 }, tw)).body.points).toBe(4);
    g = (await post('/api/computer/start', { level: 'squire' }, tw)).body;
    clock += 60_000;
    expect((await post('/api/computer/end', { id: g.id, result: 'resigned', moves: 9 }, tw)).body.points).toBe(0);

    // The daily cap on computer points.
    let total = 0;
    for (let i = 0; i < 6; i++) {
      g = (await post('/api/computer/start', { level: 'warlord' }, tw)).body;
      clock += 60_000;
      total += (await post('/api/computer/end', { id: g.id, result: 'win', moves: 30 }, tw)).body.points;
    }
    expect(total).toBe(60 - 12 - 4);

    const ada = (await get('/api/users/Ada')).body.user;
    expect(ada.computer).toEqual({ games: 10, wins: 8, losses: 1, draws: 1 });
    expect(ada.points).toBe(10 + 60);
    const board = (await get('/api/leaderboard?cat=points')).body;
    expect(board.players[0]).toEqual({ name: 'Ada', points: 70 });
    expect(tb).toBeTruthy();
  });
});

describe('hints', () => {
  it('halves the points of a computer game where hints were used', async () => {
    await boot();
    const t = await account('Ada');
    const g = (await post('/api/computer/start', { level: 'warlord' }, t)).body;
    clock += 10 * 60_000;
    const r = (await post('/api/computer/end', { id: g.id, result: 'win', moves: 30, hints: 2 }, t)).body;
    expect(r).toMatchObject({ points: 6, note: expect.stringMatching(/Hints used/) });
  });
});
