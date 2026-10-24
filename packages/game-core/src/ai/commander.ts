/**
 * Moon commander: the battlefield AI. It only ever issues ordinary commands
 * (move, attack-move, attack), exactly as a player would, so the server can run
 * it unchanged and it cannot cheat on movement or combat. It does read the
 * whole map (no fog) — documented, and a candidate for change in balancing.
 *
 * Behaviour, re-evaluated every second:
 *   defend  — Sun soldiers near a Moon building: nearby Moon soldiers attack-move there.
 *   muster  — gather at the rally point east of the river until the army is big enough
 *             and the difficulty's opening delay has passed (the patrol keeps walking).
 *   attack  — attack-move toward the next objective: the Ford of Ash, then the Old Mill,
 *             then Sunspire Castle.
 *   retreat — if the attacking army falls below a share of its starting strength,
 *             fall back to the rally point and muster again.
 */
import { toWorld } from '../hex';
import { px } from '../map/realm';
import type { Side } from '../map/types';
import type { Sim, Unit } from '../sim/sim';

export type Difficulty = 'recruit' | 'captain' | 'warlord';

export const DIFFICULTY: Record<Difficulty, { label: string; attackAfter: number; minArmy: number; retreatBelow: number; chessThink: number; chessDepth: number }> = {
  recruit: { label: 'Recruit', attackAfter: 1800, minArmy: 14, retreatBelow: 0.45, chessThink: 120, chessDepth: 1 },
  captain: { label: 'Captain', attackAfter: 1200, minArmy: 11, retreatBelow: 0.3, chessThink: 80, chessDepth: 2 },
  warlord: { label: 'Warlord', attackAfter: 700, minArmy: 9, retreatBelow: 0.2, chessThink: 50, chessDepth: 3 },
};

export type CommanderPhase = 'muster' | 'attack' | 'retreat';

export class Commander {
  phase: CommanderPhase = 'muster';
  private attackAfter: number;
  private startHp = 0;
  private objective = 0;
  private lastOrder = -999;
  readonly rally = toWorld(px(2300, 1000));
  private readonly objectives: { name: string; x: number; z: number; capture?: string; building?: string }[];

  constructor(
    readonly sim: Sim,
    readonly side: Side = 'moon',
    readonly difficulty: Difficulty = 'captain',
    /** Units left to the patrol AI while mustering. */
    readonly patrolIds: number[] = [],
  ) {
    this.attackAfter = DIFFICULTY[difficulty].attackAfter;
    const cap = (id: string) => sim.captures.find((c) => c.id === id)!;
    const sunCastle = sim.buildings.find((b) => b.type === 'castle' && b.side !== side)!;
    this.objectives = [
      { name: cap('ford').name, x: cap('ford').x, z: cap('ford').z, capture: 'ford' },
      { name: cap('mill').name, x: cap('mill').x, z: cap('mill').z, capture: 'mill' },
      { name: sunCastle.name, x: sunCastle.x, z: sunCastle.z, building: sunCastle.id },
    ];
  }

  get objectiveName() {
    return this.objectives[Math.min(this.objective, this.objectives.length - 1)]!.name;
  }

  private army(includePatrol: boolean): Unit[] {
    return this.sim.units.filter((u) => u.side === this.side && u.hp > 0 && (includePatrol || !this.patrolIds.includes(u.id)));
  }

  think() {
    const sim = this.sim;
    if (sim.winner || sim.tick % 10 !== 0) return;
    const enemy = this.side === 'sun' ? 'moon' : 'sun';

    // Defend: enemy soldiers close to any of our standing buildings.
    for (const b of sim.buildings) {
      if (b.destroyed || b.side !== this.side) continue;
      const raiders = sim.units.filter((u) => u.side === enemy && u.hp > 0 && Math.hypot(u.x - b.x, u.z - b.z) < 9);
      if (!raiders.length) continue;
      const cx = raiders.reduce((s, u) => s + u.x, 0) / raiders.length;
      const cz = raiders.reduce((s, u) => s + u.z, 0) / raiders.length;
      const defenders = this.army(true).filter((u) => !u.target && Math.hypot(u.x - cx, u.z - cz) < 22 && (u.state === 'idle' || !u.attackMove));
      if (defenders.length && sim.tick - this.lastOrder > 30) {
        sim.issue({ kind: 'move', side: this.side, ids: defenders.map((u) => u.id), x: cx, z: cz, attack: true });
        this.lastOrder = sim.tick;
      }
      return;
    }

    const army = this.army(this.phase !== 'muster');
    if (this.phase === 'muster') {
      // Gather idle soldiers (including reinforcements) at the rally point.
      const strays = army.filter((u) => u.state === 'idle' && !u.target && Math.hypot(u.x - this.rally.x, u.z - this.rally.z) > 6);
      if (strays.length && sim.tick - this.lastOrder > 50) {
        sim.issue({ kind: 'move', side: this.side, ids: strays.map((u) => u.id), x: this.rally.x, z: this.rally.z });
        this.lastOrder = sim.tick;
      }
      const all = this.army(true);
      if (sim.tick >= this.attackAfter && all.length >= DIFFICULTY[this.difficulty].minArmy) {
        this.phase = 'attack';
        this.startHp = all.reduce((s, u) => s + u.hp, 0);
        this.lastOrder = -999;
      }
      return;
    }

    if (this.phase === 'attack') {
      const hp = army.reduce((s, u) => s + u.hp, 0);
      if (hp < this.startHp * DIFFICULTY[this.difficulty].retreatBelow) {
        this.phase = 'muster';
        this.attackAfter = sim.tick + 600;
        sim.issue({ kind: 'move', side: this.side, ids: army.map((u) => u.id), x: this.rally.x, z: this.rally.z });
        this.lastOrder = sim.tick;
        return;
      }
      // Advance the objective once it's ours (capture) or gone (building).
      let obj = this.objectives[this.objective]!;
      while (
        this.objective < this.objectives.length - 1 &&
        ((obj.capture && sim.captures.find((c) => c.id === obj.capture)?.owner === this.side) || (obj.building && sim.building(obj.building)?.destroyed))
      ) {
        obj = this.objectives[++this.objective]!;
      }
      const idle = army.filter((u) => !u.target && (u.state === 'idle' || !u.attackMove));
      if (idle.length && sim.tick - this.lastOrder > 60) {
        if (obj.building) sim.issue({ kind: 'attack', side: this.side, ids: idle.map((u) => u.id), target: { kind: 'building', id: obj.building } });
        else sim.issue({ kind: 'move', side: this.side, ids: idle.map((u) => u.id), x: obj.x, z: obj.z, attack: true });
        this.lastOrder = sim.tick;
      }
    }
  }
}
