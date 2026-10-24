/**
 * Network protocol for authoritative multiplayer (apps/server).
 *
 * The server owns the Match. Clients send intents (commands, War Table moves);
 * the server stamps them with the client's side, so a client can only ever
 * order its own soldiers. Every tick the server sends each client a snapshot
 * filtered by that side's fog of war: enemy soldiers and arrows outside
 * sight are simply not in the message, so they cannot be read off the wire.
 *
 * Clients mirror snapshots into a local Sim instance (applySnapshot), so the
 * renderer reads the same structures in single-player and online play.
 */
import { stateHash, type Command, type Owner, type Projectile, type Side, type SideStats, type Sim, type TargetRef, type Unit, type UnitState, type UnitType } from '@cr/game-core';
import type { Match } from './index';

export const PROTOCOL_VERSION = 1;

/** Commands as sent by a client: the server fills in `side`. */
export type ClientCommand = Command extends infer C ? (C extends { side: Side } ? Omit<C, 'side'> : never) : never;

export type ClientMessage =
  | { t: 'hello'; v: number; want: Side | 'any'; name?: string }
  | { t: 'cmd'; seq: number; cmd: ClientCommand }
  | { t: 'chess'; seq: number; move: string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } }
  | { t: 'ping'; n: number };

export interface UnitSnap {
  id: number;
  side: Side;
  type: UnitType;
  name: string;
  x: number;
  z: number;
  f: number;
  hp: number;
  max: number;
  st: UnitState;
  la: number;
  lh: number;
  da: number;
  moved: number;
  /** Own units only: what they are doing. */
  tg?: TargetRef | null;
  goal?: { x: number; z: number } | null;
  am?: boolean;
  kills?: number;
}

export interface Snapshot {
  t: 'snap';
  tick: number;
  units: UnitSnap[];
  buildings: { id: string; hp: number; d: boolean; side: Owner }[];
  captures: { id: string; owner: Owner; p: number }[];
  arrows: Projectile[];
  /** This side's visibility, one char per map cell: 0 unknown, 1 explored, 2 visible. */
  fog: string;
  stats: Record<Side, SideStats>;
  winner: Side | null;
  reason: string;
  table: { fen: string; log: { ply: number; side: Side; san: string; check: boolean; fx: number }[]; thinking: number | null };
  /** Fingerprint of the full authoritative state, every 10 ticks (for desync checks). */
  hash?: string;
}

export type ServerMessage =
  | { t: 'welcome'; v: number; side: Side; room: string; difficulty: string; vsAi: boolean }
  | { t: 'full'; reason: string }
  | Snapshot
  | { t: 'ack'; seq: number; ok: boolean; reason?: string }
  | { t: 'pong'; n: number };

/** Build the snapshot one side is allowed to see. */
export function snapshotFor(match: Match, side: Side): Snapshot {
  const sim = match.sim;
  const vis = sim.visible[side];
  const exp = sim.explored[side];
  let fog = '';
  for (let i = 0; i < vis.length; i++) fog += vis[i] ? '2' : exp[i] ? '1' : '0';
  const units: UnitSnap[] = [];
  for (const u of sim.units) {
    const own = u.side === side;
    if (!own && !sim.sees(side, u.x, u.z)) continue;
    const s: UnitSnap = {
      id: u.id,
      side: u.side,
      type: u.type,
      name: u.name,
      x: round(u.x),
      z: round(u.z),
      f: round(u.facing),
      hp: round(u.hp),
      max: u.maxHp,
      st: u.state,
      la: u.lastAttack,
      lh: u.lastHit,
      da: u.deadAt,
      moved: round(u.moved),
    };
    if (own) Object.assign(s, { tg: u.target, goal: u.goal, am: !!u.attackMove, kills: u.kills });
    units.push(s);
  }
  const arrows = sim.projectiles.filter((p) => p.visible && (p.side === side || sim.sees(side, p.x0, p.z0) || sim.sees(side, p.tx, p.tz)));
  const wt = match.warTable;
  return {
    t: 'snap',
    tick: sim.tick,
    units,
    buildings: sim.buildings.map((b) => ({ id: b.id, hp: round(b.hp), d: b.destroyed, side: b.side })),
    captures: sim.captures.map((c) => ({ id: c.id, owner: c.owner, p: round(c.progress) })),
    arrows,
    fog,
    stats: sim.stats,
    winner: sim.winner,
    reason: sim.winReason,
    table: { fen: wt.game.fen, log: wt.log.map((e) => ({ ply: e.ply, side: e.side, san: e.san, check: e.check, fx: e.effects.length })), thinking: wt.thinkingLeft() },
    ...(sim.tick % 10 === 0 ? { hash: stateHash(sim) } : {}),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Mirror a snapshot into a client-side Sim (built from the same realm, no
 * units). Positions from the previous snapshot become px/pz so rendering
 * interpolates exactly as in single-player.
 */
export function applySnapshot(sim: Sim, snap: Snapshot, side: Side) {
  const prev = new Map(sim.units.map((u) => [u.id, u]));
  const units: Unit[] = snap.units.map((s) => {
    const old = prev.get(s.id);
    return {
      id: s.id,
      side: s.side,
      type: s.type,
      name: s.name,
      x: s.x,
      z: s.z,
      px: old?.x ?? s.x,
      pz: old?.z ?? s.z,
      facing: s.f,
      pfacing: old?.facing ?? s.f,
      hp: s.hp,
      maxHp: s.max,
      state: s.st,
      goal: s.goal ?? null,
      goalHex: null,
      endFacing: null,
      order: 0,
      stuck: 0,
      best: 0,
      moved: s.moved,
      target: s.tg ?? null,
      targetOrdered: false,
      attackMove: s.am && s.goal ? s.goal : null,
      anchor: null,
      cooldown: 0,
      lastAttack: s.la,
      lastHit: s.lh,
      deadAt: s.da,
      buffs: [],
      kills: s.kills ?? 0,
    };
  });
  const mirror = sim as unknown as { units: Unit[]; byId: Map<number, Unit>; tick: number; projectiles: Projectile[]; winner: Side | null; winReason: string };
  mirror.units.splice(0, mirror.units.length, ...units);
  mirror.byId.clear();
  for (const u of units) mirror.byId.set(u.id, u);
  mirror.tick = snap.tick;
  mirror.projectiles = snap.arrows;
  mirror.winner = snap.winner;
  mirror.winReason = snap.reason;
  for (const b of snap.buildings) {
    const sb = sim.building(b.id);
    if (sb) Object.assign(sb, { hp: b.hp, destroyed: b.d, side: b.side });
  }
  for (const c of snap.captures) {
    const sc = sim.captures.find((x) => x.id === c.id);
    if (sc) Object.assign(sc, { owner: c.owner, progress: c.p });
  }
  const vis = sim.visible[side];
  const exp = sim.explored[side];
  for (let i = 0; i < snap.fog.length && i < vis.length; i++) {
    vis[i] = snap.fog[i] === '2' ? 1 : 0;
    exp[i] = snap.fog[i] === '0' ? 0 : 1;
  }
  Object.assign(sim.stats.sun, snap.stats.sun);
  Object.assign(sim.stats.moon, snap.stats.moon);
}
