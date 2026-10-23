import { describe, expect, it } from 'vitest';
import { DIRS, distance, edgeToward, fromOffset, fromWorld, line, neighbor, toOffset, toWorld, key } from '../src/hex';

describe('hex grid', () => {
  it('round-trips world coordinates for every cell of the map area', () => {
    for (let row = -2; row < 25; row++) {
      for (let col = -2; col < 35; col++) {
        const h = fromOffset(col, row);
        const w = toWorld(h);
        expect(fromWorld(w.x, w.z)).toEqual(h);
        expect(toOffset(h)).toEqual({ col, row });
      }
    }
  });

  it('places neighbours one tile width (2 units) away, at the edge angle', () => {
    const o = { q: 3, r: 4 };
    const c = toWorld(o);
    DIRS.forEach((_, e) => {
      const n = toWorld(neighbor(o, e));
      const dx = n.x - c.x;
      const dz = n.z - c.z;
      expect(Math.hypot(dx, dz)).toBeCloseTo(2, 6);
      const ang = (Math.atan2(dz, dx) * 180) / Math.PI;
      expect(((ang % 360) + 360) % 360).toBeCloseTo(e * 60, 6);
    });
  });

  it('maps points inside a tile back to that tile', () => {
    const h = { q: 5, r: 2 };
    const c = toWorld(h);
    for (let a = 0; a < 360; a += 15) {
      const rad = (a * Math.PI) / 180;
      expect(fromWorld(c.x + Math.cos(rad) * 0.95, c.z + Math.sin(rad) * 0.95)).toEqual(h);
    }
  });

  it('draws connected lines with the right length', () => {
    const a = { q: 0, r: 0 };
    const b = { q: 7, r: -3 };
    const l = line(a, b);
    expect(l.length).toBe(distance(a, b) + 1);
    for (let i = 1; i < l.length; i++) expect(edgeToward(l[i - 1]!, l[i]!)).toBeGreaterThanOrEqual(0);
    expect(new Set(l.map(key)).size).toBe(l.length);
  });
});
