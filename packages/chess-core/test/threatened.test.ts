import { describe, expect, it } from 'vitest';
import { StandardGame } from '../src/index';

describe('threatened soldiers (coach tips)', () => {
  it('finds undefended pieces and pieces attacked by something cheaper, most valuable first', () => {
    // White queen on d4 attacked by a black pawn on e5 (defended or not, a pawn takes a queen); white knight on a5 attacked by a black bishop and not defended.
    const g = new StandardGame('4k3/2b5/8/N3p3/3Q4/8/8/4K3 w - - 0 1');
    expect(g.threatened('w')).toEqual([
      { square: 'd4', type: 'q' },
      { square: 'a5', type: 'n' },
    ]);
    // A defended pawn attacked by a pawn is not "hanging".
    expect(new StandardGame('4k3/8/3p4/4P3/5P2/8/8/4K3 w - - 0 1').threatened('w')).toEqual([]);
    expect(new StandardGame().threatened('w')).toEqual([]);
  });
});
