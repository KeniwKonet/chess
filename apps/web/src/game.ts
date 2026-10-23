/**
 * The client's view of the match. For milestone 1 this is the static starting
 * state of the Ashen Divide scenario, built by game-core. Nothing here ticks:
 * hit points, ownership and resources are the scenario's starting values.
 */
import { buildRealm, fromWorld, key, toWorld, type Building, type Cell } from '@cr/game-core';

export const realm = buildRealm();
export const cellByKey = new Map<string, Cell>(realm.cells.map((c) => [key(c), c]));
export const buildingById = new Map<string, Building>(realm.buildings.map((b) => [b.id, b]));

const SIDE_COLOUR = { sun: 'yellow', moon: 'blue', neutral: 'yellow' } as const;

/** Model key and approximate height (for picking and label placement) per building. */
export function buildingModel(b: Building): { model: string; height: number; radius: number } {
  const c = SIDE_COLOUR[b.side];
  const s = b.scale;
  switch (b.type) {
    case 'castle': return { model: `building_castle_${c}`, height: 4 * s, radius: 0.95 * s };
    case 'barracks': return { model: `building_barracks_${c}`, height: 1.7, radius: 0.8 };
    case 'archery': return { model: `building_archeryrange_${c}`, height: 1.3, radius: 0.85 };
    // No stables model in the CC0 pack: the tavern stands in (see docs/ASSETS.md).
    case 'stable': return { model: `building_tavern_${c}`, height: 1.5, radius: 0.8 };
    case 'farm': return { model: `building_windmill_${c}`, height: 1.9, radius: 0.7 };
    case 'mine': return { model: `building_mine_${c}`, height: 1.2, radius: 0.85 };
    case 'lumber': return { model: `building_lumbermill_${c}`, height: 1.4, radius: 0.85 };
    case 'forge': return { model: `building_blacksmith_${c}`, height: 1.5, radius: 0.85 };
    case 'workshop': return { model: `building_tower_catapult_${c}`, height: 2.2, radius: 0.7 };
    case 'tower': return { model: `building_tower_A_${c}`, height: 2.3, radius: 0.6 };
    case 'watchtower': return { model: `building_tower_B_${c}`, height: 2.6, radius: 0.6 };
    case 'village': return { model: `building_watermill_${c}`, height: 1.5, radius: 0.85 };
    case 'home': return { model: b.id.endsWith('2') ? `building_home_B_${c}` : `building_home_A_${c}`, height: 1.3, radius: 0.75 };
    case 'market': return { model: `building_market_${c}`, height: 1.3, radius: 0.85 };
    case 'site': return { model: 'building_scaffolding', height: 1.4, radius: 0.8 };
    case 'rubble': return { model: 'building_destroyed', height: 0.6, radius: 0.85 };
  }
}

export const TYPE_LABEL: Record<Building['type'], string> = {
  castle: 'Headquarters', barracks: 'Barracks', archery: 'Archery range', stable: 'Stables', farm: 'Farmstead',
  mine: 'Mine', lumber: 'Lumber mill', forge: 'Forge', workshop: 'Siege workshop', tower: 'Watchtower',
  watchtower: 'Watchtower (capture point)', village: 'Village (capture point)', home: 'Homes', market: 'Market',
  site: 'Construction site', rubble: 'Ruin',
};

export const TERRAIN_LABEL: Record<Cell['terrain'], string> = {
  grass: 'Open grass', forest: 'Forest', hill: 'Hills', mountain: 'Mountains', field: 'Wheat field', water: 'Water',
};

/** What a ray hits: the nearest building (as a vertical cylinder) or the ground tile. */
export type Pick = { kind: 'building'; id: string } | { kind: 'cell'; key: string } | null;

export function pick(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): Pick {
  let bestT = Infinity;
  let best: string | null = null;
  for (const b of realm.buildings) {
    const { height, radius } = buildingModel(b);
    const c = toWorld(b);
    // Ray vs vertical cylinder in xz, then check the height range.
    const ox = o.x - c.x;
    const oz = o.z - c.z;
    const A = d.x * d.x + d.z * d.z;
    const B = 2 * (ox * d.x + oz * d.z);
    const C = ox * ox + oz * oz - radius * radius;
    const disc = B * B - 4 * A * C;
    if (A < 1e-9 || disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
      const y = o.y + d.y * t;
      if (t > 0 && y >= 0 && y <= height && t < bestT) {
        bestT = t;
        best = b.id;
      }
    }
    // Ray entering through the roof.
    if (d.y < 0) {
      const t = (height - o.y) / d.y;
      const x = o.x + d.x * t - c.x;
      const z = o.z + d.z * t - c.z;
      if (t > 0 && x * x + z * z <= radius * radius && t < bestT) {
        bestT = t;
        best = b.id;
      }
    }
  }
  // Ground at tile height 0.
  const tg = d.y < 0 ? -o.y / d.y : Infinity;
  if (best && bestT <= tg + 0.01) return { kind: 'building', id: best };
  if (!Number.isFinite(tg)) return null;
  const h = fromWorld(o.x + d.x * tg, o.z + d.z * tg);
  const cell = cellByKey.get(key(h));
  if (!cell) return null;
  if (cell.building) return { kind: 'building', id: cell.building };
  return { kind: 'cell', key: key(cell) };
}

/** Nearest named place, for describing where something is. */
export function nearestPlace(q: number, r: number): string {
  let best = realm.places[0]!;
  let bd = Infinity;
  for (const p of realm.places) {
    const d = (Math.abs(p.q - q) + Math.abs(p.r - r) + Math.abs(p.q + p.r - q - r)) / 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return bd === 0 ? best.name : `near ${best.name}`;
}
