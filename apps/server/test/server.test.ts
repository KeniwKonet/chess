/**
 * Authoritative server: real WebSocket connections against an in-process
 * server. The server ticks manually here so the test is deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Match, applySnapshot, snapshotFor, type ServerMessage, type Snapshot } from '@cr/match';
import { Sim, buildRealm, stateHash } from '@cr/game-core';
import { startServer, type ServerHandle } from '../src/server';
import { Room, RATE_LIMIT } from '../src/room';

let server: ServerHandle | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function client(port: number, q: string, want: 'sun' | 'moon' | 'any') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?${q}`);
  const inbox: ServerMessage[] = [];
  const ready = new Promise<void>((res) => ws.on('open', () => res()));
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  return {
    ws,
    inbox,
    ready,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    async until<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms = 3000): Promise<T> {
      const t0 = Date.now();
      for (;;) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for a message');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    hello: () => ws.send(JSON.stringify({ t: 'hello', v: 1, want })),
  };
}
const isWelcome = (m: ServerMessage): m is Extract<ServerMessage, { t: 'welcome' }> => m.t === 'welcome';
const isAck = (seq: number) => (m: ServerMessage): m is Extract<ServerMessage, { t: 'ack' }> => m.t === 'ack' && m.seq === seq;
const lastSnap = (inbox: ServerMessage[]) => [...inbox].reverse().find((m): m is Snapshot => m.t === 'snap')!;

describe('authoritative server', () => {
  it('seats two players, applies only their own orders, and filters snapshots by fog of war', async () => {
    server = await startServer(0, { autoTick: false });
    const sun = client(server.port, 'room=duel&mode=pvp', 'sun');
    const moon = client(server.port, 'room=duel&mode=pvp', 'moon');
    await Promise.all([sun.ready, moon.ready]);
    sun.hello();
    expect((await sun.until(isWelcome)).side).toBe('sun');
    moon.hello();
    expect((await moon.until(isWelcome)).side).toBe('moon');
    const room = server.rooms.get('duel')!;

    // Fog: at the start neither side sees the other's soldiers.
    const s0 = lastSnap(sun.inbox);
    expect(s0.units.length).toBeGreaterThan(0);
    expect(s0.units.every((u) => u.side === 'sun')).toBe(true);
    expect(lastSnap(moon.inbox).units.every((u) => u.side === 'moon')).toBe(true);
    // The fog string matches the sun's real visibility.
    expect(s0.fog.length).toBe(room.match.sim.visible.sun.length);

    // Sun orders its soldiers; Moon tries to order Sun's soldiers too.
    const sunIds = room.match.sim.units.filter((u) => u.side === 'sun').map((u) => u.id);
    sun.send({ t: 'cmd', seq: 1, cmd: { kind: 'move', ids: sunIds.slice(0, 4), x: 40, z: 10 } });
    moon.send({ t: 'cmd', seq: 1, cmd: { kind: 'move', ids: sunIds, x: 60, z: 30, side: 'sun' } });
    expect((await sun.until(isAck(1))).ok).toBe(true);
    await moon.until(isAck(1));
    for (let i = 0; i < 30; i++) room.tick();
    const sim = room.match.sim;
    const moved = sunIds.filter((id) => sim.unit(id)!.order > 0);
    // Only the 4 ordered by Sun march; Moon's forged order (even claiming side "sun") moved nobody.
    expect(moved.sort()).toEqual(sunIds.slice(0, 4).sort());
  });

  it('refuses malformed orders, effect injection and floods', async () => {
    const sent: ServerMessage[] = [];
    const room = new Room('t', 'captain', true);
    room.join('sun', (m) => sent.push(m));
    room.receive('sun', { t: 'cmd', seq: 1, cmd: { kind: 'effect', effect: { kind: 'rally', ticks: 999, source: 'cheat' } } as never }, 0);
    room.receive('sun', { t: 'cmd', seq: 2, cmd: { kind: 'move', ids: [1], x: NaN, z: 1 } as never }, 0);
    const acks = sent.filter((m): m is Extract<ServerMessage, { t: 'ack' }> => m.t === 'ack');
    expect(acks.map((a) => a.ok)).toEqual([false, false]);
    // Two already used this second; 20 allowed in total, so 7 of the next 25 are refused.
    for (let i = 0; i < RATE_LIMIT + 5; i++) room.receive('sun', { t: 'cmd', seq: 10 + i, cmd: { kind: 'stop', ids: [1] } }, 500);
    const refused = sent.filter((m) => m.t === 'ack' && !m.ok && m.reason?.startsWith('Too many'));
    expect(refused).toHaveLength(7);
    // A new second, a fresh allowance.
    room.receive('sun', { t: 'cmd', seq: 99, cmd: { kind: 'stop', ids: [1] } }, 1200);
    expect(sent.at(-1)).toEqual({ t: 'ack', seq: 99, ok: true });
  });

  it('runs the War Table on the server: turn order enforced, effects applied', async () => {
    const sent: ServerMessage[] = [];
    const room = new Room('wt', 'captain', true);
    room.join('sun', (m) => sent.push(m));
    room.receive('sun', { t: 'chess', seq: 1, move: 'e5' });
    room.receive('sun', { t: 'chess', seq: 2, move: 'e4' });
    room.receive('sun', { t: 'chess', seq: 3, move: 'd4' });
    const acks = sent.filter((m): m is Extract<ServerMessage, { t: 'ack' }> => m.t === 'ack');
    expect(acks.map((a) => [a.seq, a.ok])).toEqual([[1, false], [2, true], [3, false]]);
    room.tick();
    expect(lastSnap(sent).table.log[0]).toMatchObject({ side: 'sun', san: 'e4', fx: 1 });
  });

  it('a client mirror built from snapshots matches what the server shows that side', () => {
    const match = new Match({ difficulty: 'captain' });
    for (let i = 0; i < 300; i++) match.step();
    const snap = snapshotFor(match, 'sun');
    const mirror = new Sim(buildRealm(), []);
    applySnapshot(mirror, snap, 'sun');
    expect(mirror.tick).toBe(match.sim.tick);
    const own = match.sim.units.filter((u) => u.side === 'sun');
    for (const u of own) {
      const m = mirror.unit(u.id)!;
      expect(Math.abs(m.x - u.x)).toBeLessThan(0.002);
      expect(m.hp).toBeCloseTo(u.hp, 2);
    }
    expect([...mirror.visible.sun]).toEqual([...match.sim.visible.sun]);
    expect(mirror.units.filter((u) => u.side === 'moon').every((u) => match.sim.sees('sun', u.x, u.z))).toBe(true);
  });

  it('replaying the recorded orders reproduces the exact state (desync check)', () => {
    const live = new Room('r', 'warlord', true);
    live.join('sun', () => {});
    const sunIds = live.match.sim.units.filter((u) => u.side === 'sun').map((u) => u.id);
    for (let t = 0; t < 900; t++) {
      if (t === 10) live.receive('sun', { t: 'cmd', seq: 1, cmd: { kind: 'move', ids: sunIds, x: 30, z: 19, attack: true } }, 0);
      if (t === 20) live.receive('sun', { t: 'chess', seq: 2, move: 'e4' }, 0);
      if (t === 400) live.receive('sun', { t: 'chess', seq: 3, move: 'Nf3' }, 0);
      live.tick();
    }
    // Replay: a fresh room fed the same messages at the same ticks.
    const replay = new Room('r2', 'warlord', true);
    replay.join('sun', () => {});
    const byTick = new Map<number, typeof live.log>();
    for (const e of live.log) byTick.set(e.tick, [...(byTick.get(e.tick) ?? []), e]);
    for (let t = 0; t < 900; t++) {
      for (const e of byTick.get(replay.match.sim.tick) ?? []) replay.receive(e.side, e.msg, 0);
      replay.tick();
    }
    expect(stateHash(replay.match.sim)).toBe(stateHash(live.match.sim));
  });
});
