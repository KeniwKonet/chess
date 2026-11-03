import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { KingdomGame, chooseKingdomMove, AI_LEVELS, type AiLevel } from '../src/index';

const play = (g: KingdomGame, sans: string[], t0 = 0, step = 1000) => {
  let now = t0;
  for (const san of sans) {
    const r = g.move(g.turn, san, (now += step));
    if (!r.ok) throw new Error(`${san}: ${r.reason}`);
  }
  return now;
};

describe('Chess Kingdom rules', () => {
  it('gives every piece a stable identity through captures, castling and en passant', () => {
    const g = new KingdomGame();
    play(g, ['e4', 'Nf6', 'e5', 'd5']);
    // En passant: the e-pawn takes the d-pawn, which stands on d5, not d6.
    const r = g.move('w', 'exd6', 10_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.move.mover.id).toBe('w-p-e2');
    expect(r.move.enPassant).toBe(true);
    expect(r.move.captured).toMatchObject({ id: 'b-p-d7', square: 'd5' });
    play(g, ['e6', 'Nf3', 'Be7', 'Bd3', 'O-O'], 10_000);
    const castle = g.history.at(-1)!;
    expect(castle.castle).toMatchObject({ side: 'king', from: 'h8', to: 'f8', rook: { id: 'b-r-h8' } });
    expect(g.tracker.on('g8')?.id).toBe('b-k-e8');
    expect(g.tracker.on('f8')?.id).toBe('b-r-h8');
    expect(g.tracker.on('f6')?.id).toBe('b-n-g8');
  });

  it('promotes a pawn into the chosen piece and keeps its identity', () => {
    const g = new KingdomGame({ fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1' });
    const r = g.move('w', { from: 'e7', to: 'e8', promotion: 'n' }, 1);
    expect(r.ok && r.move.moverRole).toBe('p');
    expect(r.ok && r.move.promotion).toBe('n');
    expect(g.tracker.on('e8')).toMatchObject({ id: 'w-p-e7', role: 'n' });
    expect(g.isPromotion('e8', 'e7')).toBe(false);
  });

  it('enforces turns and legality exactly as chess.js does, over random games', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let game = 0; game < 20; game++) {
      const g = new KingdomGame();
      const ref = new Chess();
      for (let ply = 0; ply < 120 && !g.over; ply++) {
        const legal = ref.moves();
        expect(g.targets('e1').sort()).toEqual(ref.moves({ square: 'e1', verbose: true }).map((m) => m.to).sort());
        const other = g.turn === 'w' ? 'b' : 'w';
        expect(g.move(other, legal[0]!, ply).ok).toBe(false);
        const san = legal[Math.floor(rand() * legal.length)]!;
        expect(g.move(g.turn, san, ply).ok).toBe(true);
        ref.move(san);
        expect(g.chess.fen).toBe(ref.fen());
      }
      // Every piece on the board is tracked on its square.
      for (const row of ref.board()) for (const p of row) if (p) expect(g.tracker.on(p.square)?.colour).toBe(p.color);
      expect(g.tracker.at.size).toBe(ref.board().flat().filter(Boolean).length);
    }
  });

  it('runs chess clocks with increment, from the first move, and ends on time', () => {
    const g = new KingdomGame({ timeControl: { initialMs: 60_000, incrementMs: 2_000 } });
    expect(g.timeLeft('w', 999_999)).toBe(60_000); // nothing runs before the first move
    g.move('w', 'e4', 5_000); // White's first move is free
    expect(g.clock.w).toBe(62_000);
    expect(g.timeLeft('b', 15_000)).toBe(50_000); // Black's clock runs from White's move
    g.move('b', 'e5', 15_000);
    expect(g.clock.b).toBe(52_000);
    expect(g.timeLeft('w', 20_000)).toBe(57_000);
    // White sits and flags.
    expect(g.checkTime(15_000 + 61_999)).toBeNull();
    expect(g.checkTime(15_000 + 62_000)).toEqual({ winner: 'b', reason: 'timeout' });
    expect(g.move('w', 'Nf3', 100_000).ok).toBe(false);
  });

  it('a flag against a lone king is a draw, not a loss', () => {
    // White has only the king; Black (with a pawn) runs out of time: White could never mate, so it is drawn.
    const g = new KingdomGame({ fen: '4k3/4p3/8/8/8/8/8/4K3 w - - 0 1', timeControl: { initialMs: 10_000, incrementMs: 0 } });
    g.move('w', 'Kd1', 0);
    expect(g.checkTime(20_000)).toEqual({ winner: null, reason: 'insufficient' });
    // With a rook, the same flag loses.
    const h = new KingdomGame({ fen: '4k3/4p3/8/8/8/8/8/R3K3 w - - 0 1', timeControl: { initialMs: 10_000, incrementMs: 0 } });
    h.move('w', 'Kd1', 0);
    expect(h.checkTime(20_000)).toEqual({ winner: 'w', reason: 'timeout' });
  });

  it('ends by checkmate, resignation and agreed draw', () => {
    const mate = new KingdomGame();
    play(mate, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(mate.result).toEqual({ winner: 'w', reason: 'checkmate' });
    expect(mate.history.at(-1)).toMatchObject({ mate: true, check: true, captured: { id: 'b-p-f7' } });

    const resign = new KingdomGame();
    play(resign, ['d4']);
    expect(resign.resign('b')).toEqual({ winner: 'w', reason: 'resignation' });

    const draw = new KingdomGame();
    play(draw, ['d4']);
    expect(draw.offerDraw('w')).toBe(false);
    play(draw, ['d5'], 5000); // a move declines the offer
    expect(draw.drawOffer).toBeNull();
    draw.offerDraw('w');
    expect(draw.offerDraw('b')).toBe(true);
    expect(draw.result).toEqual({ winner: null, reason: 'agreement' });
  });

  it('detects stalemate', () => {
    const s = new KingdomGame({ fen: 'k7/8/2Q5/8/8/8/8/7K w - - 0 1' });
    s.move('w', 'Qb6', 0);
    expect(s.result).toEqual({ winner: null, reason: 'stalemate' });
  });
});

describe('Chess Kingdom computer opponent', () => {
  const levels = Object.keys(AI_LEVELS) as AiLevel[];

  it('always plays a legal move, and finds mate in one at every level', () => {
    const mateIn1 = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    for (const level of levels) {
      expect(chooseKingdomMove(mateIn1, level, () => 0.5)).toBe('Qxf7#');
      const m = chooseKingdomMove(new Chess().fen(), level, () => 0.3)!;
      expect(new Chess().moves()).toContain(m);
    }
  });

  it('wins free material from Knight level up, and does not give away its queen', () => {
    // Black's queen on d5 hangs to the knight on c3.
    const free = 'rnb1kbnr/ppp1pppp/8/3q4/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3';
    for (const level of ['knight', 'lord', 'warlord'] as AiLevel[]) expect(chooseKingdomMove(free, level, () => 0)).toBe('Nxd5');
  });

  it('the strongest level answers quickly enough for a phone', () => {
    const t = performance.now();
    chooseKingdomMove('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5', 'warlord');
    expect(performance.now() - t).toBeLessThan(15_000);
  });
});
