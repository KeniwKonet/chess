/**
 * Auto-tiling for river and road hexes.
 *
 * The KayKit pack ships one tile per connection pattern (A..M). The table
 * below was measured from the tile meshes themselves (tools/edges.py samples
 * the texture colour at each of the six edge midpoints), so it describes what
 * the art actually contains rather than what the file names suggest.
 *
 * A pattern is a 6-bit mask: bit e set means the tile connects across edge e.
 * Rotating a tile by k steps maps edge e to edge (e + k) mod 6; in three.js
 * that is rotation.y = -k * PI / 3 (see rotationForSteps).
 */
export type LinearKind = 'river' | 'road';

const BASE: Record<string, number[]> = {
  A: [0, 3],
  B: [3, 5],
  C: [3, 4],
  D: [1, 3, 5],
  E: [0, 3, 5],
  F: [0, 1, 3],
  G: [2, 3, 4],
  H: [0, 2, 3, 4],
  I: [1, 2, 4, 5],
  J: [0, 1, 2, 3],
  K: [1, 2, 3, 4, 5],
  L: [0, 1, 2, 3, 4, 5],
};
/** Road-only dead end (a road that stops at a building). */
const ROAD_ONLY: Record<string, number[]> = { M: [3] };

const toMask = (edges: number[]) => edges.reduce((m, e) => m | (1 << e), 0);
export const rotateMask = (mask: number, k: number): number => {
  let out = 0;
  for (let e = 0; e < 6; e++) if (mask & (1 << e)) out |= 1 << ((e + k) % 6);
  return out;
};
export const popcount = (m: number) => {
  let c = 0;
  for (let e = 0; e < 6; e++) if (m & (1 << e)) c++;
  return c;
};

export interface TileChoice {
  /** Variant letter, e.g. 'B'. */
  variant: string;
  /** Rotation steps (multiples of 60 degrees). */
  steps: number;
  /** True when the mask had no exact match and the closest pattern was used. */
  approximate: boolean;
}

function table(kind: LinearKind): Map<number, { variant: string; steps: number }> {
  const out = new Map<number, { variant: string; steps: number }>();
  const src = kind === 'road' ? { ...BASE, ...ROAD_ONLY } : BASE;
  for (const [variant, edges] of Object.entries(src)) {
    const base = toMask(edges);
    for (let k = 0; k < 6; k++) {
      const m = rotateMask(base, k);
      if (!out.has(m)) out.set(m, { variant, steps: k });
    }
  }
  return out;
}
const TABLES: Record<LinearKind, Map<number, { variant: string; steps: number }>> = {
  river: table('river'),
  road: table('road'),
};

/** Pick the tile variant and rotation for a connection mask. */
export function chooseTile(kind: LinearKind, mask: number): TileChoice {
  const exact = TABLES[kind].get(mask);
  if (exact) return { ...exact, approximate: false };
  // Rivers have no dead-end tile: extend a single connection straight through.
  if (popcount(mask) <= 1) {
    const e = mask ? Math.log2(mask & -mask) : 0;
    const m = (1 << e) | (1 << ((e + 3) % 6));
    return { ...TABLES[kind].get(m)!, approximate: true };
  }
  // Otherwise the pattern with the most shared edges and fewest extras.
  let best: { variant: string; steps: number } | undefined;
  let bestScore = -Infinity;
  for (const [m, choice] of TABLES[kind]) {
    const score = popcount(m & mask) * 2 - popcount(m ^ mask);
    if (score > bestScore) {
      bestScore = score;
      best = choice;
    }
  }
  return { ...best!, approximate: true };
}

/** three.js y-rotation for a number of 60 degree steps. */
export const rotationForSteps = (steps: number) => (-steps * Math.PI) / 3;

/** The connection mask a choice actually draws, for verification. */
export function maskOf(kind: LinearKind, choice: TileChoice): number {
  const src = kind === 'road' ? { ...BASE, ...ROAD_ONLY } : BASE;
  return rotateMask(toMask(src[choice.variant]!), choice.steps);
}
