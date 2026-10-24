/**
 * Basic Moon AI for milestone 2: a squad walks a patrol route, pausing at
 * each end. It issues ordinary move commands, exactly as a player would.
 * Combat-aware AI (attack, retreat, defend) arrives with combat in milestone 3.
 */
import type { Sim } from '../sim/sim';
import type { Side } from '../map/types';

export class PatrolAI {
  private leg = 0;
  private waitUntil = 0;
  constructor(
    readonly side: Side,
    readonly ids: number[],
    readonly route: { x: number; z: number }[],
    /** Ticks to wait at each end. */
    readonly pause = 40,
  ) {}

  /** Call once per tick, before sim.step(). */
  think(sim: Sim) {
    const alive = this.ids.map((id) => sim.unit(id)).filter((u) => u && u.hp > 0);
    if (!alive.length) return;
    const busy = alive.some((u) => u!.state !== 'idle');
    if (busy) {
      this.waitUntil = sim.tick + this.pause;
      return;
    }
    if (sim.tick < this.waitUntil) return;
    this.leg = (this.leg + 1) % this.route.length;
    const p = this.route[this.leg]!;
    sim.issue({ kind: 'move', side: this.side, ids: alive.map((u) => u!.id), x: p.x, z: p.z });
    this.waitUntil = Infinity; // until it reports busy again
  }
}
