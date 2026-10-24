/**
 * Pathfinding over the hex map with distance fields.
 *
 * One reverse Dijkstra from a goal hex gives every cell its travel cost to
 * that goal, so a whole group ordered to the same place shares a single
 * search, and each unit just walks downhill. The map is ~650 cells, so a
 * field costs well under a millisecond. Fields are cached per goal.
 */
import { distance, key, neighbors, toWorld, fromWorld, line, type Hex } from '../hex';
import type { Cell, RealmMap } from '../map/types';
import { moveCost } from '../map/realm';

export interface Field {
  goal: Hex;
  goalKey: string;
  /** Travel cost from each cell (by key) to the goal. Missing = unreachable. */
  cost: Map<string, number>;
}

export class Grid {
  readonly cells = new Map<string, Cell>();
  private readonly costs = new Map<string, number>();
  constructor(readonly realm: RealmMap) {
    for (const c of realm.cells) {
      this.cells.set(key(c), c);
      this.costs.set(key(c), moveCost(c));
    }
  }
  cost(h: Hex): number {
    return this.costs.get(key(h)) ?? Infinity;
  }
  passable(h: Hex): boolean {
    return this.cost(h) < Infinity;
  }
  passableAt(x: number, z: number): boolean {
    return this.passable(fromWorld(x, z));
  }
  /** Step cost between neighbouring cells: tile width (2) times the mean terrain cost. */
  stepCost(a: Hex, b: Hex): number {
    return ((this.cost(a) + this.cost(b)) / 2) * 2;
  }
  /** Nearest passable cell to a hex (itself if passable), preferring the closer one. */
  nearestPassable(h: Hex, maxRing = 6): Hex | null {
    if (this.passable(h)) return h;
    let best: Hex | null = null;
    let bd = Infinity;
    for (const c of this.cells.values()) {
      if (!this.passable(c)) continue;
      const d = distance(c, h);
      if (d <= maxRing && (d < bd || (d === bd && best && (c.q < best.q || (c.q === best.q && c.r < best.r))))) {
        bd = d;
        best = c;
      }
    }
    return best ? { q: best.q, r: best.r } : null;
  }
  /** True if the straight world-space segment from a to b stays on passable ground (sampled every 0.2 units). */
  clearSegment(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 0.2));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.passableAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
  /** True if every cell on the hex line from a to b is passable. */
  clearLine(a: Hex, b: Hex): boolean {
    return line(a, b).every((h) => this.passable(h));
  }
}

/** Binary min-heap keyed by number, with stable tie-breaking by insertion order. */
class Heap<T> {
  private items: { k: number; s: number; v: T }[] = [];
  private seq = 0;
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, s: this.seq++, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(a[i]!, a[p]!)) {
        [a[i], a[p]] = [a[p]!, a[i]!];
        i = p;
      } else break;
    }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
  private less(x: { k: number; s: number }, y: { k: number; s: number }) {
    return x.k < y.k || (x.k === y.k && x.s < y.s);
  }
}

export function buildField(grid: Grid, goal: Hex): Field {
  const cost = new Map<string, number>();
  const gk = key(goal);
  if (!grid.passable(goal)) return { goal, goalKey: gk, cost };
  cost.set(gk, 0);
  const heap = new Heap<Hex>();
  heap.push(0, goal);
  while (heap.size) {
    const { k, v } = heap.pop()!;
    if (k > (cost.get(key(v)) ?? Infinity)) continue;
    for (const n of neighbors(v)) {
      if (!grid.passable(n)) continue;
      const nk = key(n);
      const c = k + grid.stepCost(v, n);
      if (c < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, c);
        heap.push(c, n);
      }
    }
  }
  return { goal, goalKey: gk, cost };
}

/** The neighbour to step to from `h` toward the field's goal (deterministic tie-break), or null at the goal / unreachable. */
export function downhill(field: Field, h: Hex): Hex | null {
  const here = field.cost.get(key(h));
  if (here === undefined || here === 0) return null;
  let best: Hex | null = null;
  let bc = here;
  for (const n of neighbors(h)) {
    const c = field.cost.get(key(n));
    if (c !== undefined && c < bc - 1e-9) {
      bc = c;
      best = n;
    }
  }
  return best;
}

/** Cell chain from `start` down to the goal. Empty if unreachable. */
export function chain(field: Field, start: Hex, limit = 200): Hex[] {
  if (!field.cost.has(key(start))) return [];
  const out: Hex[] = [start];
  let h: Hex | null = start;
  while ((h = downhill(field, h!)) && out.length < limit) out.push(h);
  return out;
}

/**
 * The furthest cell along the chain (up to `look` steps ahead) reachable in a
 * straight line through passable, not-more-expensive ground. Steering at it
 * turns hex zig-zags into natural diagonal walks.
 */
export function lookahead(grid: Grid, field: Field, from: Hex, look = 4, pos?: { x: number; z: number }): Hex | null {
  const c = chain(field, from, look + 1);
  if (c.length < 2) return null;
  const maxCost = grid.cost(from);
  let pick = c[1]!;
  for (let i = 2; i < c.length; i++) {
    const cand = c[i]!;
    const ok = line(from, cand).every((h) => grid.passable(h) && grid.cost(h) <= Math.max(maxCost, grid.cost(cand), 1));
    // From the unit's actual position, not just the cell centre, so it never clips a blocked corner.
    const w = toWorld(cand);
    if (ok && (!pos || grid.clearSegment(pos.x, pos.z, w.x, w.z))) pick = cand;
    else break;
  }
  return pick;
}

/** LRU cache of fields, keyed by goal hex. */
export class FieldCache {
  private map = new Map<string, Field>();
  constructor(private grid: Grid, private capacity = 24) {}
  get(goal: Hex): Field | undefined {
    const k = key(goal);
    const f = this.map.get(k);
    if (f) {
      this.map.delete(k);
      this.map.set(k, f);
    }
    return f;
  }
  build(goal: Hex): Field {
    const f = buildField(this.grid, goal);
    this.map.set(f.goalKey, f);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
    return f;
  }
  get size() {
    return this.map.size;
  }
}

export const centre = (h: Hex) => toWorld(h);
