import { describe, expect, it } from 'vitest';
import { StandardGame } from '../src/index';
import { Bonds, type Liveness, type SideAssignment } from '../src/bonds';

const white: SideAssignment = {
  pawns: [[1], [2], [3], [4], [5], [6], [7], [8]],
  bishops: [[9, 10, 11], [12, 13, 14]],
  rooks: ['sun_t1', 'sun_t2'],
  king: 'sun_castle',
};
const black: SideAssignment = {
  pawns: [[21], [22], [23], [24], [25], [26], [27], [28]],
  bishops: [[29, 30, 31], [32, 33, 34]],
  rooks: ['moon_t1', 'moon_t2'],
  king: 'moon_castle',
};
const allAlive: Liveness = { unitAlive: () => true, buildingStanding: () => true };

function play(moves: string[], live = allAlive, fen?: string, w = white, b = black) {
  const g = new StandardGame(fen);
  const bonds = new Bonds(w, b);
  const out = [];
  for (const m of moves) {
    const rec = g.move(m);
    if (!rec) throw new Error(`illegal ${m}`);
    out.push(bonds.apply(rec, live));
  }
  return { g, bonds, effects: out };
}

describe('War Table bonds', () => {
  it('maps each piece type to its documented effect', () => {
    const { effects } = play(['e4', 'Nf6', 'Bc4', 'e6', 'Qf3', 'Be7', 'Ke2', 'O-O', 'Rf1'.replace('Rf1', 'Kd3')]);
    expect(effects[0]).toEqual([{ kind: 'advance', colour: 'w', units: [5], piece: 'w-p-e' }]);
    expect(effects[1]).toEqual([]); // knights lead no one in this build
    expect(effects[2]).toEqual([{ kind: 'volley', colour: 'w', units: [12, 13, 14], piece: 'w-b-f' }]);
    expect(effects[4]).toEqual([{ kind: 'rally', colour: 'w', piece: 'w-q' }]);
    expect(effects[6]).toEqual([{ kind: 'fortify', colour: 'w', building: 'sun_castle', piece: 'w-k' }]);
  });

  it('follows a castling rook and gives it the bombard effect', () => {
    const { bonds, effects } = play(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'Re1']);
    expect(bonds.on('f1')).toBeUndefined();
    expect(bonds.on('e1')?.id).toBe('w-r-h');
    expect(effects[6]).toEqual([{ kind: 'fortify', colour: 'w', building: 'sun_castle', piece: 'w-k' }]);
    expect(effects[8]).toEqual([{ kind: 'bombard', colour: 'w', building: 'sun_t2', piece: 'w-r-h' }]);
  });

  it('breaks the regiment of a captured piece, including en passant', () => {
    const { bonds, effects } = play(['e4', 'd5', 'exd5']);
    expect(effects[2]).toContainEqual({ kind: 'break', colour: 'w', units: [24], piece: 'b-p-d' });
    const ep = play(['e4', 'a6', 'e5', 'd5', 'exd6']);
    expect(ep.effects[4]).toContainEqual({ kind: 'break', colour: 'w', units: [24], piece: 'b-p-d' });
    expect(ep.bonds.on('d5')).toBeUndefined();
    expect(bonds.pieces.has('b-p-d')).toBe(false);
  });

  it('keeps a promoted pawn bound and lets it act as a queen', () => {
    const fen = '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1';
    const g = new StandardGame(fen);
    // A custom board: only the e-pawn and kings exist, so bind just those.
    const w: SideAssignment = { pawns: [[], [], [], [], [99], [], [], []], bishops: [[], []], rooks: [undefined, undefined], king: 'sun_castle' };
    const bonds = new Bonds(w, { ...w, pawns: [[], [], [], [], [], [], [], []], king: 'moon_castle' });
    // Move the bound e-pawn identity from e2 to e7 to match the position.
    (bonds as unknown as { at: Map<string, string> }).at.set('e7', 'w-p-e');
    const rec = g.move({ from: 'e7', to: 'e8', promotion: 'q' })!;
    bonds.apply(rec, allAlive);
    expect(bonds.on('e8')).toMatchObject({ id: 'w-p-e', role: 'q' });
  });

  it('marks pieces leaderless when their soldiers fall or their tower is destroyed', () => {
    const live = { unitAlive: (id: number) => id !== 5, buildingStanding: (id: string) => id !== 'sun_t1' };
    const { effects, bonds } = play(['e4'], live);
    expect(effects[0]).toEqual([]); // e-pawn's soldier is dead: no advance
    expect(bonds.leaderless(bonds.on('a1')!, live)).toBe(true);
    expect(bonds.leaderless(bonds.on('d1')!, live)).toBe(false); // the queen leads the army
  });

  it('never changes what is legal: bonds follow chess.js through a full game', () => {
    // Scholar's mate, then the bonds must agree with the board on every square.
    const { g, bonds } = play(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(g.outcome()).toEqual({ over: true, result: 'checkmate', winner: 'w' });
    const board = new Map<string, string>();
    for (const [sq, b] of bonds.squares()) board.set(sq, `${b.colour}${b.role}`);
    // 32 pieces minus one captured (the f7 pawn).
    expect(board.size).toBe(31);
    expect(board.get('f7')).toBe('wq');
    expect(board.get('e8')).toBe('bk');
  });
});
