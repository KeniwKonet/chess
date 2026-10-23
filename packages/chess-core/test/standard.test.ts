import { describe, expect, it } from 'vitest';
import { StandardGame } from '../src/index';

describe('standard chess rules (chess.js)', () => {
  it('starts with 20 legal moves for White', () => {
    expect(new StandardGame().legalMoves()).toHaveLength(20);
  });
  it('rejects illegal moves without changing the position', () => {
    const g = new StandardGame();
    const before = g.fen;
    expect(g.move('e5')).toBeNull();
    expect(g.move({ from: 'e2', to: 'e5' })).toBeNull();
    expect(g.fen).toBe(before);
  });
  it("detects fool's mate as checkmate for Black", () => {
    const g = new StandardGame();
    for (const m of ['f3', 'e5', 'g4']) g.move(m);
    const last = g.move('Qh4#');
    expect(last?.check).toBe(true);
    expect(g.outcome()).toEqual({ over: true, result: 'checkmate', winner: 'b' });
  });
  it('reports castling, en passant and promotion', () => {
    const castle = new StandardGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(castle.move('O-O')?.castle).toBe('king');
    const ep = new StandardGame('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    expect(ep.move('exd6')?.enPassant).toBe(true);
    const promo = new StandardGame('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1');
    expect(promo.move({ from: 'e7', to: 'e8', promotion: 'q' })?.promotion).toBe('q');
  });
  it('detects stalemate and insufficient material', () => {
    expect(new StandardGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').outcome()).toEqual({ over: true, result: 'stalemate' });
    expect(new StandardGame('8/8/8/4k3/8/8/8/4K3 w - - 0 1').outcome()).toEqual({ over: true, result: 'insufficient' });
  });
  it('detects threefold repetition', () => {
    const g = new StandardGame();
    for (let i = 0; i < 2; i++) for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) g.move(m);
    expect(g.outcome()).toEqual({ over: true, result: 'threefold' });
  });
});
