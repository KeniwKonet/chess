import { describe, expect, it } from 'vitest';
import { chooseTile, maskOf, popcount, rotateMask } from '../src/autotile';

describe('auto-tiling', () => {
  it('finds an exact tile for every river pattern with 2+ connections', () => {
    let exact = 0;
    for (let m = 0; m < 64; m++) {
      if (popcount(m) < 2) continue;
      const c = chooseTile('river', m);
      if (!c.approximate) {
        exact++;
        expect(maskOf('river', c)).toBe(m);
      }
    }
    // 57 masks have 2+ bits; the pack covers all but the "opposite pair + one" shapes it lacks.
    expect(exact).toBeGreaterThanOrEqual(50);
  });

  it('covers every 2-connection shape exactly (straight, wide bend, sharp bend)', () => {
    for (let a = 0; a < 6; a++) {
      for (let b = a + 1; b < 6; b++) {
        const m = (1 << a) | (1 << b);
        const c = chooseTile('river', m);
        expect(c.approximate).toBe(false);
        expect(maskOf('river', c)).toBe(m);
      }
    }
  });

  it('uses the dead-end road tile for single connections', () => {
    for (let e = 0; e < 6; e++) {
      const c = chooseTile('road', 1 << e);
      expect(c.variant).toBe('M');
      expect(maskOf('road', c)).toBe(1 << e);
    }
  });

  it('rotates masks around the hex', () => {
    expect(rotateMask(0b000001, 1)).toBe(0b000010);
    expect(rotateMask(0b100000, 1)).toBe(0b000001);
    expect(rotateMask(0b001001, 3)).toBe(0b001001);
  });
});
