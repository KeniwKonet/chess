/**
 * The battlefield simulation: a fixed 10 Hz tick over plain data.
 *
 * Players (and the AI) never move units directly. They submit commands;
 * the sim validates and applies them on its next tick. That is the same
 * contract an authoritative server will use in milestone 6, so this code
 * runs unchanged there.
 *
 * Systems, in tick order: commands, path fields, combat decisions, movement,
 * spacing, turning, projectile and blow resolution, deaths, towers, capture
 * points, visibility (fog of war), reinforcements, order completion, victory.
 */
import { fromWorld, key, toWorld, distance, type Hex } from '../hex';
import type { BuildingType, Owner, RealmMap, Side } from '../map/types';
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
  /** Damage per blow or arrow. */
  damage: number;
  /** Reach beyond both bodies (melee) or arrow range, world units. */
  range: number;
  /** Ticks between attacks. */
  cooldown: number;
  /** How far it sees, world units (fog of war and target acquisition). */
  sight: number;
  ranged: boolean;
  /** Damage multiplier against buildings. */
  vsBuildings: number;
}

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  infantry: { label: 'Swordsman', plural: 'Infantry', speed: 1.7, radius: 0.27, maxHp: 100, damage: 12, range: 0.35, cooldown: 10, sight: 6.5, ranged: false, vsBuildings: 0.6 },
  archer: { label: 'Archer', plural: 'Archers', speed: 1.9, radius: 0.25, maxHp: 70, damage: 8, range: 7, cooldown: 15, sight: 8.5, ranged: true, vsBuildings: 0.3 },
};

export type UnitState = 'idle' | 'waiting' | 'moving' | 'attacking' | 'dead';

export type TargetRef = { kind: 'unit'; id: number } | { kind: 'building'; id: string };

/** Timed modifier, e.g. from a chess bond effect. */
export interface Buff {
  stat: 'damage' | 'rate' | 'taken';
  mul: number;
  until: number;
  source: string;
}

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
  /** Current attack target, from an order or picked up automatically. */
  target: TargetRef | null;
  /** True if the target was ordered by a player (not auto-acquired). */
  targetOrdered: boolean;
  /** Attack-move: fight anything met on the way to this point. */
  attackMove: { x: number; z: number } | null;
  /** Where an idle defender started chasing from; it returns here if led too far. */
  anchor: { x: number; z: number } | null;
  cooldown: number;
  /** Tick of the last attack (for the attack animation), or -1. */
  lastAttack: number;
  /** Tick it was last hurt, or -1. */
  lastHit: number;
  /** Tick it died, or -1. */
  deadAt: number;
  buffs: Buff[];
  kills: number;
}

export interface SimBuilding {
  id: string;
  side: Owner;
  type: BuildingType;
  name: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  /** Footprint radius for reach and arrows. */
  radius: number;
  /** Towers and castles shoot; others do not. */
  weapon: { damage: number; range: number; cooldown: number } | null;
  cooldown: number;
  lastAttack: number;
  buffs: Buff[];
  /** Damage taken is multiplied by this (castles are hardened). */
  armour: number;
  capture?: string;
}

export interface SimCapture {
  id: string;
  name: string;
  x: number;
  z: number;
  /** World radius of the ring. */
  radius: number;
  owner: Owner;
  /** -100 (Moon) .. +100 (Sun); owner flips at the ends. */
  progress: number;
}

export interface Projectile {
  id: number;
  side: Side;
  /** Who loosed it: a unit id, or a building id for tower shots. */
  by: number | string;
  x0: number;
  z0: number;
  y0: number;
  target: TargetRef;
  /** Predicted impact point at launch (for drawing). */
  tx: number;
  tz: number;
  damage: number;
  fired: number;
  lands: number;
  /** Arrow (drawn) or a melee blow (invisible, lands on the swing). */
  visible: boolean;
}

export interface SideStats {
  kills: number;
  losses: number;
  buildingsDestroyed: number;
  captures: number;
  reinforcements: number;
}

/** Battlefield effects of chess bonds (see packages/chess-core/src/bonds.ts and docs/RULES.md). */
export type Effect =
  | { kind: 'advance'; unitIds: number[]; distance: number; source: string }
  | { kind: 'volley'; unitIds: number[]; ticks: number; source: string }
  | { kind: 'rally'; ticks: number; source: string }
  | { kind: 'fortify'; buildingId: string; amount: number; source: string }
  | { kind: 'bombard'; buildingId: string; ticks: number; source: string }
  | { kind: 'break'; unitIds: number[]; buildingId?: string; ticks: number; source: string };

export interface UnitSpawn {
  side: Side;
  type: UnitType;
  x: number;
  z: number;
  facing?: number;
}

export type Command =
  | { kind: 'move'; side: Side; ids: number[]; x: number; z: number; attack?: boolean }
  | { kind: 'attack'; side: Side; ids: number[]; target: TargetRef }
  | { kind: 'stop'; side: Side; ids: number[] }
  | { kind: 'effect'; side: Side; effect: Effect };

export type SimEvent =
  | { kind: 'order'; tick: number; side: Side; order: number; ids: number[]; x: number; z: number; attack: boolean }
  | { kind: 'attackOrder'; tick: number; side: Side; ids: number[]; target: TargetRef }
  | { kind: 'arrived'; tick: number; side: Side; order: number; ids: number[]; x: number; z: number }
  | { kind: 'unreachable'; tick: number; side: Side; ids: number[]; x: number; z: number }
  | { kind: 'stopped'; tick: number; side: Side; ids: number[] }
  | { kind: 'rejected'; tick: number; side: Side; reason: string }
  | { kind: 'killed'; tick: number; side: Side; id: number; type: UnitType; by: Side; x: number; z: number }
  | { kind: 'destroyed'; tick: number; side: Owner; buildingId: string; by: Side }
  | { kind: 'captured'; tick: number; side: Owner; captureId: string }
  | { kind: 'reinforced'; tick: number; side: Side; ids: number[] }
  | { kind: 'effect'; tick: number; side: Side; effect: Effect }
  | { kind: 'victory'; tick: number; winner: Side; reason: string };

export const TICK_HZ = 10;
export const DT = 1 / TICK_HZ;
/** Most distance fields built per tick (performance budget from the plan). */
export const FIELD_BUDGET = 8;
const SLOT_SPACING = 0.78;
const ARRIVE_EPS = 0.06;
const STUCK_TICKS = 60;
const TURN_RATE = 10;
/** Idle defenders give up a chase this far from where they started. */
const LEASH = 9;
const VISION_EVERY = 5;
const CORPSE_TICKS = 40;
export const REINFORCE_EVERY = 900; // 90 s
const UNIT_CAP = 40;
const ARROW_SPEED = 14; // world units per second

const BUILDING_WEAPONS: Partial<Record<BuildingType, { damage: number; range: number; cooldown: number }>> = {
  castle: { damage: 10, range: 8, cooldown: 12 },
  tower: { damage: 8, range: 7, cooldown: 15 },
  watchtower: { damage: 8, range: 7, cooldown: 15 },
};
const BUILDING_SIGHT: Partial<Record<BuildingType, number>> = { castle: 9, tower: 8, watchtower: 8 };

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
  readonly buildings: SimBuilding[] = [];
  private buildingById = new Map<string, SimBuilding>();
  readonly captures: SimCapture[] = [];
  projectiles: Projectile[] = [];
  private nextProjectile = 1;
  /** Fog of war: per side, which map cells are visible now / have ever been seen (by cell index). */
  readonly visible: Record<Side, Uint8Array>;
  readonly explored: Record<Side, Uint8Array>;
  readonly cellIndex = new Map<string, number>();
  winner: Side | null = null;
  winReason = '';
  readonly stats: Record<Side, SideStats> = {
    sun: { kills: 0, losses: 0, buildingsDestroyed: 0, captures: 0, reinforcements: 0 },
    moon: { kills: 0, losses: 0, buildingsDestroyed: 0, captures: 0, reinforcements: 0 },
  };
  /** Reinforcements on/off (tests switch them off). */
  reinforcements = true;

  constructor(readonly realm: RealmMap, spawns: UnitSpawn[] = []) {
    this.grid = new Grid(realm);
    this.fields = new FieldCache(this.grid, 32);
    realm.cells.forEach((c, i) => this.cellIndex.set(key(c), i));
    this.visible = { sun: new Uint8Array(realm.cells.length), moon: new Uint8Array(realm.cells.length) };
    this.explored = { sun: new Uint8Array(realm.cells.length), moon: new Uint8Array(realm.cells.length) };
    for (const b of realm.buildings) {
      const w = toWorld(b);
      const sb: SimBuilding = {
        id: b.id,
        side: b.side,
        type: b.type,
        name: b.name,
        x: w.x,
        z: w.z,
        hp: b.hp,
        maxHp: b.maxHp,
        destroyed: b.type === 'rubble' || b.hp <= 0,
        radius: b.type === 'castle' ? 0.95 : 0.85,
        weapon: BUILDING_WEAPONS[b.type] ?? null,
        cooldown: 0,
        lastAttack: -1,
        buffs: [],
        armour: b.type === 'castle' ? 0.5 : 1,
        ...(b.capture ? { capture: b.capture } : {}),
      };
      this.buildings.push(sb);
      this.buildingById.set(sb.id, sb);
    }
    for (const c of realm.captures) {
      const w = toWorld(c);
      this.captures.push({ id: c.id, name: c.name, x: w.x, z: w.z, radius: c.radius * 2 + 0.6, owner: c.owner, progress: c.owner === 'sun' ? 100 : c.owner === 'moon' ? -100 : 0 });
    }
    for (const s of spawns) this.spawn(s);
    this.updateVision();
  }

  building(id: string) {
    return this.buildingById.get(id);
  }

  /** Is this world point visible to a side right now? */
  sees(side: Side, x: number, z: number): boolean {
    const i = this.cellIndex.get(key(fromWorld(x, z)));
    return i !== undefined && this.visible[side][i] === 1;
  }

  /** Declare the match over from outside the battlefield (e.g. checkmate on the War Table). */
  declareWinner(winner: Side, reason: string) {
    if (this.winner) return;
    this.winner = winner;
    this.winReason = reason;
    this.pendingVictory = { winner, reason };
  }
  private pendingVictory: { winner: Side; reason: string } | null = null;

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
      target: null,
      targetOrdered: false,
      attackMove: null,
      anchor: null,
      cooldown: 0,
      lastAttack: -1,
      lastHit: -1,
      deadAt: -1,
      buffs: [],
      kills: 0,
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
    if (this.winner && !this.pendingVictory) return events; // match over: the field freezes
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

    // 3. Combat decisions: acquire, chase, strike.
    for (const u of this.units) if (u.hp > 0) this.fight(u);

    // 4. Movement, in id order for determinism.
    for (const u of this.units) if (u.state === 'moving') this.move(u, events);

    // 5. Personal space.
    this.separate();

    // 6. Turning: toward travel, the target, or the order's facing.
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      let target = u.facing;
      const t = u.target ? this.targetPos(u.target) : null;
      if (u.state === 'attacking' && t) target = Math.atan2(t.x - u.x, t.z - u.z);
      else if (u.moved > 1e-4) target = Math.atan2(u.x - u.px, u.z - u.pz);
      else if (u.state === 'idle' && u.endFacing !== null) target = u.endFacing;
      const d = Math.atan2(Math.sin(target - u.facing), Math.cos(target - u.facing));
      const maxTurn = TURN_RATE * DT;
      u.facing += Math.max(-maxTurn, Math.min(maxTurn, d));
    }

    // 7. Arrows and blows that land this tick.
    const flying: Projectile[] = [];
    for (const p of this.projectiles) {
      if (p.lands > this.tick) flying.push(p);
      else this.land(p, events);
    }
    this.projectiles = flying;

    // 8. Towers and castles shoot.
    for (const b of this.buildings) this.towerFire(b);

    // 9. Corpses are cleared after the death animation.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i]!;
      if (u.hp <= 0 && this.tick - u.deadAt > CORPSE_TICKS) {
        this.units.splice(i, 1);
        this.byId.delete(u.id);
      }
    }

    // 10. Capture points.
    this.capture(events);

    // 11. Fog of war.
    if (this.tick % VISION_EVERY === 0) this.updateVision();

    // 12. Reinforcements from standing barracks and ranges.
    if (this.reinforcements && this.tick % REINFORCE_EVERY === 0) this.reinforce(events);

    // 13. Orders whose units have all arrived (or given up).
    for (const [id, o] of this.orders) {
      for (const uid of [...o.ids]) {
        const u = this.byId.get(uid);
        if (!u || u.order !== id || u.state === 'idle' || u.state === 'attacking' || u.hp <= 0) o.ids.delete(uid);
      }
      if (o.ids.size === 0) {
        const arrived = this.units.filter((u) => u.order === id && u.state === 'idle' && u.hp > 0).map((u) => u.id);
        if (arrived.length) events.push({ kind: 'arrived', tick: this.tick, side: o.side, order: id, ids: arrived, x: o.x, z: o.z });
        this.orders.delete(id);
      }
    }

    // 14. Victory: a fallen castle ends the match.
    if (!this.winner) {
      for (const side of ['sun', 'moon'] as const) {
        const castle = this.buildings.find((b) => b.type === 'castle' && b.side === side);
        if (castle?.destroyed) {
          this.winner = side === 'sun' ? 'moon' : 'sun';
          this.winReason = `${castle.name} has fallen`;
          events.push({ kind: 'victory', tick: this.tick, winner: this.winner, reason: this.winReason });
        }
      }
    }
    if (this.pendingVictory) {
      events.push({ kind: 'victory', tick: this.tick, ...this.pendingVictory });
      this.pendingVictory = null;
    }
    return events;
  }

  private apply(cmd: Command, events: SimEvent[]) {
    if (cmd.kind === 'effect') return this.applyEffect(cmd.side, cmd.effect, events);
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
        this.clearOrders(u);
        u.state = 'idle';
      }
      events.push({ kind: 'stopped', tick: this.tick, side: cmd.side, ids: units.map((u) => u.id) });
      return;
    }
    if (cmd.kind === 'attack') {
      if (!this.targetAlive(cmd.target) || this.targetSide(cmd.target) === cmd.side || this.targetSide(cmd.target) === 'neutral') {
        events.push({ kind: 'rejected', tick: this.tick, side: cmd.side, reason: 'That is not an enemy that can be attacked' });
        return;
      }
      for (const u of units) {
        this.clearOrders(u);
        u.target = cmd.target;
        u.targetOrdered = true;
        u.state = 'idle';
      }
      events.push({ kind: 'attackOrder', tick: this.tick, side: cmd.side, ids: units.map((u) => u.id), target: cmd.target });
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
      this.clearOrders(u);
      this.setGoal(u, s.x, s.z);
      u.endFacing = s.facing;
      u.order = order;
      u.attackMove = cmd.attack ? { x: s.x, z: s.z } : null;
      ids.add(u.id);
    });
    this.orders.set(order, { side: cmd.side, ids, x: target.x, z: target.z });
    events.push({ kind: 'order', tick: this.tick, side: cmd.side, order, ids: [...ids], x: target.x, z: target.z, attack: !!cmd.attack });
  }

  private clearOrders(u: Unit) {
    u.goal = null;
    u.goalHex = null;
    u.endFacing = null;
    u.order = 0;
    u.target = null;
    u.targetOrdered = false;
    u.attackMove = null;
    u.anchor = null;
  }

  private setGoal(u: Unit, x: number, z: number) {
    u.goal = { x, z };
    u.goalHex = fromWorld(x, z);
    u.state = 'waiting';
    u.stuck = 0;
    u.best = Infinity;
  }

  // ---------------------------------------------------------------- combat

  private targetAlive(t: TargetRef): boolean {
    if (t.kind === 'unit') return (this.byId.get(t.id)?.hp ?? 0) > 0;
    const b = this.buildingById.get(t.id);
    return !!b && !b.destroyed;
  }
  private targetSide(t: TargetRef): Owner | null {
    return t.kind === 'unit' ? (this.byId.get(t.id)?.side ?? null) : (this.buildingById.get(t.id)?.side ?? null);
  }
  targetPos(t: TargetRef): { x: number; z: number; r: number } | null {
    if (t.kind === 'unit') {
      const u = this.byId.get(t.id);
      return u ? { x: u.x, z: u.z, r: UNIT_DEFS[u.type].radius } : null;
    }
    const b = this.buildingById.get(t.id);
    return b ? { x: b.x, z: b.z, r: b.radius } : null;
  }

  private mul(buffs: Buff[], stat: Buff['stat']): number {
    let m = 1;
    for (const b of buffs) if (b.stat === stat && b.until >= this.tick) m *= b.mul;
    return m;
  }

  /** Gap between a unit's body and the target's edge. */
  private gap(u: Unit, t: { x: number; z: number; r: number }) {
    return Math.hypot(t.x - u.x, t.z - u.z) - t.r - UNIT_DEFS[u.type].radius;
  }

  /** Nearest visible enemy unit within sight (and, when hunting, enemy buildings). */
  private acquire(u: Unit, buildingsToo: boolean): TargetRef | null {
    const def = UNIT_DEFS[u.type];
    let best: TargetRef | null = null;
    let bd = def.sight;
    for (const o of this.units) {
      if (o.side === u.side || o.hp <= 0) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (d < bd && this.sees(u.side, o.x, o.z)) {
        bd = d;
        best = { kind: 'unit', id: o.id };
      }
    }
    if (best || !buildingsToo) return best;
    bd = def.sight;
    for (const b of this.buildings) {
      if (b.destroyed || b.side === u.side || b.side === 'neutral') continue;
      const d = Math.hypot(b.x - u.x, b.z - u.z) - b.radius;
      if (d < bd) {
        bd = d;
        best = { kind: 'building', id: b.id };
      }
    }
    return best;
  }

  private fight(u: Unit) {
    if (u.cooldown > 0) u.cooldown--;
    const def = UNIT_DEFS[u.type];
    // Drop dead targets; resume an attack-move or fall back to idle.
    if (u.target && !this.targetAlive(u.target)) {
      u.target = null;
      u.targetOrdered = false;
      if (u.attackMove) this.setGoal(u, u.attackMove.x, u.attackMove.z);
      else if (u.anchor) {
        this.setGoal(u, u.anchor.x, u.anchor.z);
        u.anchor = null;
      } else if (u.state === 'attacking') u.state = 'idle';
    }
    // Pick up a fight: idle soldiers defend themselves, attack-movers hunt (buildings too).
    const hunting = !!u.attackMove;
    if (!u.target && (u.state === 'idle' || hunting) && (this.tick + u.id) % 3 === 0) {
      const t = this.acquire(u, hunting);
      if (t) {
        u.target = t;
        u.targetOrdered = false;
        if (u.state === 'idle' && !hunting) u.anchor = { x: u.x, z: u.z };
      }
    }
    if (!u.target) return;
    const t = this.targetPos(u.target)!;
    const gap = this.gap(u, t);
    // Defenders don't follow an enemy across the map.
    if (u.anchor && !u.targetOrdered && Math.hypot(u.x - u.anchor.x, u.z - u.anchor.z) > LEASH && gap > def.range) {
      const a = u.anchor;
      u.target = null;
      u.anchor = null;
      this.setGoal(u, a.x, a.z);
      return;
    }
    if (gap <= def.range) {
      // In reach: stand and strike.
      if (u.state === 'moving' || u.state === 'waiting') {
        u.goal = null;
        u.goalHex = null;
      }
      u.state = 'attacking';
      if (u.cooldown <= 0) this.strike(u, t);
      return;
    }
    // Out of reach: close in. Re-plan when the target has moved off the current goal.
    const approach = this.approachPoint(u, u.target, t);
    if (!u.goal || Math.hypot(u.goal.x - approach.x, u.goal.z - approach.z) > 1.2 || u.state === 'attacking' || u.state === 'idle') {
      this.setGoal(u, approach.x, approach.z);
    }
  }

  /** Where to stand to hit a target: inside reach, on open ground, spread by id so attackers fan out. */
  private approachPoint(u: Unit, ref: TargetRef, t: { x: number; z: number; r: number }) {
    const def = UNIT_DEFS[u.type];
    const ang = Math.atan2(u.z - t.z, u.x - t.x) + ((u.id % 5) - 2) * 0.3;
    const want = ref.kind === 'building' ? Math.min(t.r + def.range * 0.7 + 0.25, def.ranged ? t.r + def.range * 0.7 : 1.15) : t.r + def.radius + def.range * 0.6;
    return this.placeable(t.x + Math.cos(ang) * want, t.z + Math.sin(ang) * want);
  }

  private strike(u: Unit, t: { x: number; z: number; r: number }) {
    const def = UNIT_DEFS[u.type];
    u.cooldown = Math.max(1, Math.round(def.cooldown / this.mul(u.buffs, 'rate')));
    u.lastAttack = this.tick;
    let damage = def.damage * this.mul(u.buffs, 'damage');
    if (u.target!.kind === 'building') damage *= def.vsBuildings;
    const dist = Math.hypot(t.x - u.x, t.z - u.z);
    this.projectiles.push({
      id: this.nextProjectile++,
      side: u.side,
      by: u.id,
      x0: u.x,
      z0: u.z,
      y0: def.ranged ? 0.55 : 0.4,
      target: u.target!,
      tx: t.x,
      tz: t.z,
      damage,
      fired: this.tick,
      // Arrows fly; a sword blow lands partway through the swing.
      lands: this.tick + (def.ranged ? Math.max(1, Math.ceil((dist / ARROW_SPEED) * TICK_HZ)) : 4),
      visible: def.ranged,
    });
  }

  private towerFire(b: SimBuilding) {
    if (b.destroyed || !b.weapon || b.side === 'neutral') return;
    if (b.cooldown > 0) {
      b.cooldown--;
      return;
    }
    let best: Unit | null = null;
    let bd = b.weapon.range;
    for (const o of this.units) {
      if (o.hp <= 0 || o.side === b.side) continue;
      const d = Math.hypot(o.x - b.x, o.z - b.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (!best) return;
    b.cooldown = b.weapon.cooldown;
    b.lastAttack = this.tick;
    this.projectiles.push({
      id: this.nextProjectile++,
      side: b.side,
      by: b.id,
      x0: b.x,
      z0: b.z,
      y0: b.type === 'castle' ? 3 : 2,
      target: { kind: 'unit', id: best.id },
      tx: best.x,
      tz: best.z,
      damage: b.weapon.damage * this.mul(b.buffs, 'damage'),
      fired: this.tick,
      lands: this.tick + Math.max(1, Math.ceil((bd / ARROW_SPEED) * TICK_HZ)),
      visible: true,
    });
  }

  private land(p: Projectile, events: SimEvent[]) {
    // Arrows in flight still land; a sword swing from a soldier who has fallen does not.
    if (!p.visible && typeof p.by === 'number' && (this.byId.get(p.by)?.hp ?? 0) <= 0) return;
    if (p.target.kind === 'unit') {
      const v = this.byId.get(p.target.id);
      if (!v || v.hp <= 0) return;
      v.hp = Math.max(0, v.hp - p.damage * this.mul(v.buffs, 'taken'));
      v.lastHit = this.tick;
      // Struck while idle and not already fighting: turn and answer.
      if (!v.target && v.state === 'idle') {
        const shooter = typeof p.by === 'number' ? this.byId.get(p.by) : undefined;
        if (shooter && shooter.hp > 0) {
          v.target = { kind: 'unit', id: shooter.id };
          v.anchor = { x: v.x, z: v.z };
        }
      }
      if (v.hp <= 0) {
        v.hp = 0;
        v.state = 'dead';
        v.deadAt = this.tick;
        v.goal = null;
        v.goalHex = null;
        this.stats[v.side].losses++;
        this.stats[p.side].kills++;
        const killer = typeof p.by === 'number' ? this.byId.get(p.by) : undefined;
        if (killer) killer.kills++;
        events.push({ kind: 'killed', tick: this.tick, side: v.side, id: v.id, type: v.type, by: p.side, x: v.x, z: v.z });
      }
      return;
    }
    const b = this.buildingById.get(p.target.id);
    if (!b || b.destroyed) return;
    b.hp = Math.max(0, b.hp - p.damage * b.armour * this.mul(b.buffs, 'taken'));
    if (b.hp <= 0) {
      b.destroyed = true;
      if (b.side === 'sun' || b.side === 'moon') this.stats[p.side].buildingsDestroyed++;
      events.push({ kind: 'destroyed', tick: this.tick, side: b.side, buildingId: b.id, by: p.side });
    }
  }

  // ------------------------------------------------------- capture & vision

  private capture(events: SimEvent[]) {
    for (const c of this.captures) {
      let sun = 0;
      let moon = 0;
      for (const u of this.units) {
        if (u.hp <= 0 || Math.hypot(u.x - c.x, u.z - c.z) > c.radius) continue;
        if (u.side === 'sun') sun++;
        else moon++;
      }
      // Only an uncontested ring moves: 0.6 a tick per soldier, up to 3 soldiers.
      if (sun && !moon) c.progress = Math.min(100, c.progress + Math.min(3, sun) * 0.6);
      else if (moon && !sun) c.progress = Math.max(-100, c.progress - Math.min(3, moon) * 0.6);
      else continue;
      const newOwner: Owner = c.progress >= 100 ? 'sun' : c.progress <= -100 ? 'moon' : c.owner !== 'neutral' && Math.sign(c.progress) !== (c.owner === 'sun' ? 1 : -1) ? 'neutral' : c.owner;
      if (newOwner !== c.owner) {
        c.owner = newOwner;
        if (newOwner !== 'neutral') this.stats[newOwner].captures++;
        events.push({ kind: 'captured', tick: this.tick, side: newOwner, captureId: c.id });
        // A captured watchtower changes sides with its ring.
        for (const b of this.buildings) if (b.capture === c.id && !b.destroyed) b.side = newOwner;
      }
    }
  }

  /** Holding Vey Watchtower extends your soldiers' sight (Scout Sight). */
  scoutSight(side: Side) {
    return this.captures.find((c) => c.id === 'vey')?.owner === side;
  }

  private updateVision() {
    for (const side of ['sun', 'moon'] as const) {
      const vis = this.visible[side];
      vis.fill(0);
      const bonus = this.scoutSight(side) ? 2 : 0;
      const sources: { x: number; z: number; r: number }[] = [];
      for (const u of this.units) if (u.side === side && u.hp > 0) sources.push({ x: u.x, z: u.z, r: UNIT_DEFS[u.type].sight + bonus });
      for (const b of this.buildings) if (b.side === side && !b.destroyed) sources.push({ x: b.x, z: b.z, r: BUILDING_SIGHT[b.type] ?? 4 });
      this.realm.cells.forEach((c, i) => {
        const w = toWorld(c);
        for (const s of sources) {
          if ((w.x - s.x) ** 2 + (w.z - s.z) ** 2 <= s.r * s.r) {
            vis[i] = 1;
            this.explored[side][i] = 1;
            return;
          }
        }
      });
    }
  }

  // ---------------------------------------------------- reinforcements

  private reinforce(events: SimEvent[]) {
    for (const side of ['sun', 'moon'] as const) {
      const alive = this.units.filter((u) => u.side === side && u.hp > 0).length;
      if (alive >= UNIT_CAP) continue;
      const ids: number[] = [];
      const from = (type: BuildingType, unit: UnitType, n: number) => {
        const b = this.buildings.find((x) => x.side === side && x.type === type && !x.destroyed);
        if (!b) return;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + this.tick;
          ids.push(this.spawn({ side, type: unit, x: b.x + Math.cos(a) * 1.6, z: b.z + Math.sin(a) * 1.6 }).id);
        }
      };
      from('barracks', 'infantry', 2);
      from('archery', 'archer', 1);
      if (ids.length) {
        this.stats[side].reinforcements += ids.length;
        events.push({ kind: 'reinforced', tick: this.tick, side, ids });
      }
    }
  }

  // ------------------------------------------------------------ effects

  private applyEffect(side: Side, e: Effect, events: SimEvent[]) {
    const until = this.tick + ('ticks' in e ? e.ticks : 0);
    const own = (ids: number[]) => ids.map((id) => this.byId.get(id)).filter((u): u is Unit => !!u && u.hp > 0 && u.side === side);
    switch (e.kind) {
      case 'advance': {
        const enemyCastle = this.buildings.find((b) => b.type === 'castle' && b.side !== side && b.side !== 'neutral');
        for (const u of own(e.unitIds)) {
          if (u.target && u.state === 'attacking') continue; // already fighting
          const dx = (enemyCastle?.x ?? u.x) - u.x;
          const dz = (enemyCastle?.z ?? u.z) - u.z;
          const l = Math.hypot(dx, dz) || 1;
          const p = this.placeable(u.x + (dx / l) * e.distance, u.z + (dz / l) * e.distance);
          this.clearOrders(u);
          this.setGoal(u, p.x, p.z);
          u.attackMove = { x: p.x, z: p.z };
        }
        break;
      }
      case 'volley':
        for (const u of own(e.unitIds)) u.buffs.push({ stat: 'rate', mul: 2, until, source: e.source });
        break;
      case 'rally':
        for (const u of this.units) if (u.side === side && u.hp > 0) u.buffs.push({ stat: 'damage', mul: 1.15, until, source: e.source });
        break;
      case 'fortify': {
        const b = this.buildingById.get(e.buildingId);
        if (b && !b.destroyed && b.side === side) b.hp = Math.min(b.maxHp, b.hp + e.amount);
        break;
      }
      case 'bombard': {
        const b = this.buildingById.get(e.buildingId);
        if (b && !b.destroyed && b.side === side) b.buffs.push({ stat: 'damage', mul: 2, until, source: e.source });
        break;
      }
      case 'break': {
        // Applied by the capturing side to the enemy's bound regiment or building.
        for (const id of e.unitIds) {
          const u = this.byId.get(id);
          if (u && u.hp > 0 && u.side !== side) {
            u.buffs.push({ stat: 'damage', mul: 0.5, until, source: e.source }, { stat: 'taken', mul: 1.2, until, source: e.source });
          }
        }
        if (e.buildingId) {
          const b = this.buildingById.get(e.buildingId);
          if (b && !b.destroyed && b.side !== side) b.buffs.push({ stat: 'taken', mul: 1.2, until, source: e.source });
        }
        break;
      }
    }
    events.push({ kind: 'effect', tick: this.tick, side, effect: e });
  }

  private fail(u: Unit, events: SimEvent[]) {
    const g = u.goal!;
    u.state = 'idle';
    u.goal = null;
    u.goalHex = null;
    u.endFacing = null;
    // An unreachable chase target is dropped rather than retried forever.
    if (u.target) {
      u.target = null;
      u.targetOrdered = false;
    }
    if (u.order) events.push({ kind: 'unreachable', tick: this.tick, side: u.side, ids: [u.id], x: g.x, z: g.z });
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
    // Reaching an attack-move point ends the hunt; reaching an anchor ends the chase.
    if (!u.target) u.attackMove = null;
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
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j]!;
        if (b.hp <= 0) continue;
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
        // Idle and fighting soldiers give way less than marching ones.
        const still = (x: Unit) => x.state === 'idle' || x.state === 'attacking';
        const wa = still(a) && !still(b) ? 0.3 : still(b) && !still(a) ? 1.7 : 1;
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

/**
 * Compact fingerprint of the authoritative state (FNV-1a over positions,
 * health and structure), for desync checks between server and clients and
 * for replay tests. Positions are rounded to a millimetre.
 */
export function stateHash(sim: Sim): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (n >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(sim.tick);
  for (const u of sim.units) {
    mix(u.id);
    mix(Math.round(u.x * 1000));
    mix(Math.round(u.z * 1000));
    mix(Math.round(u.hp * 100));
  }
  for (const b of sim.buildings) mix(Math.round(b.hp * 100) + (b.destroyed ? 1 << 20 : 0));
  for (const c of sim.captures) mix(Math.round(c.progress * 10) + 1000);
  return h.toString(16).padStart(8, '0');
}
