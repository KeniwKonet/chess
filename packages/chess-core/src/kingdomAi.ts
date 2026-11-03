/**
 * Computer opponent for Chess Kingdom: iterative-deepening alpha-beta with
 * material and piece-square tables, capture-only quiescence at the horizon,
 * and MVV/LVA move ordering.
 *
 * It runs as a generator so the caller decides how much work happens per
 * frame (a time budget in the browser, all at once in tests). Weaker levels
 * search shallower and pick among near-best moves at random, so they play
 * like a person rather than a broken engine.
 */
import { Chess } from 'chess.js';

export type AiLevel = 'squire' | 'knight' | 'lord' | 'warlord';

export const AI_LEVELS: Record<AiLevel, { label: string; blurb: string; depth: number; slack: number; nodes: number }> = {
  squire: { label: 'Squire', blurb: 'Learning the ropes. Makes mistakes.', depth: 1, slack: 70, nodes: 4_000 },
  knight: { label: 'Knight', blurb: 'Plays sensibly, sees simple tactics.', depth: 2, slack: 35, nodes: 20_000 },
  lord: { label: 'Lord', blurb: 'Looks three moves deep.', depth: 3, slack: 10, nodes: 30_000 },
  warlord: { label: 'Warlord', blurb: 'Thinks hard. Punishes errors.', depth: 4, slack: 0, nodes: 70_000 },
};

const VALUE: Record<string, number> = { p: 100, n: 310, b: 330, r: 500, q: 900, k: 0 };

// Piece-square tables from White's point of view, a8..h1 row-major (rank 8 first), in centipawns.
const PST: Record<string, number[]> = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 22, 22, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  // Endgame king: walk to the centre.
  kEnd: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
};

/**
 * chess.js internals used for speed. The public API builds SAN (with check and
 * mate detection) for every generated move, which costs a full move generation
 * per move; the search only needs raw moves. These are stable in chess.js 1.x
 * (its own perft and SAN code use them); tests pin the behaviour.
 */
interface RawMove {
  color: 'w' | 'b';
  from: number;
  to: number;
  piece: string;
  captured?: string;
  promotion?: string;
  flags: number;
}
interface Engine {
  _moves(o?: { legal?: boolean }): RawMove[];
  _makeMove(m: RawMove): void;
  _undoMove(): void;
  _isKingAttacked(c: 'w' | 'b'): boolean;
  _board: ({ color: 'w' | 'b'; type: string } | undefined)[];
  _turn: 'w' | 'b';
}
const sq = (i: number) => `${'abcdefgh'[i & 7]}${8 - (i >> 4)}`;

/** Static evaluation from the side to move's point of view. */
function evaluate(e: Engine): number {
  const board = e._board;
  let nonPawn = 0;
  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7;
      continue;
    }
    const p = board[i];
    if (p && p.type !== 'p' && p.type !== 'k') nonPawn += VALUE[p.type]!;
  }
  const endgame = nonPawn <= 2600;
  let s = 0;
  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7;
      continue;
    }
    const p = board[i];
    if (!p) continue;
    const r = i >> 4;
    const f = i & 7;
    const idx = p.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
    const table = p.type === 'k' && endgame ? PST.kEnd! : PST[p.type]!;
    const v = VALUE[p.type]! + table[idx]!;
    s += p.color === 'w' ? v : -v;
  }
  return e._turn === 'w' ? s : -s;
}

const MATE = 100_000;

const score = (m: RawMove) => (m.captured ? 10 * VALUE[m.captured]! - VALUE[m.piece]! + 10_000 : 0) + (m.promotion ? 8_000 + VALUE[m.promotion]! : 0);
const order = (ms: RawMove[]) => ms.sort((a, b) => score(b) - score(a));

/**
 * Search for the side to move. Yields every `yieldEvery` nodes so the caller can
 * spread the work; returns the chosen move in SAN, or null if there are no legal moves.
 * `rand` (0..1) is used only to choose among near-best moves at weaker levels.
 */
export function* searchKingdom(fen: string, level: AiLevel, rand: () => number = Math.random, yieldEvery = 400): Generator<void, string | null> {
  const cfg = AI_LEVELS[level];
  const chess = new Chess(fen);
  const e = chess as unknown as Engine;
  const roots = order(e._moves({ legal: true }));
  if (!roots.length) return null;
  const sanOf = (m: RawMove) => chess.moves({ verbose: true }).find((v) => v.from === sq(m.from) && v.to === sq(m.to) && (v.promotion ?? '') === (m.promotion ?? ''))!.san;
  if (roots.length === 1) return sanOf(roots[0]!);
  let nodes = 0;
  let budget = yieldEvery;
  let aborted = false;

  function* quiesce(alpha: number, beta: number, qd: number): Generator<void, number> {
    nodes++;
    if (--budget <= 0) {
      budget = yieldEvery;
      yield;
    }
    const stand = evaluate(e);
    if (stand >= beta || qd === 0) return stand;
    if (stand > alpha) alpha = stand;
    for (const m of order(e._moves({ legal: true }).filter((x) => x.captured || x.promotion))) {
      e._makeMove(m);
      const v = -(yield* quiesce(-beta, -alpha, qd - 1));
      e._undoMove();
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function* negamax(d: number, alpha: number, beta: number, ply: number): Generator<void, number> {
    nodes++;
    if (--budget <= 0) {
      budget = yieldEvery;
      yield;
    }
    if (nodes > cfg.nodes) aborted = true;
    const ms = e._moves({ legal: true });
    if (!ms.length) return e._isKingAttacked(e._turn) ? -MATE + ply : 0;
    if (d <= 0 || aborted) return yield* quiesce(alpha, beta, 3);
    let best = -Infinity;
    for (const m of order(ms)) {
      e._makeMove(m);
      const v = -(yield* negamax(d - 1, -beta, -alpha, ply + 1));
      e._undoMove();
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  // Iterative deepening: keep the scores of the deepest completed iteration.
  let scored: { m: RawMove; score: number }[] = roots.map((m) => ({ m, score: 0 }));
  for (let depth = 1; depth <= cfg.depth; depth++) {
    const ms = [...scored].sort((a, b) => b.score - a.score).map((x) => x.m);
    const out: { m: RawMove; score: number }[] = [];
    let alpha = -Infinity;
    for (const m of ms) {
      e._makeMove(m);
      // Weaker levels need comparable scores for the top moves (a window of `slack` below the best).
      const lo = cfg.slack > 0 ? alpha - cfg.slack - 1 : alpha;
      const v = -(yield* negamax(depth - 1, -Infinity, -lo, 1));
      e._undoMove();
      out.push({ m, score: v });
      if (v > alpha) alpha = v;
      if (aborted) break;
    }
    if (out.length === roots.length) scored = out;
    if (aborted) break;
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!.score;
  // A forced mate is always taken; otherwise weaker levels choose among moves within `slack`.
  if (top > MATE - 1000 || cfg.slack === 0) return sanOf(scored[0]!.m);
  const near = scored.filter((x) => x.score >= top - cfg.slack);
  return sanOf(near[Math.floor(rand() * near.length) % near.length]!.m);
}

/** Run a search to completion (tests, tools, the server). */
export function chooseKingdomMove(fen: string, level: AiLevel, rand?: () => number): string | null {
  const it = searchKingdom(fen, level, rand, 1_000_000);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
