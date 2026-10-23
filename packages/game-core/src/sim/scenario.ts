/**
 * Starting armies for the Ashen Divide (milestone 2): a company of infantry
 * and one of archers per side near their barracks and ranges, plus a Moon
 * patrol in the Vey hills driven by the patrol AI.
 */
import { toWorld } from '../hex';
import { px } from '../map/realm';
import type { RealmMap, Side } from '../map/types';
import type { UnitSpawn, UnitType } from './sim';

function block(side: Side, type: UnitType, at: { x: number; z: number }, n: number, facing: number): UnitSpawn[] {
  const cols = Math.ceil(Math.sqrt(n * 1.6));
  const out: UnitSpawn[] = [];
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const lat = (col - (Math.min(cols, n - row * cols) - 1) / 2) * 0.78;
    out.push({ side, type, x: at.x - fz * lat - fx * row * 0.78, z: at.z + fx * lat - fz * row * 0.78, facing });
  }
  return out;
}

const EAST = Math.PI / 2;
const WEST = -Math.PI / 2;

export const PATROL_SIZE = 3;

export function startingArmies(realm: RealmMap): UnitSpawn[] {
  const at = (X: number, Y: number) => {
    const h = px(X, Y);
    return toWorld(h);
  };
  void realm;
  return [
    ...block('sun', 'infantry', at(980, 980), 8, EAST),
    ...block('sun', 'archer', at(880, 1180), 6, EAST),
    ...block('moon', 'infantry', at(2300, 1040), 8, WEST),
    ...block('moon', 'archer', at(2380, 860), 6, WEST),
    // Patrol last, so its ids follow the companies.
    ...block('moon', 'infantry', at(1960, 900), PATROL_SIZE, WEST),
  ];
}

/** Waypoints for the Moon patrol: Vey hills down to Ashgrove's edge and back. */
export function patrolRoute(): { x: number; z: number }[] {
  return [px(1960, 900), px(2060, 1500)].map(toWorld);
}
