/**
 * Shown only if the model kit fails to load: the same map from simple shapes,
 * so the camera, minimap and inspection still work.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { toWorld } from '@cr/game-core';
import { realm, buildingModel } from '../game';

const COLOURS: Record<string, string> = {
  grass: '#8DBA45', forest: '#3F7F3A', hill: '#A2B85A', mountain: '#8E8A80', field: '#E3B54F', water: '#3E8FD0',
  river: '#3E8FD0', road: '#D9B27C', sun: '#E8B33A', moon: '#4E86D6', neutral: '#CFC6B0',
};

export function FallbackWorld() {
  const group = useMemo(() => {
    const g = new THREE.Group();
    const tile = new THREE.CylinderGeometry(1.15, 1.15, 1, 6);
    tile.rotateY(Math.PI / 6);
    tile.translate(0, -0.5, 0);
    const groups = new Map<string, THREE.Matrix4[]>();
    for (const c of realm.cells) {
      const k = c.river && !c.bridge && !c.ford ? 'river' : c.road || c.bridge || c.ford ? 'road' : c.terrain;
      const w = toWorld(c);
      const m = new THREE.Matrix4().makeTranslation(w.x, c.terrain === 'mountain' ? 0.8 : c.terrain === 'hill' ? 0.3 : 0, w.z);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
    }
    for (const [k, mats] of groups) {
      const mesh = new THREE.InstancedMesh(tile, new THREE.MeshStandardMaterial({ color: COLOURS[k] ?? '#888', roughness: 0.9 }), mats.length);
      mats.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    for (const b of realm.buildings) {
      const { height, radius } = buildingModel(b);
      const w = toWorld(b);
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.8, radius, height, b.type === 'castle' ? 8 : 4),
        new THREE.MeshStandardMaterial({ color: COLOURS[b.side], roughness: 0.7 }),
      );
      mesh.position.set(w.x, height / 2, w.z);
      mesh.castShadow = true;
      g.add(mesh);
    }
    return g;
  }, []);
  return <primitive object={group} />;
}
