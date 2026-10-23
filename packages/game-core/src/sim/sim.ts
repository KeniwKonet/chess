/**
 * The battlefield simulation: a fixed 10 Hz tick over plain data.
 *
 * Players (and the AI) never move units directly. They submit commands;
 * the sim validates and applies them on its next tick. That is the same
 * contract an authoritative server will use in milestone 6, so this code
 * runs unchanged there.
 *
 * Milestone 2 scope: units, move/stop orders, formations, pathfinding,
 * spacing. No combat yet: hit points never change.
 */
import { fromWorld, key, toWorld, distance, type Hex } from '../hex';
import type { RealmMap, Side } from '../map/types';
import { FieldCache, Grid, lookahead } from './field';

export type UnitType = 'infantry' | 'archer';

export interface UnitDef {
  label: string;
  plural: string;
  /** World units per second on cost-1 ground. A tile is 2 units across. */
  speed: number;
  /** Personal space, world units. */
  radius: number;
  maxHp: number;
}

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  infantry: { label: 'Swordsman', plural: 'Infantry', speed: 1.7, radius: 0.27, maxHp: 100 },
  archer: { label: 'Archer', plural: 'Archers', speed: 1.9, radius: 0.25, maxHp: 70 },
};

export type UnitState = 'idle' | 'waiting' | 'moving';

export interface Unit {
  id: number;
  side: Side;
  type: UnitType;
  name: string;
  x: number;
  z: number;
  /** Position at the start of the current tick, for render interpolation. */
  px: number;
  pz: number;
  /** Heading in radians; 0 faces +z (south), PI/2 faces +x (east). */
  facing: number;
  pfacing: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  /** Where this unit is going (its formation slot), if anywhere. */
  goal: { x: number; z: number } | null;
  goalHex: Hex | null;
  /** Facing to adopt on arrival. */
  endFacing: number | null;
  /** Order this unit is executing; arrivals are reported per order. */
  order: number;
  /** Ticks without progress, for stuck detection. */
  stuck: number;
  best: number;
  /** Distance moved this tick, for animation speed. */
  moved: number;
}

export interface UnitSpawn {
  side: Side;
  type: UnitType;
  x: number;
  z: number;
  facing?: number;
}

export type Command =
  | { kind: 'move'; side: Side; ids: number[]; x: number; z: number }
  | { kind: 'stop'; side: Side; ids: number[] };

export type SimEvent =
  | { kind: 'order'; tick: number; side: Side; order: number; ids: number[]; x: number; z: number }
  | { kind: 'arrived'; tick: number; side: Side; order: number; ids: number[]; x: number; z: number }
  | { kind: 'unreachable'; tick: number; side: Side; ids: number[]; x: number; z: number }
  | { kind: 'stopped'; tick: number; side: Side; ids: number[] }
  | { kind: 'rejected'; tick: number; side: Side; reason: string };

export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;
/** Most distance fields built per tick (performance budget from the plan). */
export const FIELD_BUDGET = 8;
const SLOT_SPACING = 0.78;
const ARRIVE_EPS = 0.06;
const STUCK_TICKS = 60;
const TURN_RATE = 10;

export class Sim {
  tick = 0;
  readonly grid: Grid;
  readonly fields: FieldCache;
  readonly units: Unit[] = [];
  private byId = new Map<number, Unit>();
  private pending: Command[] = [];
  private nextId = 1;
  private nextOrder = 1;
  /** Live orders: which units remain en route, for a single "arrived" event per order. */
  private orders = new Map<number, { side: Side; ids: Set<number>; x: number; z: number }>();
  /** Fields built during the last tick (for budget checks and stats). */
  fieldsBuiltLastTick = 0;

  constructor(readonly realm: RealmMap, spawns: UnitSpawn[] = []) {
    this.grid = new Grid(realm);
    this.fields = new FieldCache(this.grid, 32);
    for (const s of spawns) this.spawn(s);
  }

  spawn(s: UnitSpawn): Unit {
    const def = UNIT_DEFS[s.type];
    const id = this.nextId++;
    const n = this.units.filter((u) => u.side === s.side && u.type === s.type).length + 1;
    const p = this.placeable(s.x, s.z);
    const u: Unit = {
      id,
      side: s.side,
      type: s.type,
      name: `${s.side === 'sun' ? 'Sunspire' : 'Nocturne'} ${def.label} ${n}`,
      x: p.x,
      z: p.z,
      px: p.x,
      pz: p.z,
      facing: s.facing ?? 0,
      pfacing: s.facing ?? 0,
      hp: def.maxHp,
      maxHp: def.maxHp,
      state: 'idle',
      goal: null,
      goalHex: null,
      endFacing: null,
      order: 0,
      stuck: 0,
      best: Infinity,
      moved: 0,
    };
    this.units.push(u);
    this.byId.set(id, u);
    return u;
  }

  unit(id: number) {
    return this.byId.get(id);
  }

  /** Queue a command; it takes effect on the next tick. */
  issue(cmd: Command) {
    this.pending.push(cmd);
  }

  step(): SimEvent[] {
    const events: SimEvent[] = [];
    this.tick++;
    for (const u of this.units) {
      u.px = u.x;
      u.pz = u.z;
      u.pfacing = u.facing;
      u.moved = 0;
    }

    // 1. Commands, in arrival order.
    for (const cmd of this.pending.splice(0)) this.apply(cmd, events);

    // 2. Distance fields for units waiting on one, within budget.
    let built = 0;
    const waiting = this.units.filter((u) => u.state === 'waiting' && u.goalHex).sort((a, b) => a.id - b.id);
    for (const u of waiting) {
      if (!this.fields.get(u.goalHex!)) {
        if (built >= FIELD_BUDGET) continue;
        this.fields.build(u.goalHex!);
        built++;
      }
      const f = this.fields.get(u.goalHex!)!;
      if (!f.cost.has(key(fromWorld(u.x, u.z)))) {
        this.fail(u, events);
        continue;
      }
      u.state = 'moving';
      u.stuck = 0;
      u.best = Infinity;
    }
    this.fieldsBuiltLastTick = built;

    // 3. Movement, in id order for determinism.
    for (const u of this.units) if (u.state === 'moving') this.move(u, events);

    // 4. Personal space.
    this.separate();

    // 5. Turning.
    for (const u of this.units) {
      let target = u.facing;
      if (u.moved > 1e-4) target = Math.atan2(u.x - u.px, u.z - u.pz);
      else if (u.state === 'idle' && u.endFacing !== null) target = u.endFacing;
      const d = Math.atan2(Math.sin(target - u.facing), Math.cos(target - u.facing));
      const maxTurn = TURN_RATE * DT;
      u.facing += Math.max(-maxTurn, Math.min(maxTurn, d));
    }

    // 6. Orders whose units have all arrived (or given up).
    for (const [id, o] of this.orders) {
      for (const uid of [...o.ids]) {
        const u = this.byId.get(uid);
        if (!u || u.order !== id || u.state === 'idle') o.ids.delete(uid);
      }
      if (o.ids.size === 0) {
        const arrived = this.units.filter((u) => u.order === id && u.state === 'idle').map((u) => u.id);
        if (arrived.length) events.push({ kind: 'arrived', tick: this.tick, side: o.side, order: id, ids: arrived, x: o.x, z: o.z });
        this.orders.delete(id);
      }
    }
    return events;
  }

  private apply(cmd: Command, events: SimEvent[]) {
    const units = [...new Set(cmd.ids)]
      .map((id) => this.byId.get(id))
      .filter((u): u is Unit => !!u && u.side === cmd.side && u.hp > 0)
      .sort((a, b) => a.id - b.id);
    if (!units.length) {
      events.push({ kind: 'rejected', tick: this.tick, side: cmd.side, reason: 'No units of yours in that order' });
      return;
    }
    if (cmd.kind === 'stop') {
      for (const u of units) {
        u.state = 'idle';
        u.goal = null;
        u.goalHex = null;
        u.endFacing = null;
        u.order = 0;
      }
      events.push({ kind: 'stopped', tick: this.tick, side: cmd.side, ids: units.map((u) => u.id) });
      return;
    }
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.z)) {
      events.push({ kind: 'rejected', tick: this.tick, side: cmd.side, reason: 'Invalid destination' });
      return;
    }
    const target = this.placeable(cmd.x, cmd.z);
    const slots = formation(units, target, this);
    const order = this.nextOrder++;
    const ids = new Set<number>();
    units.forEach((u, i) => {
      const s = slots[i]!;
      u.goal = { x: s.x, z: s.z };
      u.goalHex = fromWorld(s.x, s.z);
      u.endFacing = s.facing;
      u.state = 'waiting';
      u.order = order;
      u.stuck = 0;
      u.best = Infinity;
      ids.add(u.id);
    });
    this.orders.set(order, { side: cmd.side, ids, x: target.x, z: target.z });
    events.push({ kind: 'order', tick: this.tick, side: cmd.side, order, ids: [...ids], x: target.x, z: target.z });
  }

  private fail(u: Unit, events: SimEvent[]) {
    const g = u.goal!;
    u.state = 'idle';
    u.goal = null;
    u.goalHex = null;
    u.endFacing = null;
    events.push({ kind: 'unreachable', tick: this.tick, side: u.side, ids: [u.id], x: g.x, z: g.z });
  }

  private move(u: Unit, events: SimEvent[]) {
    const goal = u.goal!;
    const gh = u.goalHex!;
    let here = fromWorld(u.x, u.z);
    if (!this.grid.passable(here)) {
      // Nudged onto a blocked tile edge: step back to the nearest open ground.
      const p = this.grid.nearestPassable(here)!;
      const c = toWorld(p);
      u.x = c.x;
      u.z = c.z;
      here = p;
    }
    const field = this.fields.get(gh);
    if (!field) {
      u.state = 'waiting';
      return;
    }
    let tx = goal.x;
    let tz = goal.z;
    const atGoalCell = here.q === gh.q && here.r === gh.r;
    if (!atGoalCell) {
      const next = lookahead(this.grid, field, here, 4, u);
      if (!next) return this.fail(u, events);
      if (next.q !== gh.q || next.r !== gh.r) {
        const c = toWorld(next);
        tx = c.x;
        tz = c.z;
      }
      // If even the next step's straight line is blocked (unit pushed into a corner), recentre first.
      if (!this.grid.clearSegment(u.x, u.z, tx, tz)) {
        const c = toWorld(here);
        tx = c.x;
        tz = c.z;
      }
    }
    const dx = tx - u.x;
    const dz = tz - u.z;
    const d = Math.hypot(dx, dz);
    const speed = UNIT_DEFS[u.type].speed / this.grid.cost(here);
    const stepLen = speed * DT;
    const toGoal = Math.hypot(goal.x - u.x, goal.z - u.z);
    if (atGoalCell && toGoal <= Math.max(stepLen, ARRIVE_EPS)) {
      if (this.grid.passableAt(goal.x, goal.z)) {
        u.moved += toGoal;
        u.x = goal.x;
        u.z = goal.z;
      }
      this.arrive(u);
      return;
    }
    const k = d > 1e-6 ? Math.min(stepLen, d) / d : 0;
    this.tryMove(u, dx * k, dz * k);

    // Progress = remaining field cost; reset the stuck counter whenever it improves.
    const now = (field.cost.get(key(fromWorld(u.x, u.z))) ?? Infinity) + Math.hypot(goal.x - u.x, goal.z - u.z) * 0.01;
    if (now < u.best - 1e-3) {
      u.best = now;
      u.stuck = 0;
    } else if (++u.stuck > STUCK_TICKS) {
      // Crowded at the destination: close enough counts as arrived.
      if (Math.hypot(goal.x - u.x, goal.z - u.z) < 1.4) this.arrive(u);
      else this.fail(u, events);
    }
  }

  private arrive(u: Unit) {
    u.state = 'idle';
    u.goal = null;
    u.goalHex = null;
  }

  /** Move by (dx, dz), sliding along blocked tiles instead of entering them. */
  private tryMove(u: Unit, dx: number, dz: number): boolean {
    const g = this.grid;
    const options: [number, number][] = [
      [dx, dz],
      [dx, 0],
      [0, dz],
    ];
    for (const [ox, oz] of options) {
      if ((ox || oz) && g.passableAt(u.x + ox, u.z + oz)) {
        u.x += ox;
        u.z += oz;
        u.moved += Math.hypot(ox, oz);
        return true;
      }
    }
    return false;
  }

  private separate() {
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i]!;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j]!;
        const min = UNIT_DEFS[a.type].radius + UNIT_DEFS[b.type].radius;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          // Exactly overlapping: separate along a fixed, id-based direction.
          const ang = (a.id * 2.399) % (Math.PI * 2);
          dx = Math.cos(ang);
          dz = Math.sin(ang);
          d = 1;
        }
        const push = (min - d) / 2;
        const nx = (dx / d) * push;
        const nz = (dz / d) * push;
        // Idle units give way less than moving ones.
        const wa = a.state === 'idle' && b.state !== 'idle' ? 0.3 : b.state === 'idle' && a.state !== 'idle' ? 1.7 : 1;
        this.tryMove(a, -nx * wa, -nz * wa);
        this.tryMove(b, nx * (2 - wa), nz * (2 - wa));
      }
    }
  }

  /** A standable point near (x, z): the point itself, or the centre of the nearest open tile. */
  placeable(x: number, z: number): { x: number; z: number } {
    if (this.grid.passableAt(x, z)) return { x, z };
    const h = this.grid.nearestPassable(fromWorld(x, z));
    return h ? toWorld(h) : { x, z };
  }
}

/**
 * Formation slots for a group: rows facing the direction of travel, infantry
 * in front and archers behind, each slot moved onto open ground.
 */
export function formation(units: Unit[], target: { x: number; z: number }, sim: Sim): { x: number; z: number; facing: number }[] {
  const n = units.length;
  const cx = units.reduce((s, u) => s + u.x, 0) / n;
  const cz = units.reduce((s, u) => s + u.z, 0) / n;
  let fx = target.x - cx;
  let fz = target.z - cz;
  const fl = Math.hypot(fx, fz);
  if (fl < 0.5) {
    fx = Math.sin(units[0]!.facing);
    fz = Math.cos(units[0]!.facing);
  } else {
    fx /= fl;
    fz /= fl;
  }
  const facing = Math.atan2(fx, fz);
  const rx = -fz;
  const rz = fx;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(n * 1.6))));
  // Infantry first (front rows), then archers; within a type, by lateral position so paths don't cross.
  const order = units
    .map((u, i) => ({ u, i, lat: (u.x - cx) * rx + (u.z - cz) * rz }))
    .sort((a, b) => (a.u.type === b.u.type ? a.lat - b.lat || a.u.id - b.u.id : a.u.type === 'infantry' ? -1 : 1));
  const out: { x: number; z: number; facing: number }[] = new Array(n);
  const taken: { x: number; z: number }[] = [];
  const rows = Math.ceil(n / cols);
  order.forEach((o, k) => {
    const row = Math.floor(k / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = k % cols;
    const lat = (col - (inRow - 1) / 2) * SLOT_SPACING;
    const back = row * SLOT_SPACING;
    let x = target.x + rx * lat - fx * back;
    let z = target.z + rz * lat - fz * back;
    if (!sim.grid.passableAt(x, z)) {
      const p = sim.placeable(x, z);
      x = p.x;
      z = p.z;
    }
    // Avoid stacking two slots on the same spot after snapping.
    let tries = 0;
    while (taken.some((t) => Math.hypot(t.x - x, t.z - z) < SLOT_SPACING * 0.6) && tries < 12) {
      const a = tries * 2.399;
      const r = 0.45 + tries * 0.12;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (sim.grid.passableAt(nx, nz)) {
        x = nx;
        z = nz;
      }
      tries++;
    }
    taken.push({ x, z });
    out[o.i] = { x, z, facing };
  });
  return out;
}

/** Hex distance between a unit and a point, in tiles. */
export const tilesBetween = (a: { x: number; z: number }, b: { x: number; z: number }) => distance(fromWorld(a.x, a.z), fromWorld(b.x, b.z));
