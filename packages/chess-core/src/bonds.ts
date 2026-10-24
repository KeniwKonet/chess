/**
 * Bonds: the custom ruleset that links War Table pieces to the battlefield.
 *
 * This layer never decides whether a move is legal; standard chess
 * (chess.js via StandardGame) does that, unchanged. Bonds only:
 *   1. track each piece's identity as it moves (including castling,
 *      en passant and promotion), so it stays bound to the same regiment;
 *   2. say which battlefield effect a legal move triggers;
 *   3. report pieces whose regiment has fallen as leaderless.
 *
 * The mapping and every effect are documented in docs/RULES.md. Durations
 * and magnitudes are applied by the match (packages/match), not here.
 */
import type { MoveRecord } from './index';

export type PieceRole = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Colour = 'w' | 'b';

/** What a piece commands on the battlefield. */
export interface Binding {
  /** Stable identity, e.g. "w-p-e" (the white pawn that started on e2). */
  id: string;
  colour: Colour;
  /** Piece type now (a promoted pawn becomes a queen, keeping its binding). */
  role: PieceRole;
  /** Soldiers bound to this piece (pawns, bishops). */
  units: number[];
  /** Building bound to this piece (king: castle, rooks: towers). */
  building?: string;
  /** Queen: the whole army. */
  army?: boolean;
}

export type BondEffect =
  | { kind: 'advance'; colour: Colour; units: number[]; piece: string }
  | { kind: 'volley'; colour: Colour; units: number[]; piece: string }
  | { kind: 'bombard'; colour: Colour; building: string; piece: string }
  | { kind: 'rally'; colour: Colour; piece: string }
  | { kind: 'fortify'; colour: Colour; building: string; piece: string }
  /** The capturing side breaks the captured piece's regiment. */
  | { kind: 'break'; colour: Colour; units: number[]; building?: string; piece: string };

export interface SideAssignment {
  /** Eight lists of soldier ids, for the pawns on files a..h. */
  pawns: number[][];
  /** Soldier ids for the c-file and f-file bishops. */
  bishops: [number[], number[]];
  /** Building ids for the a-file and h-file rooks. */
  rooks: [string | undefined, string | undefined];
  /** The castle. */
  king: string;
}

export interface Liveness {
  unitAlive: (id: number) => boolean;
  buildingStanding: (id: string) => boolean;
}

const FILES = 'abcdefgh';

export class Bonds {
  /** Square -> piece identity. */
  private at = new Map<string, string>();
  readonly pieces = new Map<string, Binding>();

  constructor(white: SideAssignment, black: SideAssignment) {
    for (const [colour, a, back, pawnRank] of [
      ['w', white, '1', '2'],
      ['b', black, '8', '7'],
    ] as const) {
      for (let f = 0; f < 8; f++) {
        const file = FILES[f]!;
        this.add(`${file}${pawnRank}`, { id: `${colour}-p-${file}`, colour, role: 'p', units: a.pawns[f] ?? [] });
      }
      this.add(`a${back}`, { id: `${colour}-r-a`, colour, role: 'r', units: [], ...(a.rooks[0] ? { building: a.rooks[0] } : {}) });
      this.add(`h${back}`, { id: `${colour}-r-h`, colour, role: 'r', units: [], ...(a.rooks[1] ? { building: a.rooks[1] } : {}) });
      this.add(`b${back}`, { id: `${colour}-n-b`, colour, role: 'n', units: [] });
      this.add(`g${back}`, { id: `${colour}-n-g`, colour, role: 'n', units: [] });
      this.add(`c${back}`, { id: `${colour}-b-c`, colour, role: 'b', units: a.bishops[0] });
      this.add(`f${back}`, { id: `${colour}-b-f`, colour, role: 'b', units: a.bishops[1] });
      this.add(`d${back}`, { id: `${colour}-q`, colour, role: 'q', units: [], army: true });
      this.add(`e${back}`, { id: `${colour}-k`, colour, role: 'k', units: [], building: a.king });
    }
  }

  private add(square: string, b: Binding) {
    this.at.set(square, b.id);
    this.pieces.set(b.id, b);
  }

  /** The binding of the piece on a square, if any. */
  on(square: string): Binding | undefined {
    const id = this.at.get(square);
    return id ? this.pieces.get(id) : undefined;
  }

  /** Squares currently occupied, for drawing (identity per square). */
  squares(): [string, Binding][] {
    return [...this.at].map(([sq, id]) => [sq, this.pieces.get(id)!]);
  }

  /** A piece whose bound regiment or building is gone still moves, but triggers nothing on the battlefield. */
  leaderless(b: Binding, live: Liveness): boolean {
    if (b.army) return false;
    if (b.building !== undefined) return !live.buildingStanding(b.building);
    if (b.role === 'n' && !b.units.length) return true; // no cavalry fielded: knights command no one
    return !b.units.some(live.unitAlive);
  }

  /**
   * Apply a legal move (as reported by StandardGame) and return the battlefield
   * effects it triggers. Must be called once per move, in order.
   */
  apply(m: MoveRecord, live: Liveness): BondEffect[] {
    const effects: BondEffect[] = [];
    const moverId = this.at.get(m.from);
    if (!moverId) throw new Error(`Bonds out of sync: nothing on ${m.from}`);
    const mover = this.pieces.get(moverId)!;

    // Captured piece (en passant takes the pawn beside the destination).
    const capSq = m.enPassant ? `${m.to[0]}${m.from[1]}` : m.to;
    const capturedId = m.captured ? this.at.get(capSq) : undefined;
    if (m.captured && !capturedId) throw new Error(`Bonds out of sync: no piece to capture on ${capSq}`);
    if (capturedId) {
      this.at.delete(capSq);
      const cap = this.pieces.get(capturedId)!;
      this.pieces.delete(capturedId);
      if (!this.leaderless(cap, live) && (cap.units.length || cap.building)) {
        effects.push({ kind: 'break', colour: mover.colour, units: cap.units.filter(live.unitAlive), ...(cap.building ? { building: cap.building } : {}), piece: cap.id });
      }
    }

    this.at.delete(m.from);
    this.at.set(m.to, moverId);
    if (m.castle) {
      const rank = m.colour === 'w' ? '1' : '8';
      const [rf, rt] = m.castle === 'king' ? [`h${rank}`, `f${rank}`] : [`a${rank}`, `d${rank}`];
      const rookId = this.at.get(rf);
      if (!rookId) throw new Error(`Bonds out of sync: no rook on ${rf}`);
      this.at.delete(rf);
      this.at.set(rt, rookId);
    }
    if (m.promotion) mover.role = m.promotion as PieceRole;

    // The moved piece's own effect, if it still leads anyone.
    if (!this.leaderless(mover, live)) {
      const c = mover.colour;
      switch (mover.role) {
        case 'p':
          effects.push({ kind: 'advance', colour: c, units: mover.units.filter(live.unitAlive), piece: mover.id });
          break;
        case 'b':
          if (mover.units.length) effects.push({ kind: 'volley', colour: c, units: mover.units.filter(live.unitAlive), piece: mover.id });
          break;
        case 'r':
          if (mover.building) effects.push({ kind: 'bombard', colour: c, building: mover.building, piece: mover.id });
          break;
        case 'q':
          effects.push({ kind: 'rally', colour: c, piece: mover.id });
          break;
        case 'k':
          if (mover.building) effects.push({ kind: 'fortify', colour: c, building: mover.building, piece: mover.id });
          break;
        case 'n':
          break;
      }
    }
    return effects;
  }
}
