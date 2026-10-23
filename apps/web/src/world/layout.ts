/**
 * Turns the game-core map into lists of model placements. Pure data, no
 * rendering, so the same layout feeds the instanced renderer and the fallback.
 */
import * as THREE from 'three';
import { key, neighbors, rotationForSteps, toWorld, type RealmMap } from '@cr/game-core';
import { buildingModel } from '../game';

export interface Placement {
  model: string;
  matrix: THREE.Matrix4;
  /** Ground tile with land on all six sides (its outer walls can never be seen). */
  interior?: boolean;
}

const Y = new THREE.Vector3(0, 1, 0);
export function place(x: number, y: number, z: number, rotY = 0, scale = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(Y, rotY),
    new THREE.Vector3(scale, scale, scale),
  );
}

/** Buildings with separately animated parts, drawn individually rather than instanced. */
export const ANIMATED_TYPES = new Set(['farm', 'village', 'workshop']);

export function layout(realm: RealmMap) {
  const tiles: Placement[] = [];
  const props: Placement[] = [];
  const buildings: Placement[] = [];
  const animated: { id: string; model: string; matrix: THREE.Matrix4 }[] = [];

  const land = new Set(realm.cells.map(key));
  for (const c of realm.cells) {
    const w = toWorld(c);
    const interior = neighbors(c).every((n) => land.has(key(n)));
    let model = 'hex_grass';
    let rot = 0;
    if (c.tile) {
      rot = rotationForSteps(c.tile.steps);
      model = c.tile.kind === 'river' ? `hex_river_${c.tile.variant}` : `hex_road_${c.tile.variant}`;
      if (c.ford && c.tile.variant === 'A') {
        // Measured from the meshes: crossing_A carries its road across edges 1/4,
        // crossing_B across edges 2/5, both with the river on 0/3. Pick the one
        // whose rotated road matches the road through this cell.
        const k = c.tile.steps;
        model = (1 + k) % 3 === (c.crossEdge ?? 0) % 3 ? 'hex_river_crossing_A' : 'hex_river_crossing_B';
      }
    }
    tiles.push({ model, matrix: place(w.x, 0, w.z, rot), interior });
    if (c.ford) {
      // Stepping stones across the ford, along the road line.
      const a = ((c.crossEdge ?? 0) * Math.PI) / 3;
      for (const t of [-0.5, -0.17, 0.17, 0.5]) {
        const off = (t * 7) % 2 ? 0.12 : -0.12;
        props.push({ model: 'rock_single_C', matrix: place(w.x + Math.cos(a) * t + Math.sin(a) * off, -0.1, w.z + Math.sin(a) * t - Math.cos(a) * off, t * 3, 0.45) });
      }
    }
    // The bridge model spans along its local z axis; turn it to carry the road.
    if (c.bridge) props.push({ model: 'building_bridge_A', matrix: place(w.x, 0, w.z, Math.PI / 2 - ((c.crossEdge ?? 0) * Math.PI) / 3) });
    if (c.terrain === 'field') props.push({ model: 'building_grain', matrix: place(w.x, 0, w.z, 0) });
    for (const p of c.props) props.push({ model: p.model, matrix: place(w.x + p.dx, 0, w.z + p.dz, p.rotY, p.scale) });
  }

  for (const b of realm.buildings) {
    const w = toWorld(b);
    const { model } = buildingModel(b);
    const m = place(w.x, 0, w.z, b.rotY, b.scale);
    if (ANIMATED_TYPES.has(b.type)) animated.push({ id: b.id, model, matrix: m });
    else buildings.push({ model, matrix: m });
    if (b.type === 'site') buildings.push({ model: 'building_stage_B', matrix: place(w.x - 0.1, 0, w.z + 0.1, b.rotY + Math.PI / 3, 0.75) });
    if (b.type === 'castle') {
      // Banners and supplies on the castle grounds.
      const flag = b.side === 'moon' ? 'flag_blue' : 'flag_yellow';
      for (let i = 0; i < 6; i += 2) {
        const a = (i * Math.PI) / 3 + Math.PI / 6;
        props.push({ model: flag, matrix: place(w.x + Math.cos(a) * 1.75, 0, w.z + Math.sin(a) * 1.75, -a) });
      }
      props.push({ model: 'tent', matrix: place(w.x + 1.6, 0, w.z + 1.25, b.rotY) });
      props.push({ model: 'weaponrack', matrix: place(w.x - 1.7, 0, w.z + 0.9, b.rotY + 1) });
    }
  }
  return { tiles, props, buildings, animated };
}
