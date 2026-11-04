/**
 * Clusters and Clash of Clusters against the real server, plus win streaks
 * and head-to-head records.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClashView, ClientMsg, ServerMsg } from '@cr/chess-core';
import { startServer, type ServerHandle } from '../src/server';

let server: ServerHandle | null = null;
let clock = 1_000_000;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.close();
  server = null;
});

async function boot() {
  clock = 1_000_000;
  server = await startServer(0, { autoTick: false, dataDir: 'memory://', hub: { now: () => clock, timers: false, log: () => {} } });
}
const base = () => `http://127.0.0.1:${server!.port}`;
async function call(path: string, token?: string, body?: unknown) {
  const r = await fetch(base() + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json()) as any };
}
async function account(name: string) {
  const r = await call('/api/register', undefined, { name, password: 'correct horse' });
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
    const seen = [...this.msgs].reverse().find((m) => m.t === t && pred(m as never));
    if (seen) {
      this.msgs = [];
      return Promise.resolve(seen as never);
    }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${t}: ${JSON.stringify(this.msgs.slice(-3))}`)), 5000);
      this.waiters.push({ pred: (m) => m.t === t && pred(m as never), res: (m) => (clearTimeout(timer), (this.msgs = []), res(m as never)) });
    });
  }
  clash(pred: (c: ClashView) => boolean) {
    return this.wait('clash', (m) => pred(m.clash)).then((m) => m.clash);
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

describe('clusters', () => {
  it('creates a cluster, takes people in as member, substitute and spectator, and manages roles', async () => {
    await boot();
    const king = await account('Kenneth');
    const ada = await account('Ada');
    const bram = await account('Bram');
    const cleo = await account('Cleo');
    const guest = (await call('/api/guest', undefined, {})).body.token;
    expect((await call('/api/clusters/new', guest, { name: 'Guests' })).status).toBe(403);

    const made = await call('/api/clusters/new', king.token, { name: 'Okeigbo Lions', motto: 'One army' });
    expect(made.body.cluster.you).toEqual({ status: 'member', role: 'k', king: true });
    expect((await call('/api/clusters/new', ada.token, { name: 'okeigbo lions' })).status).toBe(409);

    for (const p of [ada, bram, cleo]) expect((await call('/api/clusters/Okeigbo%20Lions/join', p.token, {})).status).toBe(200);
    // Requests are only visible to the King.
    expect((await call('/api/clusters/Okeigbo%20Lions', ada.token)).body.cluster.roster.filter((m: any) => m.status === 'pending')).toHaveLength(1);
    expect((await call('/api/clusters/Okeigbo%20Lions', king.token)).body.cluster.roster.filter((m: any) => m.status === 'pending')).toHaveLength(3);
    // Only the King decides.
    expect((await call('/api/clusters/Okeigbo%20Lions/decide', ada.token, { user: bram.id, as: 'member' })).status).toBe(403);

    let c = (await call('/api/clusters/Okeigbo%20Lions/decide', king.token, { user: ada.id, as: 'member' })).body.cluster;
    expect(c.roster.find((m: any) => m.id === ada.id)).toMatchObject({ status: 'member', role: 'q' });
    c = (await call('/api/clusters/Okeigbo%20Lions/decide', king.token, { user: bram.id, as: 'sub' })).body.cluster;
    c = (await call('/api/clusters/Okeigbo%20Lions/decide', king.token, { user: cleo.id, as: 'spectator' })).body.cluster;
    expect(c.members).toBe(2);
    expect(c.roster.map((m: any) => m.status).sort()).toEqual(['member', 'member', 'spectator', 'sub']);

    // Switch roles: Ada becomes a Raider.
    c = (await call('/api/clusters/Okeigbo%20Lions/role', king.token, { user: ada.id, role: 'n1' })).body.cluster;
    expect(c.roster.find((m: any) => m.id === ada.id).role).toBe('n1');
    // Substitution: Bram comes on for Ada and takes her role; Ada goes to the bench.
    c = (await call('/api/clusters/Okeigbo%20Lions/sub', king.token, { out: ada.id, in: bram.id })).body.cluster;
    expect(c.roster.find((m: any) => m.id === bram.id)).toMatchObject({ status: 'member', role: 'n1' });
    expect(c.roster.find((m: any) => m.id === ada.id)).toMatchObject({ status: 'sub', role: null });
    // Passing the crown: Bram becomes King, Kenneth takes Bram's Raider role.
    c = (await call('/api/clusters/Okeigbo%20Lions/role', king.token, { user: bram.id, role: 'k' })).body.cluster;
    expect(c.king).toBe('Bram');
    expect(c.roster.find((m: any) => m.id === king.id).role).toBe('n1');
    expect((await call('/api/clusters/Okeigbo%20Lions/remove', king.token, { user: ada.id })).status).toBe(403);
    // Bram leaves: the crown passes on.
    await call('/api/clusters/Okeigbo%20Lions/leave', bram.token, {});
    c = (await call('/api/clusters/Okeigbo%20Lions', king.token)).body.cluster;
    expect(c.king).toBe('Kenneth');
    expect(c.power).toBe(1500); // Kenneth is the only fighting member now.
    const list = (await call('/api/clusters?q=lion')).body.clusters;
    expect(list.map((x: any) => x.name)).toEqual(['Okeigbo Lions']);
  });
});

describe('Clash of Clusters', () => {
  it('members propose and back moves, the King plays, the timer picks the most backed, and the King hands out pieces', async () => {
    await boot();
    const k1 = await account('KingSun');
    const a = await account('Ada');
    const b = await account('Bram');
    const k2 = await account('KingMoon');
    const m2 = await account('Mira');
    await call('/api/clusters/new', k1.token, { name: 'Sun Clan' });
    await call('/api/clusters/new', k2.token, { name: 'Moon Clan' });
    for (const p of [a, b]) await call('/api/clusters/Sun%20Clan/join', p.token, {});
    await call('/api/clusters/Sun%20Clan/decide', k1.token, { user: a.id, as: 'member' });
    await call('/api/clusters/Sun%20Clan/decide', k1.token, { user: b.id, as: 'member' });
    // Ada holds the e-Footman, Bram the g-Raider.
    await call('/api/clusters/Sun%20Clan/role', k1.token, { user: a.id, role: 'p5' });
    await call('/api/clusters/Sun%20Clan/role', k1.token, { user: b.id, role: 'n2' });
    await call('/api/clusters/Moon%20Clan/join', m2.token, {});
    await call('/api/clusters/Moon%20Clan/decide', k2.token, { user: m2.id, as: 'member' });

    const s1 = await sock(k1.token);
    const sa = await sock(a.token);
    const sb = await sock(b.token);
    const s2 = await sock(k2.token);
    const sm = await sock(m2.token);
    // Only Kings start clashes.
    sa.send({ t: 'clash-create', turnSecs: 60 });
    expect((await sa.wait('error')).message).toMatch(/King/);
    s1.send({ t: 'clash-create', turnSecs: 60, target: 'Moon Clan' });
    const { code } = await s1.wait('clash-created');
    expect((await s2.wait('clash-challenges')).open.map((o) => o.code)).toEqual([code]);
    s2.send({ t: 'clash-accept', code });
    const started = await s2.clash((c) => c.status === 'playing');
    const sun: 'w' | 'b' = started.white!.name === 'Sun Clan' ? 'w' : 'b';
    const moon = sun === 'w' ? 'b' : 'w';
    // Everyone online in both clusters is brought in.
    await sa.clash((c) => c.status === 'playing');
    const watch = new WebSocket(`ws://127.0.0.1:${server!.port}/online`);
    sockets.push(watch);
    await new Promise((r) => watch.once('open', r));
    const sw = new Sock(watch);
    sw.send({ t: 'clash-open', code });
    expect((await sw.clash(() => true)).you).toBeNull();

    // Make it the Sun's turn.
    const rank = (r: number) => (sun === 'w' ? r : 9 - r);
    if (sun === 'b') {
      s2.send({ t: 'clash-propose', code, ply: 0, move: { from: 'd2', to: 'd4' } });
      await s1.clash((c) => c.moves.length === 1);
    }
    const ply = sun === 'w' ? 0 : 1;
    const e = (r: number) => `e${rank(r)}`;
    // Ada may not move Bram's Raider; she proposes her Footman.
    sa.send({ t: 'clash-propose', code, ply, move: { from: `g${rank(1)}`, to: `f${rank(3)}` } });
    expect((await sa.wait('error')).message).toMatch(/commanded by someone else/);
    sa.send({ t: 'clash-propose', code, ply, move: { from: e(2), to: e(4) } });
    sb.send({ t: 'clash-propose', code, ply, move: { from: `g${rank(1)}`, to: `f${rank(3)}` } });
    const withTwo = await s1.clash((c) => c.proposals.length === 2);
    // The other cluster and spectators don't see proposals.
    expect((await s2.clash(() => true)).proposals).toEqual([]);
    const ada = withTwo.proposals.find((p) => p.byName === 'Ada')!;
    // Bram backs Ada's move (moving his support off his own).
    sb.send({ t: 'clash-back', code, id: ada.id });
    await s1.clash((c) => c.proposals.find((p) => p.id === ada.id)!.backers.length === 2);
    // Time runs out: the most-backed move plays.
    clock += 61_000;
    await server!.online!.hub.clash!.timeUp(code);
    const after = await s1.clash((c) => c.moves.length === ply + 1);
    expect(after.moves.at(-1)).toBe(sun === 'w' ? 'e4' : 'e5');
    expect(after.lastNote).toMatch(/Ada's move, backed by 2/);

    // Moon: nobody chooses, so the army acts on its own.
    clock += 61_000;
    await server!.online!.hub.clash!.timeUp(code);
    const auto = await s1.clash((c) => c.moves.length === ply + 2);
    expect(auto.lastNote).toMatch(/acted on its own/);

    // Sun again: Bram proposes, the King picks it at once.
    sb.send({ t: 'clash-propose', code, ply: ply + 2, move: { from: `g${rank(1)}`, to: `f${rank(3)}` } });
    const p2 = (await s1.clash((c) => c.proposals.length === 1)).proposals[0]!;
    s1.send({ t: 'clash-play', code, id: p2.id });
    const chosen = await sa.clash((c) => c.moves.length === ply + 3);
    expect(chosen.lastNote).toMatch(/Bram's move, chosen by the King/);

    // The Moon King gives Mira the Sorceress, then she can propose with it.
    s2.send({ t: 'clash-assign', code, role: 'q', to: m2.id });
    const assigned = await sm.clash((c) => Object.values(c.owners).filter((o) => o === m2.id).length >= 1);
    expect(assigned.owners[`${moon}-q-d${moon === 'w' ? 1 : 8}`]).toBe(m2.id);

    // The Moon King surrenders: the Sun cluster wins and both ratings move.
    s2.send({ t: 'clash-resign', code });
    const end = await s1.clash((c) => c.status === 'over');
    expect(end.result!.winner).toBe(sun);
    expect(end.ratingChange![sun].after).toBeGreaterThan(1500);
    const lions = (await call('/api/clusters/Sun%20Clan')).body.cluster;
    expect(lions.record).toMatchObject({ clashes: 1, wins: 1 });
    expect(lions.recent[0].code).toBe(code);
  });
});

describe('streaks and head-to-head', () => {
  it('counts win streaks and the score between two players', async () => {
    await boot();
    const a = await account('Ada');
    const b = await account('Bram');
    const sa = await sock(a.token);
    const sb = await sock(b.token);
    for (let i = 0; i < 2; i++) {
      sa.send({ t: 'invite', tc: '5+3', colour: 'w', rated: false });
      const { code } = await sa.wait('invited');
      sb.send({ t: 'join', code });
      await sb.wait('game', (m) => m.game.status === 'playing');
      sa.send({ t: 'move', code, ply: 0, move: { from: 'e2', to: 'e4' } });
      sb.send({ t: 'move', code, ply: 1, move: { from: 'e7', to: 'e5' } });
      await sa.wait('move', (m) => m.ply === 2);
      sb.send({ t: 'resign', code });
      const end = await sa.wait('end');
      expect(end.streaks).toEqual({ w: i + 1, b: 0 });
      expect(end.h2h).toEqual({ wins: i + 1, losses: 0, draws: 0 });
    }
    const prof = await call('/api/users/ada', b.token);
    expect(prof.body.user.record).toMatchObject({ streak: 2, bestStreak: 2, wins: 2 });
    expect(prof.body.vsYou).toEqual({ wins: 0, losses: 2, draws: 0 });
    expect(prof.body.rivals).toEqual([{ name: 'Bram', wins: 2, losses: 0, draws: 0 }]);
  });
});
