/**
 * Standard chess rules, delegated to chess.js (BSD-2-Clause, widely tested).
 * This package never changes the rules of chess. ChessFront' battlefield
 * effects ("bonds") live in a separate rules layer added in milestone 5, which
 * reads the moves this package reports and never alters their legality.
 */
import { Chess, type Move, type Square } from 'chess.js';

export type Colour = 'w' | 'b';
export type Outcome =
  | { over: false }
  | { over: true; result: 'checkmate'; winner: Colour }
  | { over: true; result: 'stalemate' | 'insufficient' | 'threefold' | 'fifty-move' | 'draw' };

export interface MoveRecord {
  san: string;
  from: Square;
  to: Square;
  piece: Move['piece'];
  colour: Colour;
  captured?: Move['captured'];
  promotion?: Move['promotion'];
  castle?: 'king' | 'queen';
  enPassant: boolean;
  check: boolean;
}

export class StandardGame {
  private chess: Chess;
  constructor(fen?: string) {
    this.chess = new Chess(fen);
  }
  get fen() {
    return this.chess.fen();
  }
  get turn(): Colour {
    return this.chess.turn();
  }
  inCheck() {
    return this.chess.inCheck();
  }
  /** Legal moves with from/to squares (optionally only from one square). */
  verboseMoves(from?: Square): { san: string; from: Square; to: Square; captured?: string; promotion?: string }[] {
    return (from ? this.chess.moves({ square: from, verbose: true }) : this.chess.moves({ verbose: true })).map((m) => ({
      san: m.san,
      from: m.from,
      to: m.to,
      ...(m.captured ? { captured: m.captured } : {}),
      ...(m.promotion ? { promotion: m.promotion } : {}),
    }));
  }
  /**
   * Pieces of `colour` (not the king) the other side could win now: attacked and
   * not defended, or attacked by something worth less. Most valuable first.
   */
  threatened(colour: Colour): { square: Square; type: string }[] {
    const them = colour === 'w' ? 'b' : 'w';
    const value: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    const out: { square: Square; type: string; v: number }[] = [];
    for (const row of this.chess.board())
      for (const cell of row) {
        if (!cell || cell.color !== colour || cell.type === 'k') continue;
        const attackers = this.chess.attackers(cell.square, them);
        if (!attackers.length) continue;
        const defended = this.chess.attackers(cell.square, colour).length > 0;
        const cheapest = Math.min(...attackers.map((sq) => value[this.chess.get(sq)!.type] ?? 0));
        if (!defended || cheapest < value[cell.type]!) out.push({ square: cell.square, type: cell.type, v: value[cell.type]! });
      }
    return out.sort((a, b) => b.v - a.v).map(({ square, type }) => ({ square, type }));
  }
  /** Piece on a square, if any. */
  pieceAt(sq: Square): { type: string; color: 'w' | 'b' } | null {
    return this.chess.get(sq) ?? null;
  }
  legalMoves(from?: Square): string[] {
    return from ? this.chess.moves({ square: from }) : this.chess.moves();
  }
  /** Attempt a move; returns null (and changes nothing) if illegal. */
  move(m: string | { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' }): MoveRecord | null {
    let mv: Move;
    try {
      mv = this.chess.move(m);
    } catch {
      return null;
    }
    return {
      san: mv.san,
      from: mv.from,
      to: mv.to,
      piece: mv.piece,
      colour: mv.color,
      ...(mv.captured ? { captured: mv.captured } : {}),
      ...(mv.promotion ? { promotion: mv.promotion } : {}),
      ...(mv.isKingsideCastle() ? { castle: 'king' as const } : mv.isQueensideCastle() ? { castle: 'queen' as const } : {}),
      enPassant: mv.isEnPassant(),
      check: this.chess.inCheck(),
    };
  }
  outcome(): Outcome {
    const c = this.chess;
    if (c.isCheckmate()) return { over: true, result: 'checkmate', winner: c.turn() === 'w' ? 'b' : 'w' };
    if (c.isStalemate()) return { over: true, result: 'stalemate' };
    if (c.isInsufficientMaterial()) return { over: true, result: 'insufficient' };
    if (c.isThreefoldRepetition()) return { over: true, result: 'threefold' };
    if (c.isDrawByFiftyMoves()) return { over: true, result: 'fifty-move' };
    if (c.isDraw()) return { over: true, result: 'draw' };
    return { over: false };
  }
}
export * from './bonds';
export type { Square } from 'chess.js';
export * from './kingdom';
export * from './kingdomAi';
export * from './online';
