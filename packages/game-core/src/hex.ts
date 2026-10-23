/**
 * Pointy-top hex grid in axial coordinates (q, r).
 *
 * World units match the KayKit hex tiles: a tile is 2 units across its flat
 * sides (apothem 1) and 2.309 units from point to point. World x runs east,
 * world z runs south, y is up.
 *
 * Edge index e (0..5) is the edge whose midpoint sits at angle e * 60 degrees
 * in the x/z plane: 0 = east, 1 = south-east, 2 = south-west, 3 = west,
 * 4 = north-west, 5 = north-east. The neighbour across edge e is DIRS[e].
 */
export interface Hex {
  q: number;
  r: number;
}

export const SQRT3 = Math.sqrt(3);
/** Distance from tile centre to an edge midpoint. */
export const APOTHEM = 1;
/** Distance from tile centre to a corner. */
export const CIRCUMRADIUS = 2 / SQRT3;

export const DIRS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
];

export const key = (h: Hex): string => `${h.q},${h.r}`;
export const add = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });
export const neighbor = (h: Hex, e: number): Hex => add(h, DIRS[((e % 6) + 6) % 6]!);
export const neighbors = (h: Hex): Hex[] => DIRS.map((d) => add(h, d));

export function distance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Centre of a hex in world units. */
export function toWorld(h: Hex): { x: number; z: number } {
  return { x: 2 * APOTHEM * (h.q + h.r / 2), z: SQRT3 * APOTHEM * h.r };
}

/** Round fractional axial coordinates to the containing hex. */
export function round(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // Normalise -0 so keys and equality stay stable.
  return { q: rq + 0, r: rr + 0 };
}

/** The hex containing a world-space point. */
export function fromWorld(x: number, z: number): Hex {
  const r = z / (SQRT3 * APOTHEM);
  const q = x / (2 * APOTHEM) - r / 2;
  return round(q, r);
}

/** Offset "odd-r" (col,row) to axial, used only for authoring the map. */
export function fromOffset(col: number, row: number): Hex {
  return { q: col - (row - (row & 1)) / 2, r: row };
}
export function toOffset(h: Hex): { col: number; row: number } {
  return { col: h.q + (h.r - (h.r & 1)) / 2, row: h.r };
}

/** Every hex on the straight line from a to b, inclusive, each a neighbour of the last. */
export function line(a: Hex, b: Hex): Hex[] {
  const n = distance(a, b);
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    // Nudge avoids ties landing exactly on an edge.
    out.push(round(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}

/** The edge of `from` that faces the neighbouring hex `to`, or -1 if not adjacent. */
export function edgeToward(from: Hex, to: Hex): number {
  for (let e = 0; e < 6; e++) {
    const d = DIRS[e]!;
    if (from.q + d.q === to.q && from.r + d.r === to.r) return e;
  }
  return -1;
}
