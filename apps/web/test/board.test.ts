import { describe, expect, it } from 'vitest';
import { isLight } from '../src/kingdom/board';

describe('board colours', () => {
  it('has a dark square at each player’s bottom-left (a1, h8) and puts each queen on her own colour', () => {
    expect(isLight('a1')).toBe(false);
    expect(isLight('h1')).toBe(true);
    expect(isLight('a8')).toBe(true);
    expect(isLight('h8')).toBe(false);
    expect(isLight('d1')).toBe(true); // white queen on a light square
    expect(isLight('d8')).toBe(false); // black queen on a dark square
    expect(isLight('e1')).toBe(false);
    expect(isLight('e8')).toBe(true);
  });
});
