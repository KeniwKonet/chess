/**
 * The first battlefield: "The Ashen Divide".
 *
 * Built deterministically from the same layout as the v2 design prototype
 * (3200 x 2000 px world). Positions are authored in that pixel space and
 * converted to hexes, so names and geography carry over: Sunspire in the
 * west, Nocturne in the east, a river between them with the North Bridge,
 * the Ford of Ash and the South Bridge, Vey Watchtower on the east bank
 * hills and the Old Mill on the west bank.
 */
import {
  type Hex,
  DIRS,
  distance,
  edgeToward,
  fromOffset,
  fromWorld,
  key,
  line,
  neighbor,
  neighbors,
  toWorld,
} from '../hex';
import { chooseTile } from '../autotile';
import { hash2 } from '../rng';
import type { Building, BuildingType, CapturePoint, Cell, Owner, Place, Prop, RealmMap, Side } from './types';

export const COLS = 32;
export const ROWS = 22;
const DEFAULT_SEED = 7;

/** v2 prototype pixel coordinates to a hex. */
export const px = (X: number, Y: number): Hex => fromWorld(X / 50, Y / 55);

interface BuildingSpec {
  id: string;
  side: Owner;
  type: BuildingType;
  name: string;
  at: [number, number];
  hp: number;
  maxHp?: number;
  scale?: number;
  progress?: number;
  capture?: string;
}

/** Same roster as the v2 prototype (Battlefield.dc.html), plus a few homes and markets for life. */
export const BUILDINGS: BuildingSpec[] = [
  { id: 'sun_castle', side: 'sun', type: 'castle', name: 'Sunspire Castle', at: [380, 1000], hp: 2400, scale: 1.55 },
  { id: 'sun_bar', side: 'sun', type: 'barracks', name: 'Barracks', at: [760, 880], hp: 700 },
  { id: 'sun_arc', side: 'sun', type: 'archery', name: 'Archery Range', at: [760, 1150], hp: 600 },
  { id: 'sun_stb', side: 'sun', type: 'stable', name: 'Stables', at: [610, 1380], hp: 600 },
  { id: 'sun_farm', side: 'sun', type: 'farm', name: 'Sun Farmstead', at: [420, 1520], hp: 300 },
  { id: 'sun_mine', side: 'sun', type: 'mine', name: 'Gilded Mine', at: [300, 560], hp: 600 },
  { id: 'sun_lum', side: 'sun', type: 'lumber', name: 'Lumber Mill', at: [700, 420], hp: 500 },
  { id: 'sun_forge', side: 'sun', type: 'forge', name: 'Iron Forge', at: [900, 620], hp: 600 },
  { id: 'sun_ws', side: 'sun', type: 'workshop', name: 'Siege Workshop', at: [920, 1320], hp: 600 },
  { id: 'sun_t1', side: 'sun', type: 'tower', name: 'North Watchtower', at: [1080, 760], hp: 220, maxHp: 500 },
  { id: 'sun_t2', side: 'sun', type: 'tower', name: 'South Watchtower', at: [1080, 1260], hp: 500 },
  { id: 'sun_pal', side: 'sun', type: 'site', name: 'Ford Palisade', at: [1360, 950], hp: 520, maxHp: 700, progress: 38 },
  { id: 'sun_home1', side: 'sun', type: 'home', name: 'Sunspire Homes', at: [560, 760], hp: 200 },
  { id: 'sun_home2', side: 'sun', type: 'home', name: 'Sunspire Homes', at: [240, 1240], hp: 200 },
  { id: 'sun_mkt', side: 'sun', type: 'market', name: 'Sunspire Market', at: [560, 1100], hp: 300 },

  { id: 'moon_castle', side: 'moon', type: 'castle', name: 'Nocturne Castle', at: [2820, 1000], hp: 2400, scale: 1.55 },
  { id: 'moon_bar', side: 'moon', type: 'barracks', name: 'Barracks', at: [2480, 1160], hp: 700 },
  { id: 'moon_arc', side: 'moon', type: 'archery', name: 'Archery Range', at: [2480, 840], hp: 600 },
  { id: 'moon_stb', side: 'moon', type: 'stable', name: 'Stables', at: [2640, 620], hp: 600 },
  { id: 'moon_farm', side: 'moon', type: 'farm', name: 'Moon Farmstead', at: [2800, 500], hp: 300 },
  { id: 'moon_mine', side: 'moon', type: 'mine', name: 'Silver Mine', at: [2900, 1500], hp: 600 },
  { id: 'moon_lum', side: 'moon', type: 'lumber', name: 'Lumber Mill', at: [2600, 1680], hp: 500 },
  { id: 'moon_forge', side: 'moon', type: 'forge', name: 'Iron Forge', at: [2380, 1420], hp: 600 },
  { id: 'moon_ws', side: 'moon', type: 'workshop', name: 'Siege Workshop', at: [2340, 660], hp: 600 },
  { id: 'moon_t1', side: 'moon', type: 'tower', name: 'Moon North Tower', at: [2160, 760], hp: 500 },
  { id: 'moon_t2', side: 'moon', type: 'tower', name: 'Moon South Tower', at: [2160, 1260], hp: 180, maxHp: 500 },
  { id: 'moon_out', side: 'moon', type: 'rubble', name: 'Ruined Moon Outpost', at: [2000, 1330], hp: 0, maxHp: 400 },
  { id: 'moon_home1', side: 'moon', type: 'home', name: 'Nocturne Homes', at: [3020, 800], hp: 200 },
  { id: 'moon_home2', side: 'moon', type: 'home', name: 'Nocturne Homes', at: [3000, 1240], hp: 200 },
  { id: 'moon_mkt', side: 'moon', type: 'market', name: 'Nocturne Market', at: [2640, 1100], hp: 300 },

  { id: 'vey', side: 'moon', type: 'watchtower', name: 'Vey Watchtower', at: [1880, 680], hp: 800, capture: 'vey' },
  { id: 'mill', side: 'sun', type: 'village', name: 'Old Mill', at: [1400, 1560], hp: 600, capture: 'mill' },
];

const CROSSINGS = {
  north: { name: 'the North Bridge', at: [1525, 600] as [number, number], kind: 'bridge' as const },
  ford: { name: 'the Ford of Ash', at: [1590, 1050] as [number, number], kind: 'ford' as const },
  south: { name: 'the South Bridge', at: [1665, 1450] as [number, number], kind: 'bridge' as const },
};

/** River runs north to south; at each crossing it is forced straight along edges 4 -> 1 so bridges sit square. */
const RIVER_AXIS_IN = 4;
const RIVER_AXIS_OUT = 1;
/** Roads cross west to east. */
const ROAD_IN = 3;
const ROAD_OUT = 0;

function isLand(col: number, row: number, seed: number): boolean {
  const h = fromOffset(col, row);
  const w = toWorld(h);
  const cx = (COLS - 0.5) ; // world x centre (cols are 2 units wide)
  const cz = ((ROWS - 1) * Math.sqrt(3)) / 2;
  const nx = (w.x - cx) / (COLS + 0.2);
  const nz = (w.z - cz) / (cz + 1.2);
  const d = Math.abs(nx) ** 6 + Math.abs(nz) ** 6;
  const jitter = hash2(col, row, seed) * 0.32;
  return d < 0.66 + jitter;
}

/** Concatenate hex lines between waypoints, without repeating joints. */
function path(points: Hex[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = line(points[i]!, points[i + 1]!);
    for (const h of seg) {
      const last = out[out.length - 1];
      if (!last || last.q !== h.q || last.r !== h.r) out.push(h);
    }
  }
  return out;
}

const crossingWaypoints = (c: Hex, inE: number, outE: number): Hex[] => [neighbor(c, inE), c, neighbor(c, outE)];

export function buildRealm(seed = DEFAULT_SEED): RealmMap {
  const cells = new Map<string, Cell>();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!isLand(col, row, seed)) continue;
      const h = fromOffset(col, row);
      cells.set(key(h), { ...h, terrain: 'grass', river: false, road: false, bridge: false, ford: false, props: [] });
    }
  }
  const get = (h: Hex) => cells.get(key(h));

  // Masks are built from path order, not from neighbour presence, so two
  // channels that merely touch do not fuse into a junction.
  const riverMask = new Map<string, number>();
  const roadMask = new Map<string, number>();
  const link = (masks: Map<string, number>, seq: Hex[]) => {
    for (let i = 0; i < seq.length; i++) {
      const h = seq[i]!;
      let m = masks.get(key(h)) ?? 0;
      const prev = seq[i - 1];
      const next = seq[i + 1];
      if (prev) m |= 1 << edgeToward(h, prev);
      if (next) m |= 1 << edgeToward(h, next);
      masks.set(key(h), m);
    }
  };

  // --- River -------------------------------------------------------------
  const cN = px(...CROSSINGS.north.at);
  const cF = px(...CROSSINGS.ford.at);
  const cS = px(...CROSSINGS.south.at);
  const river = path([
    px(1440, -120),
    ...crossingWaypoints(cN, RIVER_AXIS_IN, RIVER_AXIS_OUT),
    ...crossingWaypoints(cF, RIVER_AXIS_IN, RIVER_AXIS_OUT),
    ...crossingWaypoints(cS, RIVER_AXIS_IN, RIVER_AXIS_OUT),
    px(1780, 2140),
  ]);
  link(riverMask, river);
  for (const h of river) {
    const c = get(h);
    if (c) c.river = true;
  }
  get(cN)!.bridge = true;
  get(cS)!.bridge = true;
  get(cF)!.ford = true;
  for (const c of [cN, cS, cF]) get(c)!.crossEdge = ROAD_OUT;

  // --- Buildings (castles first so roads can end at them) ----------------
  const buildings: Building[] = [];
  const occupied = new Set<string>();
  const placeAt = (spec: BuildingSpec) => {
    const target = px(...spec.at);
    const ok = (c: Cell | undefined) => !!c && !c.river && !c.road && !occupied.has(key(c));
    let best: Cell | undefined;
    if (spec.type === 'village') {
      // The mill wants to sit on the riverbank.
      best = [...cells.values()]
        .filter((c) => ok(c) && neighbors(c).some((n) => get(n)?.river))
        .sort((a, b) => distance(a, target) - distance(b, target))[0];
    } else {
      best = [...cells.values()].filter(ok).sort((a, b) => distance(a, target) - distance(b, target) || a.q - b.q)[0];
    }
    if (!best) throw new Error(`No room for ${spec.id}`);
    occupied.add(key(best));
    best.building = spec.id;
    const b: Building = {
      id: spec.id,
      side: spec.side,
      type: spec.type,
      name: spec.name,
      q: best.q,
      r: best.r,
      scale: spec.scale ?? 1,
      rotY: 0,
      maxHp: spec.maxHp ?? spec.hp,
      hp: spec.hp,
      ...(spec.progress !== undefined ? { progress: spec.progress } : {}),
      ...(spec.capture ? { capture: spec.capture } : {}),
    };
    buildings.push(b);
    return b;
  };
  const castles: Record<Side, Building> = {
    sun: placeAt(BUILDINGS.find((b) => b.id === 'sun_castle')!),
    moon: placeAt(BUILDINGS.find((b) => b.id === 'moon_castle')!),
  };
  for (const side of ['sun', 'moon'] as const) {
    for (const n of neighbors(castles[side])) {
      const c = get(n);
      if (c) c.grounds = side;
    }
  }

  // --- Roads -------------------------------------------------------------
  const S: Hex = castles.sun;
  const M: Hex = castles.moon;
  const roads: Hex[][] = [
    path([S, px(760, 1010), px(1180, 1000), ...crossingWaypoints(cF, ROAD_IN, ROAD_OUT), px(2000, 1060), px(2450, 1000), M]),
    path([S, px(640, 800), px(1060, 650), ...crossingWaypoints(cN, ROAD_IN, ROAD_OUT), px(1960, 760), px(2300, 860), M]),
    path([S, px(640, 1200), px(1020, 1400), px(1380, 1450), ...crossingWaypoints(cS, ROAD_IN, ROAD_OUT), px(2060, 1380), px(2420, 1160), M]),
  ];
  for (const seq of roads) {
    // Roads stop at the castle gate: drop the castle cells themselves.
    const inner = seq.filter((h) => !(h.q === S.q && h.r === S.r) && !(h.q === M.q && h.r === M.r));
    // Keep the edge that points into the castle by linking the full sequence.
    link(roadMask, seq);
    for (const h of inner) {
      const c = get(h);
      if (c && !c.river) c.road = true;
    }
  }

  // --- Remaining buildings ----------------------------------------------
  for (const spec of BUILDINGS) {
    if (spec.type === 'castle') continue;
    placeAt(spec);
  }

  // Face each building toward the nearest road or castle so doors read.
  for (const b of buildings) {
    let bestEdge = -1;
    let bestD = Infinity;
    for (let e = 0; e < 6; e++) {
      for (let k = 1; k <= 4; k++) {
        let h: Hex = b;
        for (let s = 0; s < k; s++) h = neighbor(h, e);
        const c = get(h);
        if (c?.road && k < bestD) {
          bestD = k;
          bestEdge = e;
        }
      }
    }
    if (bestEdge < 0) bestEdge = 3;
    // Models face +z (angle 90 degrees); rotate so the front points along edge e.
    b.rotY = Math.PI / 2 - (bestEdge * Math.PI) / 3;
  }

  // --- Fields around farms ----------------------------------------------
  for (const b of buildings.filter((x) => x.type === 'farm')) {
    let n = 0;
    for (const h of neighbors(b)) {
      const c = get(h);
      if (c && !c.river && !c.road && !c.building && !c.grounds && n < 4) {
        c.terrain = 'field';
        n++;
      }
    }
  }

  // --- Terrain features ---------------------------------------------------
  const nearThings = (c: Cell, r: number) =>
    buildings.some((b) => distance(b, c) <= r) || (c.grounds !== undefined);
  const free = (c: Cell) => !c.river && !c.road && !c.building && c.terrain === 'grass' && !c.grounds;
  const regions: { at: [number, number]; r: number; terrain: 'forest' | 'mountain' | 'hill'; density: number }[] = [
    { at: [600, 200], r: 4, terrain: 'forest', density: 0.9 }, // the Western Wood
    { at: [2050, 1750], r: 3, terrain: 'forest', density: 0.85 }, // Ashgrove
    { at: [2700, 1800], r: 2, terrain: 'forest', density: 0.7 },
    { at: [1150, 1750], r: 2, terrain: 'forest', density: 0.6 },
    { at: [1250, 300], r: 2, terrain: 'forest', density: 0.6 },
    { at: [2450, 300], r: 3, terrain: 'forest', density: 0.65 },
    { at: [3000, 260], r: 2, terrain: 'mountain', density: 0.75 },
    { at: [160, 420], r: 2, terrain: 'mountain', density: 0.7 },
    { at: [200, 1820], r: 2, terrain: 'mountain', density: 0.7 },
    { at: [3060, 1660], r: 2, terrain: 'mountain', density: 0.7 },
    { at: [1880, 680], r: 2, terrain: 'hill', density: 0.75 }, // Vey hills
    { at: [1000, 1000], r: 1, terrain: 'hill', density: 0.4 },
  ];
  for (const reg of regions) {
    const centre = px(...reg.at);
    for (const c of cells.values()) {
      const d = distance(c, centre);
      if (d > reg.r || !free(c)) continue;
      if (reg.terrain !== 'hill' && nearThings(c, 1)) continue;
      const p = reg.density * (1 - (d / (reg.r + 1)) * 0.5);
      if (hash2(c.q, c.r, seed + 11) < p) c.terrain = reg.terrain;
    }
  }
  // Scattered copses and knolls away from roads and buildings.
  for (const c of cells.values()) {
    if (!free(c) || nearThings(c, 1)) continue;
    const roll = hash2(c.q, c.r, seed + 23);
    if (roll < 0.1) c.terrain = 'forest';
    else if (roll < 0.13) c.terrain = 'hill';
  }

  // --- Props ---------------------------------------------------------------
  const rot = (c: Cell, salt: number) => Math.floor(hash2(c.q, c.r, seed + salt) * 6) * (Math.PI / 3);
  for (const c of cells.values()) {
    const roll = hash2(c.q, c.r, seed + 31);
    const props: Prop[] = [];
    if (c.terrain === 'forest') {
      const big = ['trees_A_large', 'trees_B_large', 'trees_A_medium', 'trees_B_medium'];
      props.push({ model: big[Math.floor(roll * big.length)]!, dx: 0, dz: 0, rotY: rot(c, 1), scale: 1 });
    } else if (c.terrain === 'mountain') {
      const m = ['mountain_A_grass_trees', 'mountain_B_grass_trees', 'mountain_C_grass', 'mountain_A_grass', 'mountain_B'];
      props.push({ model: m[Math.floor(roll * m.length)]!, dx: 0, dz: 0, rotY: rot(c, 2), scale: 1 });
    } else if (c.terrain === 'hill') {
      const hl = ['hills_A_trees', 'hills_B_trees', 'hills_C', 'hills_A', 'hills_B'];
      props.push({ model: hl[Math.floor(roll * hl.length)]!, dx: 0, dz: 0, rotY: rot(c, 3), scale: 1 });
    } else if (c.terrain === 'grass' && !c.building && !c.road && !c.river) {
      const r2 = hash2(c.q, c.r, seed + 41);
      if (c.grounds) {
        // Castle grounds: tidy, a few crates and a flag.
        if (r2 < 0.35) props.push({ model: r2 < 0.18 ? 'barrel' : 'crate_A_big', dx: 0.45, dz: -0.3, rotY: rot(c, 4), scale: 0.9 });
      } else if (r2 < 0.12) {
        const rocks = ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E'];
        props.push({ model: rocks[Math.floor(r2 * 40) % rocks.length]!, dx: (r2 - 0.06) * 6, dz: 0.3, rotY: rot(c, 5), scale: 1 });
      } else if (r2 < 0.3) {
        props.push({ model: r2 < 0.21 ? 'tree_single_A' : 'tree_single_B', dx: 0.4 - r2, dz: -0.35, rotY: rot(c, 6), scale: 1 });
      }
    }
    c.props = props;
  }

  // --- Auto-tile rivers and roads -----------------------------------------
  for (const c of cells.values()) {
    if (c.river) {
      const ch = chooseTile('river', riverMask.get(key(c)) ?? 0);
      c.tile = { kind: 'river', ...ch };
    } else if (c.road) {
      const ch = chooseTile('road', roadMask.get(key(c)) ?? 0);
      c.tile = { kind: 'road', ...ch };
    }
  }

  // --- Places and capture points -----------------------------------------
  const places: Place[] = [
    { id: 'north', name: CROSSINGS.north.name, ...cN, kind: 'crossing' },
    { id: 'ford', name: CROSSINGS.ford.name, ...cF, kind: 'crossing' },
    { id: 'south', name: CROSSINGS.south.name, ...cS, kind: 'crossing' },
    { id: 'sunspire', name: 'Sunspire', q: castles.sun.q, r: castles.sun.r, kind: 'capital' },
    { id: 'nocturne', name: 'Nocturne', q: castles.moon.q, r: castles.moon.r, kind: 'capital' },
    { id: 'western_wood', name: 'the Western Wood', ...px(600, 200), kind: 'region' },
    { id: 'ashgrove', name: 'Ashgrove', ...px(2050, 1750), kind: 'region' },
  ];
  const vey = buildings.find((b) => b.id === 'vey')!;
  const mill = buildings.find((b) => b.id === 'mill')!;
  places.push({ id: 'vey', name: 'Vey Watchtower', q: vey.q, r: vey.r, kind: 'capture' });
  places.push({ id: 'mill', name: 'Old Mill', q: mill.q, r: mill.r, kind: 'capture' });
  const captures: CapturePoint[] = [
    { id: 'vey', name: 'Vey Watchtower', q: vey.q, r: vey.r, radius: 2, owner: 'moon' },
    { id: 'mill', name: 'Old Mill', q: mill.q, r: mill.r, radius: 2, owner: 'sun' },
    { id: 'ford', name: 'Ford of Ash', ...cF, radius: 2, owner: 'neutral' },
  ];

  // --- Bounds ---------------------------------------------------------------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of cells.values()) {
    const w = toWorld(c);
    minX = Math.min(minX, w.x - 1);
    maxX = Math.max(maxX, w.x + 1);
    minZ = Math.min(minZ, w.z - 1.16);
    maxZ = Math.max(maxZ, w.z + 1.16);
  }

  return {
    seed,
    cols: COLS,
    rows: ROWS,
    cells: [...cells.values()],
    buildings,
    places,
    captures,
    bounds: { minX, maxX, minZ, maxZ },
  };
}

/** Terrain movement cost (Infinity = impassable). Used by pathfinding in milestone 2. */
export function moveCost(c: Cell): number {
  if (c.building) return Infinity;
  if (c.river && !c.bridge && !c.ford) return Infinity;
  if (c.terrain === 'mountain' || c.terrain === 'water') return Infinity;
  if (c.ford) return 2.5;
  if (c.road || c.bridge) return 0.7;
  if (c.terrain === 'forest') return 1.8;
  if (c.terrain === 'hill') return 1.5;
  return 1;
}

export { DIRS };
