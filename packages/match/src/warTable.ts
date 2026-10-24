/**
 * The War Table: a standard game of chess between Sun (white) and Moon
 * (black), bound to the battlefield by the bond rules (chess-core/bonds.ts,
 * documented in docs/RULES.md).
 *
 * - Turn-based: each side makes one legal move per turn; the board waits.
 * - Every legal move triggers its piece's bond effect on the battlefield.
 * - Checkmate wins the whole battle. A drawn board (stalemate, repetition,
 *   fifty moves, bare kings) freezes; the battlefield decides.
 * - The Moon's reply is chosen by a small search after a "thinking" delay
 *   that depends on difficulty (so it plays at battle pace, not instantly).
 */
import { Bonds, StandardGame, type BondEffect, type Colour, type MoveRecord, type SideAssignment } from '@cr/chess-core';
import { DIFFICULTY, type Difficulty, type Effect, type Side, type Sim } from '@cr/game-core';
import { searchMove } from './chessAi';

/** Durations and magnitudes for each bond effect, in ticks (10 per second). */
export const BOND_RULES = {
  advanceDistance: 3,
  volleyTicks: 120,
  bombardTicks: 150,
  rallyTicks: 150,
  fortifyAmount: 120,
  breakTicks: 250,
} as const;

export const sideOf = (c: Colour): Side => (c === 'w' ? 'sun' : 'moon');
export const colourOf = (s: Side): Colour => (s === 'sun' ? 'w' : 'b');

export interface TableEntry {
  ply: number;
  side: Side;
  san: string;
  tick: number;
  effects: Effect[];
  check: boolean;
}

export type TableResult = { ok: true; entry: TableEntry } | { ok: false; reason: string };

function assignment(sim: Sim, side: Side): SideAssignment {
  // The opening companies: the first 8 infantry and 6 archers of each side (the Moon patrol is not bound).
  const inf = sim.units.filter((u) => u.side === side && u.type === 'infantry').slice(0, 8).map((u) => u.id);
  const arc = sim.units.filter((u) => u.side === side && u.type === 'archer').slice(0, 6).map((u) => u.id);
  const pawns = Array.from({ length: 8 }, (_, i) => (inf[i] !== undefined ? [inf[i]!] : []));
  const p = side === 'sun' ? 'sun' : 'moon';
  return {
    pawns,
    bishops: [arc.slice(0, 3), arc.slice(3, 6)],
    rooks: [`${p}_t1`, `${p}_t2`],
    king: `${p}_castle`,
  };
}

export class WarTable {
  readonly game = new StandardGame();
  readonly bonds: Bonds;
  readonly log: TableEntry[] = [];
  /** Tick at which the AI side may reply (null when not its turn). */
  private aiDueAt: number | null = null;
  /** The AI's search in progress, advanced a slice per tick. */
  private thinking: { it: Generator<void, string | null>; result?: string | null } | null = null;
  readonly live;

  constructor(
    readonly sim: Sim,
    readonly difficulty: Difficulty,
    /** Side played by the computer, if any. */
    readonly aiSide: Side | null = 'moon',
  ) {
    this.bonds = new Bonds(assignment(sim, 'sun'), assignment(sim, 'moon'));
    this.live = {
      unitAlive: (id: number) => (sim.unit(id)?.hp ?? 0) > 0,
      buildingStanding: (id: string) => !!sim.building(id) && !sim.building(id)!.destroyed,
    };
  }

  get turn(): Side {
    return sideOf(this.game.turn);
  }

  get over() {
    return this.game.outcome().over || !!this.sim.winner;
  }

  /** Legal destination squares for the piece on `from`, for the side to move. */
  targets(from: string): string[] {
    return this.game.verboseMoves(from as never).map((m) => m.to);
  }

  /** Play a move for a side. Effects are issued to the sim as ordinary commands. */
  play(side: Side, move: string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }): TableResult {
    if (this.over) return { ok: false, reason: 'The War Table is closed: the battle is decided' };
    if (side !== this.turn) return { ok: false, reason: `It is the ${this.turn === 'sun' ? 'Sun' : 'Moon'}'s turn on the War Table` };
    const rec = this.game.move(move as never);
    if (!rec) return { ok: false, reason: 'That move is not legal' };
    const entry = this.record(side, rec);
    if (this.aiSide && this.turn === this.aiSide && !this.over) this.aiDueAt = this.sim.tick + DIFFICULTY[this.difficulty].chessThink;
    return { ok: true, entry };
  }

  private record(side: Side, rec: MoveRecord): TableEntry {
    const effects = this.bonds.apply(rec, this.live).map((e) => this.toSimEffect(e, rec.san));
    for (const effect of effects) this.sim.issue({ kind: 'effect', side: sideOf(effectColour(effect, side)), effect });
    const entry: TableEntry = { ply: this.log.length + 1, side, san: rec.san, tick: this.sim.tick, effects, check: rec.check };
    this.log.push(entry);
    const out = this.game.outcome();
    if (out.over && out.result === 'checkmate') this.sim.declareWinner(sideOf(out.winner), `Checkmate on the War Table`);
    return entry;
  }

  private toSimEffect(e: BondEffect, san: string): Effect {
    const source = `${san} (${pieceName(e.piece)})`;
    switch (e.kind) {
      case 'advance':
        return { kind: 'advance', unitIds: e.units, distance: BOND_RULES.advanceDistance, source };
      case 'volley':
        return { kind: 'volley', unitIds: e.units, ticks: BOND_RULES.volleyTicks, source };
      case 'bombard':
        return { kind: 'bombard', buildingId: e.building, ticks: BOND_RULES.bombardTicks, source };
      case 'rally':
        return { kind: 'rally', ticks: BOND_RULES.rallyTicks, source };
      case 'fortify':
        return { kind: 'fortify', buildingId: e.building, amount: BOND_RULES.fortifyAmount, source };
      case 'break':
        return { kind: 'break', unitIds: e.units, ...(e.building ? { buildingId: e.building } : {}), ticks: BOND_RULES.breakTicks, source };
    }
  }

  /** Called every tick by the match: the computer replies when its thinking time is up. */
  tick(): TableEntry | null {
    if (!this.aiSide || this.over || this.turn !== this.aiSide) return null;
    if (this.aiDueAt === null) this.aiDueAt = this.sim.tick + DIFFICULTY[this.difficulty].chessThink;
    // Think a slice each tick; play when both the search and the thinking time are done.
    if (!this.thinking) this.thinking = { it: searchMove(this.game.fen, this.bonds, this.live, this.sim, this.aiSide, DIFFICULTY[this.difficulty].chessDepth) };
    if (!('result' in this.thinking)) {
      const r = this.thinking.it.next();
      if (r.done) this.thinking.result = r.value;
    }
    if (!('result' in this.thinking) || this.sim.tick < this.aiDueAt) return null;
    const move = this.thinking.result;
    this.thinking = null;
    this.aiDueAt = null;
    if (!move) return null;
    const rec = this.game.move(move as never);
    return rec ? this.record(this.aiSide, rec) : null;
  }

  /** Seconds until the computer replies, if it is thinking. */
  thinkingLeft(): number | null {
    return this.aiDueAt === null ? null : Math.max(0, (this.aiDueAt - this.sim.tick) / 10);
  }

  summary() {
    const out = this.game.outcome();
    const sunMoves = this.log.filter((e) => e.side === 'sun').length;
    const moonMoves = this.log.filter((e) => e.side === 'moon').length;
    const text = !out.over
      ? `unfinished after ${this.log.length} moves`
      : out.result === 'checkmate'
        ? `${sideOf(out.winner) === 'sun' ? 'Sun' : 'Moon'} won by checkmate`
        : `drawn (${out.result})`;
    return { sunMoves, moonMoves, text };
  }
}

/** Break is issued by the capturing side; everything else by the piece's own side. */
function effectColour(_e: Effect, side: Side): Colour {
  return colourOf(side);
}

export function pieceName(id: string): string {
  const [c, r, f] = id.split('-');
  const side = c === 'w' ? 'Sun' : 'Moon';
  const role = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[r as 'p'] ?? 'piece';
  return f ? `${side} ${f}-${role}` : `${side} ${role}`;
}
