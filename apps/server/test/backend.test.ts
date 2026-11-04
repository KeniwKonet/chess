/**
 * Account settings, password reset, profiles and pictures, friends and
 * challenges, notifications, reports and admin tools, fair-play flags, and
 * Swiss and knockout tournaments, all against the real server.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMsg, ServerMsg, TournamentDetail } from '@cr/chess-core';
import { startServer, type ServerHandle } from '../src/server';
import { bracketOrder } from '../src/online/tournaments';
import type { Mail } from '../src/online/mailer';
import { testDb } from './pg';

let server: ServerHandle | null = null;
let clock = 1_000_000;
const mails: Mail[] = [];
const sockets: WebSocket[] = [];

beforeAll(() => {
  process.env.ADMIN_NAMES = 'Boss';
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.close();
  server = null;
  mails.length = 0;
});

async function boot() {
  clock = 1_000_000;
  server = await startServer(0, {
    autoTick: false,
    ...(await testDb('memory://')),
    hub: { now: () => clock, timers: false, log: () => {} },
    mailer: async (m) => void mails.push(m),
    roundBreakMs: 0,
  });
}
const base = () => `http://127.0.0.1:${server!.port}`;
async function call(path: string, token?: string | null, body?: unknown) {
  const r = await fetch(base() + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json, headers: r.headers };
}
async function account(name: string, email?: string) {
  const r = await call('/api/register', null, { name, password: 'correct horse', ...(email ? { email } : {}) });
  expect(r.status).toBe(200);
  return { token: r.body.token as string, id: r.body.user.id as number, name };
}

class Sock {
  msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      this.msgs.push(m);
      for (const w of [...this.waiters])
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.res(m);
        }
    });
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    const seen = this.msgs.find((m) => m.t === t && pred(m as never));
    if (seen) {
      this.msgs.splice(this.msgs.indexOf(seen), 1);
      return Promise.resolve(seen as never);
    }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${t}: ${JSON.stringify(this.msgs.slice(-3))}`)), 5000);
      this.waiters.push({ pred: (m) => m.t === t && pred(m as never), res: (m) => (clearTimeout(timer), this.msgs.splice(this.msgs.indexOf(m), 1), res(m as never)) });
    });
  }
}
async function sock(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/online`);
  sockets.push(ws);
  await new Promise((r) => ws.once('open', r));
  const s = new Sock(ws);
  s.send({ t: 'auth', token });
  await s.wait('ready');
  return s;
}

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('account settings', () => {
  it('signs in by email, changes password (signing out elsewhere), and resets a forgotten password by emailed code', async () => {
    await boot();
    const a = await account('Ada', 'ada@example.com');
    const other = (await call('/api/login', null, { name: 'ADA@example.com', password: 'correct horse' })).body.token;
    expect((await call('/api/me', a.token)).body.user.email).toBe('ada@example.com');
    // Another account can't take the same email.
    const b = await account('Bram');
    expect((await call('/api/account/email', b.token, { email: 'ada@example.com', password: 'correct horse' })).status).toBe(409);

    expect((await call('/api/account/password', a.token, { current: 'wrong one', password: 'brand new pass' })).status).toBe(401);
    expect((await call('/api/account/password', a.token, { current: 'correct horse', password: 'brand new pass' })).status).toBe(200);
    expect((await call('/api/me', a.token)).status).toBe(200);
    expect((await call('/api/me', other)).status).toBe(401);

    // Forgotten: the answer is the same whether or not the account exists.
    expect((await call('/api/account/reset-request', null, { name: 'nobody-here' })).status).toBe(200);
    expect(mails).toHaveLength(0);
    await call('/api/account/reset-request', null, { name: 'ada' });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('ada@example.com');
    const code = /(\d{6})/.exec(mails[0]!.subject)![1]!;
    expect((await call('/api/account/reset', null, { name: 'ada', code: '000000' === code ? '111111' : '000000', password: 'third password' })).status).toBe(400);
    const reset = await call('/api/account/reset', null, { name: 'ada@example.com', code, password: 'third password' });
    expect(reset.status).toBe(200);
    expect((await call('/api/me', a.token)).status).toBe(401); // every old session ends
    expect((await call('/api/login', null, { name: 'Ada', password: 'third password' })).status).toBe(200);
    // A code works once.
    expect((await call('/api/account/reset', null, { name: 'ada', code, password: 'fourth password' })).status).toBe(400);
  });

  it('keeps a bio, country and picture, and deletes an account cleanly', async () => {
    await boot();
    const a = await account('Ada');
    const p = await call('/api/account/profile', a.token, { bio: '  Okeigbo   chess club  ', country: 'ng' });
    expect(p.body.user).toMatchObject({ bio: 'Okeigbo chess club', country: 'NG' });
    expect((await call('/api/account/profile', a.token, { country: 'Nigeria' })).status).toBe(400);
    expect((await call('/api/account/avatar', a.token, { data: Buffer.from('GIF89a').toString('base64') })).status).toBe(400);
    const up = await call('/api/account/avatar', a.token, { data: `data:image/png;base64,${PNG}` });
    expect(up.body.user.avatar).toMatch(/^\/api\/avatars\/\d+\?v=1$/);
    const img = await fetch(base() + up.body.user.avatar);
    expect(img.headers.get('content-type')).toBe('image/png');

    const b = await account('Bram');
    await call('/api/friends/add', b.token, { name: 'Ada' });
    expect((await call('/api/account/delete', a.token, { password: 'nope nope' })).status).toBe(401);
    expect((await call('/api/account/delete', a.token, { password: 'correct horse' })).status).toBe(200);
    expect((await call('/api/me', a.token)).status).toBe(401);
    expect((await call('/api/users/Ada')).status).toBe(404);
    expect((await call('/api/login', null, { name: 'Ada', password: 'correct horse' })).status).toBe(401);
    expect((await call('/api/friends', b.token)).body.friends).toEqual([]);
    // The name is free again.
    await account('Ada');
  });
});

describe('friends and notifications', () => {
  it('sends and accepts requests, shows who is online, and lets friends challenge each other', async () => {
    await boot();
    const a = await account('Ada');
    const b = await account('Bram');
    const c = await account('Cleo');
    const sb = await sock(b.token);
    expect((await call('/api/friends/add', a.token, { name: 'Bram' })).body.status).toBe('sent');
    expect((await sb.wait('notify')).note).toMatchObject({ kind: 'friend-request', text: 'Ada wants to be your friend.' });
    expect((await call('/api/friends', b.token)).body.friends[0]).toMatchObject({ name: 'Ada', status: 'received' });
    // Asking back accepts.
    expect((await call('/api/friends/add', b.token, { name: 'ada' })).body.status).toBe('friend');
    const list = (await call('/api/friends', a.token)).body.friends;
    expect(list[0]).toMatchObject({ name: 'Bram', status: 'friend', online: true });

    const sa = await sock(a.token);
    sa.send({ t: 'challenge', to: 'Bram', tc: '5+3', colour: 'w', rated: true });
    const code = (await sa.wait('invited')).code;
    const note = (await sb.wait('notify', (m) => m.note.kind === 'challenge')).note;
    expect(note.data.code).toBe(code);
    sb.send({ t: 'join', code });
    expect((await sb.wait('game', (m) => m.game.status === 'playing')).game.you).toBe('b');

    // Strangers can't be challenged directly.
    const sc = await sock(c.token);
    sc.send({ t: 'challenge', to: 'Ada', tc: '5+3', colour: 'w', rated: false });
    expect((await sc.wait('error')).message).toMatch(/friends/);

    const notes = await call('/api/notifications', b.token);
    expect(notes.body.unread).toBe(2);
    await call('/api/notifications/read', b.token, {});
    expect((await call('/api/notifications', b.token)).body.unread).toBe(0);
    // Unfriend.
    await call('/api/friends/remove', a.token, { name: 'Bram' });
    expect((await call('/api/friends', b.token)).body.friends).toEqual([]);
  });
});

describe('admin and safety', () => {
  it('takes reports, lets admins suspend, lift, rename and announce, and keeps an audit log', async () => {
    await boot();
    const boss = await account('Boss');
    const a = await account('Ada');
    const b = await account('Bram');
    expect((await call('/api/me', boss.token)).body.user.admin).toBe(true);
    expect((await call('/api/admin/stats', a.token)).status).toBe(403);

    expect((await call('/api/report', a.token, { name: 'Bram', reason: 'abuse', details: 'Rude' })).status).toBe(200);
    expect((await call('/api/report', a.token, { name: 'Bram', reason: 'because' })).status).toBe(400);
    const reports = (await call('/api/admin/reports', boss.token)).body.reports;
    expect(reports[0]).toMatchObject({ target: 'Bram', reporter: 'Ada', reason: 'abuse' });

    const sb = await sock(b.token);
    expect((await call('/api/admin/ban', boss.token, { user: b.id, days: 7, reason: 'Abuse in chat' })).status).toBe(200);
    expect((await sb.wait('error')).code).toBe('auth');
    expect((await call('/api/me', b.token)).status).toBe(401);
    const denied = await call('/api/login', null, { name: 'Bram', password: 'correct horse' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/suspended until .*Abuse in chat/);
    expect((await call('/api/admin/stats', boss.token)).body.stats).toMatchObject({ players: 3, openReports: 1, suspended: 1 });
    await call('/api/admin/unban', boss.token, { user: b.id });
    expect((await call('/api/login', null, { name: 'Bram', password: 'correct horse' })).status).toBe(200);

    await call('/api/admin/resolve', boss.token, { id: reports[0].id, resolution: 'Warned' });
    expect((await call('/api/admin/reports', boss.token)).body.reports).toEqual([]);
    expect((await call('/api/admin/rename', boss.token, { user: a.id, name: 'Ada_New' })).status).toBe(200);
    expect((await call('/api/users/Ada_New')).status).toBe(200);
    const sa = await sock(a.token);
    expect((await call('/api/admin/announce', boss.token, { text: 'Tournament at 8pm!' })).body.reached).toBeGreaterThanOrEqual(1);
    expect((await sa.wait('notify', (m) => m.note.kind === 'announcement')).note.text).toBe('Tournament at 8pm!');
    const audit = (await call('/api/admin/audit', boss.token)).body.audit.map((x: any) => x.action);
    expect(audit).toEqual(['announce', 'rename', 'resolve-report', 'unban', 'ban']);
    expect((await call('/api/admin/users?q=bram', boss.token)).body.users[0]).toMatchObject({ name: 'Bram', reported: 1 });
  });

  it('flags win trading for a human to review', async () => {
    await boot();
    const boss = await account('Boss');
    const a = await account('Ada');
    const b = await account('Bram');
    const sa = await sock(a.token);
    const sb = await sock(b.token);
    for (let i = 0; i < 4; i++) {
      sa.send({ t: 'invite', tc: '5+3', colour: 'w', rated: true });
      const { code } = await sa.wait('invited');
      sb.send({ t: 'join', code });
      await sb.wait('game', (m) => m.game.code === code && m.game.status === 'playing');
      sa.send({ t: 'move', code, ply: 0, move: { from: 'e2', to: 'e4' } });
      sb.send({ t: 'move', code, ply: 1, move: { from: 'e7', to: 'e5' } });
      await sa.wait('move', (m) => m.code === code && m.ply === 2);
      sb.send({ t: 'resign', code });
      await sa.wait('end', (m) => m.code === code);
    }
    // The checks run just after the players hear the result; give them a moment.
    let flags: any[] = [];
    for (let i = 0; i < 40 && flags.length < 2; i++) {
      flags = (await call('/api/admin/flags', boss.token)).body.flags;
      if (flags.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(flags.map((f: any) => `${f.name}:${f.kind}`).sort()).toEqual(['Ada:win-trading', 'Bram:win-trading']);
  });
});

describe('tournaments', () => {
  it('seeds a bracket so the top two seeds can only meet in the final', () => {
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  async function playOut(t: TournamentDetail, socks: Map<string, Sock>, pick: (white: string, black: string) => 'w' | 'b') {
    const round = t.schedule.at(-1)!;
    for (const g of round.games) {
      if (g.result || !g.code) continue;
      const loser = pick(g.white!.name, g.black!.name) === 'w' ? g.black!.name : g.white!.name;
      const s = socks.get(loser)!;
      s.send({ t: 'join', code: g.code });
      s.send({ t: 'resign', code: g.code });
      await s.wait('end', (m) => m.code === g.code);
    }
  }

  it('runs a Swiss tournament: pairings without rematches, a bye, forfeits, standings and a champion', async () => {
    await boot();
    const names = ['Ada', 'Bram', 'Cleo', 'Dayo', 'Ebi'];
    const ps = await Promise.all(names.map((n) => account(n)));
    const socks = new Map<string, Sock>();
    for (const p of ps) socks.set(p.name, await sock(p.token));
    const made = await call('/api/tournaments/new', ps[0]!.token, { name: 'Okeigbo Open', kind: 'swiss', tc: '5+3', rounds: 3, rated: true });
    expect(made.status).toBe(200);
    const slug = made.body.tournament.slug as string;
    expect((await call(`/api/tournaments/${slug}/start`, ps[0]!.token, {})).status).toBe(409); // nobody entered yet
    for (const p of ps) expect((await call(`/api/tournaments/${slug}/join`, p.token, {})).status).toBe(200);
    expect((await call(`/api/tournaments/${slug}/start`, ps[1]!.token, {})).status).toBe(403);
    let t = (await call(`/api/tournaments/${slug}/start`, ps[0]!.token, {})).body.tournament as TournamentDetail;
    expect(t.status).toBe('running');
    expect(t.currentRound).toBe(1);
    // Five players: two games and a bye.
    expect(t.schedule[0]!.games.filter((g) => g.result === 'bye')).toHaveLength(1);
    const playing = t.schedule[0]!.games.filter((g) => g.code);
    expect(playing).toHaveLength(2);
    // Players are taken straight to their boards.
    const w0 = socks.get(playing[0]!.white!.name)!;
    expect((await w0.wait('tournament-game')).code).toBe(playing[0]!.code);

    // Round 1: White wins on board 1; on board 2 White never moves and forfeits.
    await playOut({ ...t, schedule: [{ round: 1, games: [playing[0]!] }] }, socks, () => 'w');
    clock += 31_000;
    server!.online!.hub.tick(playing[1]!.code!);
    await new Promise((r) => setTimeout(r, 200));
    t = (await call(`/api/tournaments/${slug}`)).body.tournament;
    expect(t.schedule[0]!.games.find((g) => g.board === 2)).toMatchObject({ result: '0-1', reason: 'forfeit' });
    expect(t.currentRound).toBe(2);

    for (let r = 2; r <= 3; r++) {
      await playOut(t, socks, (w, b) => (names.indexOf(w) < names.indexOf(b) ? 'w' : 'b'));
      await new Promise((res) => setTimeout(res, 200));
      t = (await call(`/api/tournaments/${slug}`)).body.tournament;
    }
    expect(t.status).toBe('finished');
    // No rematches, and no one had two byes.
    const meetings = t.schedule.flatMap((r) => r.games.filter((g) => g.black).map((g) => [g.white!.name, g.black!.name].sort().join('-')));
    expect(new Set(meetings).size).toBe(meetings.length);
    const byes = t.schedule.flatMap((r) => r.games.filter((g) => g.result === 'bye').map((g) => g.white!.name));
    expect(new Set(byes).size).toBe(byes.length);
    expect(t.standings[0]!.score).toBeGreaterThanOrEqual(t.standings[1]!.score);
    expect(t.winner).toBe(t.standings[0]!.name);
    const champ = socks.get(t.winner!)!;
    expect((await champ.wait('notify', (m) => m.note.text.includes('You won'))).note.text).toMatch(/🏆/);
  });

  it('runs a knockout: byes for top seeds, a drawn game replayed with colours reversed, a winner', async () => {
    await boot();
    const ps = await Promise.all(['Ada', 'Bram', 'Cleo'].map((n) => account(n)));
    const socks = new Map<string, Sock>();
    for (const p of ps) socks.set(p.name, await sock(p.token));
    const slug = (await call('/api/tournaments/new', ps[0]!.token, { name: 'Lagos Knockout', kind: 'knockout', tc: '3+2' })).body.tournament.slug;
    for (const p of ps) await call(`/api/tournaments/${slug}/join`, p.token, {});
    let t = (await call(`/api/tournaments/${slug}/start`, ps[0]!.token, {})).body.tournament as TournamentDetail;
    expect(t.rounds).toBe(2);
    const r1 = t.schedule[0]!.games;
    expect(r1.filter((g) => g.result === 'bye')).toHaveLength(1);
    const game = r1.find((g) => g.code)!;
    // A draw by agreement: replayed with colours reversed.
    const w = socks.get(game.white!.name)!;
    const b = socks.get(game.black!.name)!;
    w.send({ t: 'join', code: game.code! });
    b.send({ t: 'join', code: game.code! });
    w.send({ t: 'move', code: game.code!, ply: 0, move: { from: 'e2', to: 'e4' } });
    b.send({ t: 'move', code: game.code!, ply: 1, move: { from: 'e7', to: 'e5' } });
    await w.wait('move', (m) => m.code === game.code && m.ply === 2);
    w.send({ t: 'draw', code: game.code! });
    await b.wait('offer', (m) => m.code === game.code);
    b.send({ t: 'draw', code: game.code! });
    await w.wait('end', (m) => m.code === game.code);
    await new Promise((r) => setTimeout(r, 200));
    t = (await call(`/api/tournaments/${slug}`)).body.tournament;
    const replay = t.schedule[0]!.games.find((g) => g.replay === 1)!;
    expect(replay.white!.name).toBe(game.black!.name);
    // The replay is decisive: its winner meets the top seed in the final.
    await playOut({ ...t, schedule: [{ round: 1, games: [replay] }] }, socks, () => 'w');
    await new Promise((r) => setTimeout(r, 200));
    t = (await call(`/api/tournaments/${slug}`)).body.tournament;
    expect(t.currentRound).toBe(2);
    const final = t.schedule[1]!.games[0]!;
    expect([final.white!.name, final.black!.name].sort()).toEqual([replay.white!.name, t.schedule[0]!.games.find((g) => g.result === 'bye')!.white!.name].sort());
    await playOut(t, socks, () => 'b');
    await new Promise((r) => setTimeout(r, 200));
    t = (await call(`/api/tournaments/${slug}`)).body.tournament;
    expect(t.status).toBe('finished');
    expect(t.winner).toBe(final.black!.name);
    expect(t.standings[0]!.name).toBe(final.black!.name);
  });

  it('keeps guests out of rated tournaments and lets the creator cancel', async () => {
    await boot();
    const a = await account('Ada');
    const guest = (await call('/api/guest', null, {})).body.token;
    expect((await call('/api/tournaments/new', guest, { name: 'Guest cup', tc: '5+3' })).status).toBe(403);
    const slug = (await call('/api/tournaments/new', a.token, { name: 'Rated cup', tc: '5+3', rated: true })).body.tournament.slug;
    expect((await call(`/api/tournaments/${slug}/join`, guest, {})).status).toBe(403);
    expect((await call('/api/tournaments')).body.tournaments.map((x: any) => x.slug)).toContain(slug);
    expect((await call(`/api/tournaments/${slug}/cancel`, a.token, {})).body.tournament.status).toBe('cancelled');
  });
});

describe('operations', () => {
  it('serves health, metrics and security headers', async () => {
    await boot();
    const h = await call('/health');
    expect(h.body.ok).toBe(true);
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
    const m = await fetch(base() + '/metrics');
    expect(await m.text()).toMatch(/chessfront_players_online \d+/);
  });
});
