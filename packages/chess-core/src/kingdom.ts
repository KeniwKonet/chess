/**
 * Chess Kingdom: a game of standard chess in which every piece is a soldier
 * with a stable identity, so the battlefield can show "the Raider from g1
 * leaps to f3 and cuts down the Footman on e5".
 *
 * Legality, check, mate and draws all come from chess.js through
 * StandardGame. This module only adds:
 *   - PieceTracker: a stable id for every piece, followed through captures,
 *     castling, en passant and promotion;
 *   - KingdomGame: turns, chess clocks (Fischer increment), resignation,
 *     draw by agreement and loss on time, with a timestamp passed in so the
 *     same code runs on a phone and on the authoritative server.
 */
import type { Square } from 'chess.js';
import { StandardGame, type Colour, type MoveRecord } from './index';

export type Role = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface Piece {
  /** Stable for the whole game, e.g. "w-n-g1" (colour, starting role, starting square). */
  id: string;
  colour: Colour;
  /** Current role (changes on promotion). */
  role: Role;
}

/** One move as the battlefield sees it. */
export interface KingdomMove {
  ply: number;
  san: string;
  colour: Colour;
  from: Square;
  to: Square;
  mover: Piece;
  /** Role before the move (a promoting pawn is still 'p' here). */
  moverRole: Role;
  captured?: Piece & { square: Square };
  castle?: { side: 'king' | 'queen'; rook: Piece; from: Square; to: Square };
  promotion?: Role;
  enPassant: boolean;
  check: boolean;
  mate: boolean;
  /** Clock of the side that moved, after increment (ms), if timed. */
  clockAfter?: number;
}

export type ResultReason =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'agreement'
  | 'abandoned';

export interface KingdomResult {
  /** null for a draw. */
  winner: Colour | null;
  reason: ResultReason;
}

export interface TimeControl {
  /** Starting time per side, ms. */
  initialMs: number;
  /** Added after each move (Fischer), ms. */
  incrementMs: number;
}

export const TIME_CONTROLS: Record<string, TimeControl | null> = {
  '3+2': { initialMs: 3 * 60_000, incrementMs: 2_000 },
  '5+3': { initialMs: 5 * 60_000, incrementMs: 3_000 },
  '10+5': { initialMs: 10 * 60_000, incrementMs: 5_000 },
  '15+10': { initialMs: 15 * 60_000, incrementMs: 10_000 },
  untimed: null,
};

export const ROLE_NAME: Record<Role, string> = { p: 'Footman', n: 'Raider', b: 'Ranger', r: 'Siege Tower', q: 'Sorceress', k: 'King' };
export const CHESS_NAME: Record<Role, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
/** How each role moves and fights, in the words the game shows players. */
export const ROLE_RULE: Record<Role, string> = {
  p: 'Marches one square forward (two from its first rank) and strikes one square diagonally forward. Reaching the far rank, it is promoted.',
  n: 'Leaps in an L: two squares one way, one square to the side. The only soldier who jumps over others.',
  b: 'Moves any distance along diagonals and shoots the first enemy in its path.',
  r: 'Rolls any distance in a straight line along ranks and files and bombards what blocks it. Castles with the King.',
  q: 'Moves any distance in any straight line or diagonal: the most powerful soldier on the field.',
  k: 'Steps one square in any direction and must never stand in danger. Lose the King and the kingdom falls.',
};

const files = 'abcdefgh';

/** Follows every piece through the game. */
export class PieceTracker {
  readonly at = new Map<string, string>();
  readonly pieces = new Map<string, Piece>();

  constructor(game: StandardGame) {
    for (let r = 1; r <= 8; r++) {
      for (const f of files) {
        const sq = `${f}${r}` as Square;
        const p = game.pieceAt(sq);
        if (!p) continue;
        const id = `${p.color}-${p.type}-${sq}`;
        this.pieces.set(id, { id, colour: p.color, role: p.type as Role });
        this.at.set(sq, id);
      }
    }
  }

  on(sq: string): Piece | undefined {
    const id = this.at.get(sq);
    return id ? this.pieces.get(id) : undefined;
  }

  /** Square of a piece, if it is still on the board. */
  squareOf(id: string): Square | undefined {
    for (const [sq, pid] of this.at) if (pid === id) return sq as Square;
    return undefined;
  }

  /** Apply a legal move (as just played on the StandardGame) and describe it. Call once per move, in order. */
  apply(m: MoveRecord, ply: number, mate: boolean): KingdomMove {
    const moverId = this.at.get(m.from);
    if (!moverId) throw new Error(`PieceTracker out of sync: nothing on ${m.from}`);
    const mover = this.pieces.get(moverId)!;
    const moverRole = mover.role;
    const capSq = (m.enPassant ? `${m.to[0]}${m.from[1]}` : m.to) as Square;
    let captured: KingdomMove['captured'];
    if (m.captured) {
      const cid = this.at.get(capSq);
      if (!cid) throw new Error(`PieceTracker out of sync: no piece to capture on ${capSq}`);
      captured = { ...this.pieces.get(cid)!, square: capSq };
      this.at.delete(capSq);
    }
    this.at.delete(m.from);
    this.at.set(m.to, moverId);
    let castle: KingdomMove['castle'];
    if (m.castle) {
      const rank = m.colour === 'w' ? '1' : '8';
      const [rf, rt] = (m.castle === 'king' ? [`h${rank}`, `f${rank}`] : [`a${rank}`, `d${rank}`]) as [Square, Square];
      const rookId = this.at.get(rf);
      if (!rookId) throw new Error(`PieceTracker out of sync: no rook on ${rf}`);
      this.at.delete(rf);
      this.at.set(rt, rookId);
      castle = { side: m.castle, rook: { ...this.pieces.get(rookId)! }, from: rf, to: rt };
    }
    if (m.promotion) mover.role = m.promotion as Role;
    return {
      ply,
      san: m.san,
      colour: m.colour,
      from: m.from,
      to: m.to,
      mover: { ...mover },
      moverRole,
      ...(captured ? { captured } : {}),
      ...(castle ? { castle } : {}),
      ...(m.promotion ? { promotion: m.promotion as Role } : {}),
      enPassant: m.enPassant,
      check: m.check,
      mate,
    };
  }
}

export type MoveInput = string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' };
export type MoveResult = { ok: true; move: KingdomMove } | { ok: false; reason: string };

/**
 * A game of Chess Kingdom with clocks. Time is always passed in (`now`, ms),
 * never read from a clock, so the server is the authority online and tests
 * are exact.
 */
export class KingdomGame {
  readonly chess: StandardGame;
  readonly tracker: PieceTracker;
  readonly history: KingdomMove[] = [];
  readonly timeControl: TimeControl | null;
  /** Remaining time per side at the start of the current turn (ms). */
  readonly clock: Record<Colour, number>;
  /** When the current turn began (ms); the clock does not run before the first move. */
  turnStartedAt: number | null = null;
  result: KingdomResult | null = null;
  /** A pending draw offer, by colour. */
  drawOffer: Colour | null = null;

  constructor(opts: { timeControl?: TimeControl | null; fen?: string } = {}) {
    this.chess = new StandardGame(opts.fen);
    this.tracker = new PieceTracker(this.chess);
    this.timeControl = opts.timeControl ?? null;
    const t = this.timeControl?.initialMs ?? Infinity;
    this.clock = { w: t, b: t };
  }

  get turn(): Colour {
    return this.chess.turn;
  }

  get over(): boolean {
    return this.result !== null;
  }

  /** Time left for a side right now (ms); Infinity when untimed. */
  timeLeft(colour: Colour, now: number): number {
    if (!this.timeControl) return Infinity;
    const base = this.clock[colour];
    if (this.result || this.turnStartedAt === null || colour !== this.turn) return base;
    return Math.max(0, base - (now - this.turnStartedAt));
  }

  /** Legal destination squares from a square, for the side to move. */
  targets(from: string): string[] {
    if (this.result) return [];
    return this.chess.verboseMoves(from as Square).map((m) => m.to);
  }

  /** Does moving from -> to promote (so the player must choose a piece)? */
  isPromotion(from: string, to: string): boolean {
    return this.chess.verboseMoves(from as Square).some((m) => m.to === to && m.promotion);
  }

  /** End the game on time if the side to move has run out. Returns the result if it ended. */
  checkTime(now: number): KingdomResult | null {
    if (this.result || !this.timeControl || this.turnStartedAt === null) return null;
    const c = this.turn;
    if (this.timeLeft(c, now) > 0) return null;
    this.clock[c] = 0;
    // Out of time, but if the opponent could never checkmate, it is a draw (FIDE 6.9).
    const opp: Colour = c === 'w' ? 'b' : 'w';
    this.result = canMate(this.chess, opp) ? { winner: opp, reason: 'timeout' } : { winner: null, reason: 'insufficient' };
    return this.result;
  }

  /** Play a move for `colour` at time `now`. */
  move(colour: Colour, input: MoveInput, now: number): MoveResult {
    if (this.checkTime(now)) return { ok: false, reason: 'Out of time' };
    if (this.result) return { ok: false, reason: 'The game is over' };
    if (colour !== this.turn) return { ok: false, reason: 'Not your turn' };
    const rec = this.chess.move(input as never);
    if (!rec) return { ok: false, reason: 'That move is not legal' };
    const outcome = this.chess.outcome();
    const mate = outcome.over && outcome.result === 'checkmate';
    const move = this.tracker.apply(rec, this.history.length + 1, mate);
    if (this.timeControl) {
      // Time used is charged once a clock is running; the increment is added after every move (FIDE).
      if (this.turnStartedAt !== null) this.clock[colour] = Math.max(0, this.clock[colour] - (now - this.turnStartedAt));
      this.clock[colour] += this.timeControl.incrementMs;
      move.clockAfter = this.clock[colour];
    }
    // Clocks start with White's first move (Black's clock then runs); before that nothing runs.
    this.turnStartedAt = now;
    this.history.push(move);
    this.drawOffer = null;
    if (outcome.over) {
      this.result = outcome.result === 'checkmate' ? { winner: outcome.winner, reason: 'checkmate' } : { winner: null, reason: outcome.result === 'draw' ? 'fifty-move' : outcome.result };
    }
    return { ok: true, move };
  }

  resign(colour: Colour): KingdomResult | null {
    if (this.result) return null;
    this.result = { winner: colour === 'w' ? 'b' : 'w', reason: 'resignation' };
    return this.result;
  }

  /** Offer a draw, or accept the opponent's pending offer. Returns true if the game ended in a draw. */
  offerDraw(colour: Colour): boolean {
    if (this.result) return false;
    if (this.drawOffer && this.drawOffer !== colour) {
      this.result = { winner: null, reason: 'agreement' };
      return true;
    }
    this.drawOffer = colour;
    return false;
  }

  declineDraw(colour: Colour) {
    if (this.drawOffer && this.drawOffer !== colour) this.drawOffer = null;
  }

  /** Captured pieces of a colour, in order. */
  fallen(colour: Colour): Piece[] {
    return this.history.filter((m) => m.captured?.colour === colour).map((m) => m.captured!);
  }

  /** Material balance in pawns, White minus Black. */
  material(): number {
    const v: Record<Role, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let s = 0;
    for (const id of this.tracker.at.values()) {
      const p = this.tracker.pieces.get(id)!;
      s += (p.colour === 'w' ? 1 : -1) * v[p.role];
    }
    return s;
  }
}

/**
 * Could `colour` still checkmate by some sequence of legal moves? Used when the
 * opponent runs out of time (FIDE 6.9): a bare king never can, and one minor
 * piece cannot against a bare king; anything else can, with help.
 */
function canMate(game: StandardGame, colour: Colour): boolean {
  let own = 0;
  let ownMinors = 0;
  let theirs = 0;
  for (let r = 1; r <= 8; r++) {
    for (const f of files) {
      const p = game.pieceAt(`${f}${r}` as Square);
      if (!p || p.type === 'k') continue;
      if (p.color === colour) {
        own++;
        if (p.type === 'n' || p.type === 'b') ownMinors++;
      } else theirs++;
    }
  }
  if (own === 0) return false;
  if (own === 1 && ownMinors === 1 && theirs === 0) return false;
  return true;
}

export const resultText = (r: KingdomResult, names: Record<Colour, string> = { w: 'Sun', b: 'Moon' }): string => {
  if (r.winner) {
    const w = names[r.winner];
    const l = names[r.winner === 'w' ? 'b' : 'w'];
    switch (r.reason) {
      case 'checkmate':
        return `Checkmate. The ${w} wins.`;
      case 'resignation':
        return `The ${l} resigns. The ${w} wins.`;
      case 'timeout':
        return `The ${l} ran out of time. The ${w} wins.`;
      case 'abandoned':
        return `The ${l} left the battle. The ${w} wins.`;
      default:
        return `The ${w} wins.`;
    }
  }
  const why: Record<string, string> = {
    stalemate: 'Stalemate',
    insufficient: 'Neither side can checkmate',
    threefold: 'The same position three times',
    'fifty-move': 'Fifty moves without a capture or pawn move',
    agreement: 'Draw agreed',
  };
  return `${why[r.reason] ?? 'Draw'}. The battle is drawn.`;
};
