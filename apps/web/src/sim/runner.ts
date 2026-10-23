/**
 * Runs the game-core simulation in the browser for single-player.
 *
 * The sim ticks at a fixed 10 Hz from an accumulator; rendering interpolates
 * between ticks with `alpha`. Player input becomes commands for the next
 * tick (never direct writes to units), which is the same path a network
 * server will use. Nothing here touches React state per frame.
 */
import {
  DT,
  PATROL_SIZE,
  PatrolAI,
  Sim,
  UNIT_DEFS,
  patrolRoute,
  startingArmies,
  type SimEvent,
  type Unit,
  type UnitType,
} from '@cr/game-core';
import { realm, nearestPlaceXZ } from '../game';
import { useUi } from '../state/ui';

export const PLAYER = 'sun' as const;

const sim = new Sim(realm, startingArmies(realm));
const patrol = new PatrolAI('moon', sim.units.slice(-PATROL_SIZE).map((u) => u.id), patrolRoute(), 40);

export const game = {
  sim,
  /** 0..1 between the previous and current tick, for interpolation. */
  alpha: 0,
  acc: 0,
  paused: false,
  /** Move-order markers to animate: world point and start time (seconds). */
  markers: [] as { x: number; z: number; t0: number; ok: boolean }[],
  time: 0,
  /** Control groups 1..9. */
  groups: new Map<number, number[]>(),
};

const MAX_STEPS = 5;

export function advance(dt: number) {
  game.time += dt;
  if (game.paused) return;
  game.acc += Math.min(dt, 0.25);
  let n = 0;
  while (game.acc >= DT && n < MAX_STEPS) {
    patrol.think(sim);
    report(sim.step());
    game.acc -= DT;
    n++;
  }
  if (n === MAX_STEPS) game.acc = 0; // fell behind: drop time rather than spiral
  game.alpha = game.acc / DT;
  game.markers = game.markers.filter((m) => game.time - m.t0 < 1.2);
}

/** Interpolated render position of a unit. */
export function renderPos(u: Unit) {
  const a = game.alpha;
  const df = Math.atan2(Math.sin(u.facing - u.pfacing), Math.cos(u.facing - u.pfacing));
  return { x: u.px + (u.x - u.px) * a, z: u.pz + (u.z - u.pz) * a, facing: u.pfacing + df * a };
}

export const describeUnits = (ids: number[]) => describeGroup(ids);
export const ownSelected = () => useUi.getState().selectedUnits.filter((id) => sim.unit(id)?.side === PLAYER);

const describeGroup = (ids: number[]) => {
  const counts = new Map<UnitType, number>();
  for (const id of ids) {
    const u = sim.unit(id);
    if (u) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  }
  return [...counts]
    .map(([t, n]) => (n === 1 ? `1 ${UNIT_DEFS[t].label}` : `${n} ${UNIT_DEFS[t].plural}`))
    .join(' and ');
};

function report(events: SimEvent[]) {
  const ui = useUi.getState();
  if (events.length) ui.bumpUnits();
  for (const e of events) {
    if (e.kind === 'order') {
      if (e.side === PLAYER) ui.addLog(`${describeGroup(e.ids)} marching ${nearestPlaceXZ(e.x, e.z, true)}`, 'sun');
      else ui.addLog(`Moon patrol moving ${nearestPlaceXZ(e.x, e.z, true)}`, 'moon');
    } else if (e.kind === 'arrived' && e.side === PLAYER) {
      ui.addLog(`${describeGroup(e.ids)} in position ${nearestPlaceXZ(e.x, e.z, false)}`, 'sun');
    } else if (e.kind === 'unreachable' && e.side === PLAYER) {
      ui.addLog(`${describeGroup(e.ids)} can't reach that spot: no path over land`, 'system');
    } else if (e.kind === 'stopped' && e.side === PLAYER) {
      ui.addLog(`${describeGroup(e.ids)} halted`, 'sun');
    } else if (e.kind === 'rejected' && e.side === PLAYER) {
      ui.addLog(`Order refused: ${e.reason}`, 'system');
    }
  }
}

/** Order the selected player units to a ground point. Returns false if nothing to order. */
export function orderMove(x: number, z: number): boolean {
  const ids = useUi.getState().selectedUnits.filter((id) => sim.unit(id)?.side === PLAYER);
  if (!ids.length) return false;
  const ok = sim.grid.passableAt(x, z);
  sim.issue({ kind: 'move', side: PLAYER, ids, x, z });
  game.markers.push({ x, z, t0: game.time, ok });
  return true;
}

export function orderStop(): boolean {
  const ids = useUi.getState().selectedUnits.filter((id) => sim.unit(id)?.side === PLAYER);
  if (!ids.length) return false;
  sim.issue({ kind: 'stop', side: PLAYER, ids });
  return true;
}

export const ownUnits = (type?: UnitType) => sim.units.filter((u) => u.side === PLAYER && u.hp > 0 && (!type || u.type === type));

/** Ray against units as small upright cylinders; nearest hit within range. */
export function pickUnit(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): number | null {
  let best: number | null = null;
  let bestT = Infinity;
  const H = 0.75;
  const r = 0.32;
  for (const u of sim.units) {
    const p = renderPos(u);
    const ox = o.x - p.x;
    const oz = o.z - p.z;
    const A = d.x * d.x + d.z * d.z;
    const B = 2 * (ox * d.x + oz * d.z);
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-9 || disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    const t2 = (-B + Math.sqrt(disc)) / (2 * A);
    for (const tt of [t, t2]) {
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
    __crGame?: typeof game & { orderMove: typeof orderMove; ownUnits: typeof ownUnits };
  }
}
/** Test hook for automated checks. */
if (typeof window !== 'undefined') window.__crGame = Object.assign(game, { orderMove, ownUnits });
