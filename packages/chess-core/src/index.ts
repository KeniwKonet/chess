/**
 * Standard chess rules, delegated to chess.js (BSD-2-Clause, widely tested).
 * This package never changes the rules of chess. Chess Realms' battlefield
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
