/**
 * A whole match: the battlefield simulation, the Moon AIs and (milestone 5)
 * the War Table. The browser runs this for single-player; the server
 * (apps/server) runs the very same class authoritatively.
 */
import {
  Commander,
  PATROL_SIZE,
  PatrolAI,
  Sim,
  buildRealm,
  patrolRoute,
  startingArmies,
  type Command,
  type Difficulty,
  type RealmMap,
  type SimEvent,
} from '@cr/game-core';
import { WarTable, type TableEntry } from './warTable';

export interface MatchOptions {
  difficulty?: Difficulty;
  /** Run the Moon AI (single-player). Off when two humans play. */
  moonAi?: boolean;
  realm?: RealmMap;
}

export class Match {
  readonly realm: RealmMap;
  readonly sim: Sim;
  readonly difficulty: Difficulty;
  readonly commander: Commander | null;
  readonly patrol: PatrolAI | null;
  readonly warTable: WarTable;
  /** War Table moves made during the last step (by the AI), for reporting. */
  tableMoves: TableEntry[] = [];

  constructor(opts: MatchOptions = {}) {
    this.realm = opts.realm ?? buildRealm();
    this.difficulty = opts.difficulty ?? 'captain';
    this.sim = new Sim(this.realm, startingArmies(this.realm));
    const patrolIds = this.sim.units.slice(-PATROL_SIZE).map((u) => u.id);
    const ai = opts.moonAi ?? true;
    this.commander = ai ? new Commander(this.sim, 'moon', this.difficulty, patrolIds) : null;
    this.patrol = ai ? new PatrolAI('moon', patrolIds, patrolRoute(), 40) : null;
    this.warTable = new WarTable(this.sim, this.difficulty, ai ? 'moon' : null);
  }

  /** A human War Table move. */
  playChess(side: 'sun' | 'moon', move: string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) {
    return this.warTable.play(side, move);
  }

  issue(cmd: Command) {
    this.sim.issue(cmd);
  }

  /** One fixed tick: AIs decide (issuing ordinary commands), then the sim advances. */
  step(): SimEvent[] {
    if (this.commander?.phase === 'muster' && !this.sim.winner) this.patrol?.think(this.sim);
    this.commander?.think();
    const entry = this.warTable.tick();
    this.tableMoves = entry ? [entry] : [];
    return this.sim.step();
  }
}

export type { Difficulty };
export { WarTable, BOND_RULES, pieceName, sideOf, colourOf } from './warTable';
export type { TableEntry, TableResult } from './warTable';
export * from './protocol';
