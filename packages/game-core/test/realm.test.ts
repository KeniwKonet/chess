import { describe, expect, it } from 'vitest';
import { buildRealm, moveCost } from '../src/map/realm';
import { key, neighbors, distance, type Hex } from '../src/hex';
import { maskOf } from '../src/autotile';

const realm = buildRealm();
const byKey = new Map(realm.cells.map((c) => [key(c), c]));

/** Uniform-cost reachability over passable cells, starting beside a building. */
function reachable(from: Hex): Set<string> {
  const seen = new Set<string>();
  const start = neighbors(from).map((h) => byKey.get(key(h))).filter((c) => c && moveCost(c) < Infinity);
  const q = [...start];
  for (const c of q) seen.add(key(c!));
  while (q.length) {
    const c = q.shift()!;
    for (const n of neighbors(c)) {
      const nc = byKey.get(key(n));
      if (!nc || seen.has(key(nc)) || moveCost(nc) === Infinity) continue;
      seen.add(key(nc));
      q.push(nc);
    }
  }
  return seen;
}

describe('the Ashen Divide map', () => {
  it('is deterministic for a seed', () => {
    expect(JSON.stringify(buildRealm(7))).toBe(JSON.stringify(realm));
  });

  it('has two kingdoms with one castle each, far apart', () => {
    const castles = realm.buildings.filter((b) => b.type === 'castle');
    expect(castles.map((c) => c.side).sort()).toEqual(['moon', 'sun']);
    expect(distance(castles[0]!, castles[1]!)).toBeGreaterThan(18);
  });

  it('places every building on its own land tile', () => {
    const seen = new Set<string>();
    for (const b of realm.buildings) {
      const c = byKey.get(key(b));
      expect(c, b.id).toBeDefined();
      expect(c!.building).toBe(b.id);
      expect(c!.river).toBe(false);
      expect(c!.road).toBe(false);
      expect(seen.has(key(b))).toBe(false);
      seen.add(key(b));
    }
  });

  it('crosses the river only at the two bridges and the ford', () => {
    const crossings = realm.cells.filter((c) => c.bridge || c.ford);
    expect(crossings.filter((c) => c.bridge)).toHaveLength(2);
    expect(crossings.filter((c) => c.ford)).toHaveLength(1);
    for (const c of crossings) {
      // Crossings sit on straight river tiles so the bridge model lines up.
      expect(c.tile?.variant).toBe('A');
    }
    expect(realm.cells.some((c) => c.road && c.river)).toBe(false);
  });

  it('connects the two capitals over land, and only through the crossings', () => {
    const sun = realm.buildings.find((b) => b.id === 'sun_castle')!;
    const moon = realm.buildings.find((b) => b.id === 'moon_castle')!;
    const fromSun = reachable(sun);
    expect(neighbors(moon).some((n) => fromSun.has(key(n)))).toBe(true);
    // Remove the crossings: the banks should be cut off from each other.
    for (const c of realm.cells) if (c.bridge || c.ford) c.terrain = 'water';
    const cut = reachable(sun);
    expect(neighbors(moon).some((n) => cut.has(key(n)))).toBe(false);
    for (const c of realm.cells) if (c.bridge || c.ford) c.terrain = 'grass';
  });

  it('draws every river and road tile with an exact art match', () => {
    const tiles = realm.cells.filter((c) => c.tile);
    expect(tiles.length).toBeGreaterThan(40);
    expect(tiles.filter((c) => c.tile!.approximate).map((c) => `${c.tile!.kind}@${key(c)}`)).toEqual([]);
  });

  it('joins road tiles seamlessly: every road edge leads to a road, crossing or castle', () => {
    for (const c of realm.cells.filter((x) => x.tile?.kind === 'road')) {
      const m = maskOf('road', { variant: c.tile!.variant, steps: c.tile!.steps, approximate: false });
      neighbors(c).forEach((n, e) => {
        if (!(m & (1 << e))) return;
        const nc = byKey.get(key(n));
        const ok = !!nc && (nc.road || nc.bridge || nc.ford || realm.buildings.some((b) => b.type === 'castle' && b.q === nc.q && b.r === nc.r));
        expect(ok, `road ${key(c)} edge ${e}`).toBe(true);
      });
    }
  });

  it('keeps the v2 place names', () => {
    const names = realm.places.map((p) => p.name);
    for (const n of ['the North Bridge', 'the Ford of Ash', 'the South Bridge', 'Vey Watchtower', 'Old Mill', 'Sunspire', 'Nocturne']) {
      expect(names).toContain(n);
    }
  });
});
