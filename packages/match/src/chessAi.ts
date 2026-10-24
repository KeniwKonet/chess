/**
 * The Moon's War Table player: alpha-beta search over legal moves, scoring
 * material plus what a move would do on the battlefield right now (fortify a
 * damaged castle, volley with archers who are shooting, rally mid-fight...).
 *
 * The search is a generator that does a fixed amount of work per call, so the
 * match spreads it over several ticks of the AI's "thinking" time instead of
 * stalling a frame. Deterministic: same position and tick budget, same move.
 */
import { Chess, type Move } from 'chess.js';
import type { Bonds, Liveness } from '@cr/chess-core';
import type { Side, Sim } from '@cr/game-core';

const VALUE: Record<string, number> = { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0 };
/** Nodes searched per tick while thinking. */
export const NODES_PER_TICK = 25;
/** Hard ceiling on a single search. */
const NODE_LIMIT = 30000;

/** Battlefield value of moving the piece on `from` right now, in centipawns. */
export function bondBonus(from: string, bonds: Bonds, live: Liveness, sim: Sim, side: Side): number {
  const b = bonds.on(from);
  if (!b || bonds.leaderless(b, live)) return 0;
  switch (b.role) {
    case 'k': {
      const c = b.building ? sim.building(b.building) : undefined;
      return c ? Math.round(((c.maxHp - c.hp) / c.maxHp) * 120) : 0;
    }
    case 'b':
      return b.units.some((id) => sim.unit(id)?.state === 'attacking') ? 40 : 5;
    case 'q':
      return sim.units.some((u) => u.side === side && u.state === 'attacking') ? 30 : 0;
    case 'r': {
      const t = b.building ? sim.building(b.building) : undefined;
      return t && sim.tick - t.lastAttack < 30 ? 25 : 0;
    }
    case 'p':
      return 8;
    default:
      return 0;
  }
}

function materialOf(chess: Chess, colour: 'w' | 'b'): number {
  let s = 0;
  for (const row of chess.board()) for (const p of row) if (p) s += (p.color === colour ? 1 : -1) * VALUE[p.type]!;
  return s;
}

const ordered = (ms: Move[]) => ms.sort((a, b) => (b.captured ? VALUE[b.captured]! : 0) - (a.captured ? VALUE[a.captured]! : 0));

/**
 * Search the position (from FEN) for `side`. Yields after every NODES_PER_TICK
 * nodes; returns the chosen move in SAN (or null with no legal moves).
 */
export function* searchMove(fen: string, bonds: Bonds, live: Liveness, sim: Sim, side: Side, depth: number): Generator<void, string | null> {
  const chess = new Chess(fen);
  const colour = side === 'sun' ? 'w' : 'b';
  let nodes = 0;
  let budget = NODES_PER_TICK;

  function* search(d: number, alpha: number, beta: number, maximise: boolean): Generator<void, number> {
    nodes++;
    if (--budget <= 0) {
      budget = NODES_PER_TICK;
      yield;
    }
    if (d === 0 || nodes > NODE_LIMIT) return materialOf(chess, colour);
    const ms = chess.moves({ verbose: true });
    // No legal moves: mate (side to move loses) or stalemate. Cheaper than asking chess.js each node.
    if (!ms.length) return chess.inCheck() ? (maximise ? -100000 - d : 100000 + d) : 0;
    let best = maximise ? -Infinity : Infinity;
    for (const m of ordered(ms)) {
      chess.move(m);
      const v = yield* search(d - 1, alpha, beta, !maximise);
      chess.undo();
      if (maximise) {
        best = Math.max(best, v);
        alpha = Math.max(alpha, v);
      } else {
        best = Math.min(best, v);
        beta = Math.min(beta, v);
      }
      if (beta <= alpha) break;
    }
    return best;
  }

  const roots = ordered(chess.moves({ verbose: true }));
  if (!roots.length) return null;
  let bestMove: string | null = null;
  let bestScore = -Infinity;
  for (const m of roots) {
    chess.move(m);
    const score = (yield* search(depth - 1, bestScore, Infinity, false)) + bondBonus(m.from, bonds, live, sim, side);
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMove = m.san;
    }
  }
  return bestMove;
}

/** Run a search to completion in one go (tests and tools). */
export function chooseMove(fen: string, bonds: Bonds, live: Liveness, sim: Sim, side: Side, depth: number): string | null {
  const it = searchMove(fen, bonds, live, sim, side, depth);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
