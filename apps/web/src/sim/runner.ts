/**
 * Runs a Match (packages/match) in the browser for single-player.
 *
 * The sim ticks at a fixed 10 Hz from an accumulator; rendering interpolates
 * between ticks with `alpha`. Player input becomes commands for the next
 * tick (never direct writes to units), which is the same path the server
 * uses. Nothing here touches React state per frame.
 */
import { DT, UNIT_DEFS, type Difficulty, type SimEvent, type TargetRef, type Unit, type UnitType } from '@cr/game-core';
import { Match, pieceName, type TableEntry } from '@cr/match';
import { realm, nearestPlaceXZ, buildingById } from '../game';
import { useUi } from '../state/ui';
import { RemoteMatch, serverUrlFromPage } from '../net/remote';

export const PLAYER = 'sun' as const;
/** Set when playing online (?server=...): snapshots drive the mirror, nothing steps locally. */
export let remote: RemoteMatch | null = null;
export const ENEMY = 'moon' as const;

let match = new Match({ realm, difficulty: 'captain' });

export const game = {
  match,
  sim: match.sim,
  /** 0..1 between the previous and current tick, for interpolation. */
  alpha: 0,
  acc: 0,
  paused: true,
  /** Move-order markers to animate: world point and start time (seconds). */
  markers: [] as { x: number; z: number; t0: number; ok: boolean; attack: boolean }[],
  time: 0,
  /** Control groups 1..9. */
  groups: new Map<number, number[]>(),
  /** Bumped when buildings are destroyed, so the world rebuilds without them. */
  worldRev: 0,
};

/** Join a server battle instead of running one locally. */
export function connectRemote(url: string) {
  remote?.close();
  remote = new RemoteMatch(url);
  game.match = remote as unknown as Match;
  game.sim = remote.sim;
  game.paused = false;
  const ui = useUi.getState();
  ui.clearLog();
  ui.addLog('Connecting to the battle server…', 'system');
  remote.onWelcome = () => {
    ui.addLog(`Joined room as ${remote!.side === 'sun' ? 'the Sun' : 'the Moon'}${remote!.vsAi ? ` against the server's Moon AI (${remote!.difficulty})` : ''}`, 'system');
    useUi.setState({ screen: 'playing', result: null, paused: false });
  };
  remote.onSnapshot = (snap, prevTick) => {
    ui.bumpUnits();
    if (snap.tick < prevTick) game.worldRev++;
    if (snap.buildings.some((b) => b.d) && snap.tick % 10 === 0) game.worldRev++;
    if (snap.winner && !useUi.getState().result) ui.endMatch(snap.winner, snap.reason);
  };
  remote.onEvents = report;
  remote.onTable = reportTable;
  remote.onClose = (reason) => ui.addLog(reason, 'system');
}
export const onlineServer = serverUrlFromPage();

/** Start a fresh match (title screen, restart, rematch). */
export function newMatch(difficulty: Difficulty) {
  remote?.close();
  remote = null;
  match = new Match({ realm, difficulty });
  game.match = match;
  game.sim = match.sim;
  game.acc = 0;
  game.alpha = 0;
  game.markers = [];
  game.groups.clear();
  game.worldRev++;
  skirmish = { sun: 0, moon: 0, t: 0, x: 0, z: 0 };
  const ui = useUi.getState();
  ui.selectUnits([]);
  ui.select(null);
  ui.clearLog();
  ui.bumpUnits();
  ui.addLog(`Battle begins against the Moon (${difficulty}). Hold your ground or take the fight to them.`, 'system');
}

const MAX_STEPS = 5;

export function advance(dt: number) {
  game.time += dt;
  if (remote) {
    // Interpolate between the last two server snapshots (one per tick).
    game.alpha = Math.min(1, (performance.now() - remote.lastSnapAt) / (DT * 1000));
    game.markers = game.markers.filter((m) => game.time - m.t0 < 1.2);
    flushSkirmish();
    return;
  }
  if (game.paused) return;
  game.acc += Math.min(dt, 0.25);
  let n = 0;
  while (game.acc >= DT && n < MAX_STEPS) {
    const ev = match.step();
    for (const t of match.tableMoves) reportTable(t);
    report(ev);
    game.acc -= DT;
    n++;
  }
  if (n === MAX_STEPS) game.acc = 0; // fell behind: drop time rather than spiral
  game.alpha = game.acc / DT;
  game.markers = game.markers.filter((m) => game.time - m.t0 < 1.2);
  flushSkirmish();
}

/** Interpolated render position of a unit. */
export function renderPos(u: Unit) {
  const a = game.alpha;
  const df = Math.atan2(Math.sin(u.facing - u.pfacing), Math.cos(u.facing - u.pfacing));
  return { x: u.px + (u.x - u.px) * a, z: u.pz + (u.z - u.pz) * a, facing: u.pfacing + df * a };
}

/** Whether the player can see a unit (own units always; enemies only in sight). */
export const visibleToPlayer = (u: Unit) => u.side === PLAYER || game.sim.sees(PLAYER, u.x, u.z);

export const describeUnits = (ids: number[]) => describeGroup(ids);
export const ownSelected = () => useUi.getState().selectedUnits.filter((id) => game.sim.unit(id)?.side === PLAYER && game.sim.unit(id)!.hp > 0);

const describeGroup = (ids: number[]) => {
  const counts = new Map<UnitType, number>();
  for (const id of ids) {
    const u = game.sim.unit(id);
    if (u) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  }
  return [...counts].map(([t, n]) => (n === 1 ? `1 ${UNIT_DEFS[t].label}` : `${n} ${UNIT_DEFS[t].plural}`)).join(' and ');
};

export const targetName = (t: TargetRef) => (t.kind === 'building' ? (game.sim.building(t.id)?.name ?? 'a building') : (game.sim.unit(t.id)?.name ?? 'a soldier'));

/** Deaths are summarised every few seconds so the log reads like a report, not a ticker. */
let skirmish = { sun: 0, moon: 0, t: 0, x: 0, z: 0 };
function flushSkirmish() {
  if (!(skirmish.sun || skirmish.moon) || game.time - skirmish.t < 3) return;
  const ui = useUi.getState();
  const parts = [];
  if (skirmish.moon) parts.push(`Moon lost ${skirmish.moon}`);
  if (skirmish.sun) parts.push(`we lost ${skirmish.sun}`);
  ui.addLog(`Fighting ${nearestPlaceXZ(skirmish.x, skirmish.z, false)}: ${parts.join(', ')}`, skirmish.moon >= skirmish.sun ? 'sun' : 'moon');
  skirmish = { sun: 0, moon: 0, t: game.time, x: 0, z: 0 };
}

function report(events: SimEvent[]) {
  const ui = useUi.getState();
  if (events.length) ui.bumpUnits();
  for (const e of events) {
    switch (e.kind) {
      case 'order':
        if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} ${e.attack ? 'advancing to fight' : 'marching'} ${nearestPlaceXZ(e.x, e.z, true)}`, 'sun');
        else if (game.sim.sees(PLAYER, e.x, e.z)) ui.addLog(`Moon soldiers moving ${nearestPlaceXZ(e.x, e.z, true)}`, 'moon');
        break;
      case 'attackOrder':
        if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} attacking ${targetName(e.target)}`, 'sun');
        break;
      case 'arrived':
        if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} in position ${nearestPlaceXZ(e.x, e.z, false)}`, 'sun');
        break;
      case 'unreachable':
        if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} can't reach that spot: no path over land`, 'system');
        break;
      case 'stopped':
        if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} halted`, 'sun');
        break;
      case 'rejected':
        if (e.side === PLAYER) ui.addLog(`Order refused: ${e.reason}`, 'system');
        break;
      case 'killed':
        if (!skirmish.sun && !skirmish.moon) skirmish.t = game.time;
        skirmish[e.side]++;
        skirmish.x = e.x;
        skirmish.z = e.z;
        if (e.side === PLAYER) useUi.getState().selectUnits(useUi.getState().selectedUnits.filter((id) => id !== e.id));
        break;
      case 'destroyed': {
        const name = buildingById.get(e.buildingId)?.name ?? 'A building';
        ui.addLog(`${name} destroyed`, e.side === PLAYER ? 'moon' : 'sun');
        game.worldRev++;
        break;
      }
      case 'captured': {
        const c = game.sim.captures.find((x) => x.id === e.captureId)!;
        ui.addLog(e.side === 'neutral' ? `${c.name} is contested` : `${e.side === PLAYER ? 'We took' : 'The Moon took'} ${c.name}${c.id === 'vey' && e.side === PLAYER ? '. Scout Sight: our soldiers see further' : ''}`, e.side === PLAYER ? 'sun' : e.side === 'moon' ? 'moon' : 'system');
        break;
      }
      case 'reinforced':
        if (e.side === PLAYER) ui.addLog(`Reinforcements: ${describeGroup(e.ids)} join at Sunspire`, 'sun');
        break;
      case 'victory':
        ui.addLog(e.winner === PLAYER ? `Victory: ${e.reason}` : `Defeat: ${e.reason}`, e.winner === PLAYER ? 'sun' : 'moon');
        ui.endMatch(e.winner, e.reason);
        break;
      case 'effect':
        break; // reported by the War Table (milestone 5)
    }
  }
}

/** Plain-language description of a battlefield effect from the War Table. */
export function describeEffect(e: import('@cr/game-core').Effect, side: 'sun' | 'moon'): string {
  const who = side === PLAYER ? 'our' : 'Moon';
  switch (e.kind) {
    case 'advance':
      return e.unitIds.length ? `Advance: ${describeGroup(e.unitIds)} pushes forward` : 'Advance';
    case 'volley':
      return `Volley: ${describeGroup(e.unitIds)} shoot twice as fast for ${e.ticks / 10} s`;
    case 'rally':
      return `Rally: ${who} soldiers strike 15% harder for ${e.ticks / 10} s`;
    case 'fortify':
      return `Fortify: ${game.sim.building(e.buildingId)?.name ?? 'the castle'} repaired by ${e.amount}`;
    case 'bombard':
      return `Bombard: ${game.sim.building(e.buildingId)?.name ?? 'a tower'} hits twice as hard for ${e.ticks / 10} s`;
    case 'break':
      return `Break: ${e.unitIds.length ? describeGroup(e.unitIds) : (game.sim.building(e.buildingId ?? '')?.name ?? 'the regiment')} shaken for ${e.ticks / 10} s (half damage, 20% more hurt)`;
  }
}

function reportTable(t: TableEntry) {
  const ui = useUi.getState();
  const fx = t.effects.map((e) => describeEffect(e, t.side));
  ui.addLog(`War Table, ${t.side === PLAYER ? 'Sun' : 'Moon'} ${t.san}${t.check ? ' (check)' : ''}${fx.length ? `: ${fx.join('; ')}` : ': no battlefield effect'}`, t.side === PLAYER ? 'sun' : 'moon');
  ui.bumpUnits();
}

/** A War Table move by the player. */
export function playChess(move: string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) {
  if (remote) {
    // Logged when the server's board shows it (or refused via the ack).
    remote.playChess(PLAYER, move);
    return { ok: true as const };
  }
  const r = match.playChess(PLAYER, move);
  if (r.ok) reportTable(r.entry);
  else useUi.getState().addLog(`War Table: ${r.reason}`, 'system');
  return r;
}

export { pieceName };

/** Order the selected player units to a ground point. Returns false if nothing to order. */
export function orderMove(x: number, z: number, attack = false): boolean {
  const ids = ownSelected();
  if (!ids.length) return false;
  const ok = game.sim.grid.passableAt(x, z);
  game.match.issue({ kind: 'move', side: PLAYER, ids, x, z, attack });
  game.markers.push({ x, z, t0: game.time, ok, attack });
  return true;
}

/** Order the selected player units to attack an enemy unit or building. */
export function orderAttack(target: TargetRef): boolean {
  const ids = ownSelected();
  if (!ids.length) return false;
  game.match.issue({ kind: 'attack', side: PLAYER, ids, target });
  const p = game.sim.targetPos(target);
  if (p) game.markers.push({ x: p.x, z: p.z, t0: game.time, ok: true, attack: true });
  return true;
}

export function orderStop(): boolean {
  const ids = ownSelected();
  if (!ids.length) return false;
  game.match.issue({ kind: 'stop', side: PLAYER, ids });
  return true;
}

export const ownUnits = (type?: UnitType) => game.sim.units.filter((u) => u.side === PLAYER && u.hp > 0 && (!type || u.type === type));

/** Ray against living, visible units as small upright cylinders; nearest hit. */
export function pickUnit(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): number | null {
  let best: number | null = null;
  let bestT = Infinity;
  const H = 0.75;
  const r = 0.32;
  for (const u of game.sim.units) {
    if (u.hp <= 0 || !visibleToPlayer(u)) continue;
    const p = renderPos(u);
    const ox = o.x - p.x;
    const oz = o.z - p.z;
    const A = d.x * d.x + d.z * d.z;
    const B = 2 * (ox * d.x + oz * d.z);
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-9 || disc < 0) continue;
    for (const tt of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
      const y = o.y + d.y * tt;
      if (tt > 0 && y >= 0 && y <= H && tt < bestT) {
        bestT = tt;
        best = u.id;
      }
    }
  }
  return best;
}

declare global {
  interface Window {
    __crGame?: typeof game & { orderMove: typeof orderMove; ownUnits: typeof ownUnits; newMatch: typeof newMatch };
  }
}
/** Test hook for automated checks. */
if (typeof window !== 'undefined') window.__crGame = Object.assign(game, { orderMove, ownUnits, newMatch });
