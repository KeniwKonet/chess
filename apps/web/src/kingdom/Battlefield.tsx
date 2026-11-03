/**
 * The field of battle: an 8x8 stone plaza (light sandstone and dark earth
 * squares, as on the War Table), set in a green valley from the hex kit with
 * the Sun's castle and camp behind rank 1 and the Moon's behind rank 8, and
 * hills, forest and mountains closing the valley in.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { toWorld } from '@cr/game-core';
import { instance, type Kit } from '../assets/kit';
import { BOARD_Y, FILES, SQ, isLight } from './board';

const HALF = 4 * SQ;
const BORDER = 0.95;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function Plaza() {
  const squares = useMemo(() => {
    const geo = new THREE.BoxGeometry(SQ * 0.97, 0.16, SQ * 0.97);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, mat, 64);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const r = rng(11);
    let i = 0;
    for (let rank = 1; rank <= 8; rank++) {
      for (const f of FILES) {
        const sq = `${f}${rank}`;
        m.makeTranslation((FILES.indexOf(f) - 3.5) * SQ, BOARD_Y - 0.08, (3.5 - (rank - 1)) * SQ);
        mesh.setMatrixAt(i, m);
        // Sandstone and dark earth, each stone slightly different.
        const jitter = (r() - 0.5) * 0.06;
        if (isLight(sq)) c.setHSL(0.1, 0.4, 0.6 + jitter);
        else c.setHSL(0.075, 0.38, 0.27 + jitter);
        mesh.setColorAt(i, c);
        i++;
      }
    }
    mesh.receiveShadow = true;
    mesh.name = 'board:squares';
    return mesh;
  }, []);

  const frame = useMemo(() => {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#7a6f60', roughness: 0.95 });
    const trim = new THREE.MeshStandardMaterial({ color: '#5b5246', roughness: 0.95 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(2 * (HALF + BORDER), 0.5, 2 * (HALF + BORDER)), stone);
    base.position.y = BOARD_Y - 0.25 - 0.06;
    base.receiveShadow = true;
    g.add(base);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(2 * (HALF + BORDER) + 0.3, 0.22, 2 * (HALF + BORDER) + 0.3), trim);
    lip.position.y = 0.11 - 0.06;
    lip.receiveShadow = true;
    g.add(lip);
    // Corner posts with braziers.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.55), trim);
        post.position.set(sx * (HALF + BORDER - 0.28), BOARD_Y + 0.2, sz * (HALF + BORDER - 0.28));
        post.castShadow = true;
        g.add(post);
        const fire = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.38, 8), new THREE.MeshBasicMaterial({ color: '#ffb347', toneMapped: false }));
        fire.position.set(post.position.x, BOARD_Y + 0.84, post.position.z);
        g.add(fire);
      }
    }
    // Rank and file letters carved into the border, on all four sides.
    const label = (text: string) => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d')!;
      x.fillStyle = '#efe2c4';
      x.font = 'bold 40px "Barlow Condensed", Barlow, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(text, 32, 34);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
    };
    const plane = new THREE.PlaneGeometry(0.5, 0.5).rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const f = FILES[i]!;
      const fm = label(f);
      const rm = label(String(i + 1));
      for (const s of [-1, 1]) {
        const a = new THREE.Mesh(plane, fm);
        a.position.set((i - 3.5) * SQ, BOARD_Y - 0.055, s * (HALF + BORDER / 2));
        if (s < 0) a.rotation.y = Math.PI;
        g.add(a);
        const b = new THREE.Mesh(plane, rm);
        b.position.set(s * (HALF + BORDER / 2), BOARD_Y - 0.055, (3.5 - i) * SQ);
        b.rotation.y = s < 0 ? -Math.PI / 2 : Math.PI / 2;
        g.add(b);
      }
    }
    return g;
  }, []);

  return (
    <group>
      <primitive object={frame} />
      <primitive object={squares} />
    </group>
  );
}

/** Valley, castles and camps from the hex kit. */
export function Valley({ kit }: { kit: Kit }) {
  const scene = useMemo(() => {
    const items: { model: string; matrix: THREE.Matrix4 }[] = [];
    const add = (model: string, x: number, z: number, scale = 1, yaw = 0, y = 0) => {
      if (!kit.has(model)) return;
      items.push({ model, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale)) });
    };
    const r = rng(4);
    const keepClear = (x: number, z: number) => Math.abs(x) < HALF + BORDER + 1.2 && Math.abs(z) < HALF + BORDER + 1.2;
    const campZone = (x: number, z: number) => Math.abs(x) < 9 && Math.abs(z) > HALF + 1 && Math.abs(z) < 17;
    // Grass carpet of hex tiles out to the hills.
    for (let q = -18; q <= 18; q++) {
      for (let rr = -18; rr <= 18; rr++) {
        const w = toWorld({ q, r: rr });
        const d = Math.hypot(w.x, w.z);
        if (d > 36) continue;
        add('hex_grass', w.x, w.z, 1, (Math.floor(r() * 6) * Math.PI) / 3);
        if (keepClear(w.x, w.z) || campZone(w.x, w.z)) continue;
        // A ring of forest, then hills, then mountains closing the valley.
        const roll = r();
        if (d > 29) add(roll < 0.5 ? 'mountain_A_grass_trees' : roll < 0.8 ? 'mountain_B_grass_trees' : 'mountain_C_grass', w.x, w.z, 1.6 + r() * 0.6, r() * 6);
        else if (d > 23) add(roll < 0.5 ? 'hills_A_trees' : 'hills_B_trees', w.x, w.z, 1.2 + r() * 0.4, r() * 6);
        else if (d > 14 && roll < 0.55) add(roll < 0.3 ? 'trees_A_large' : 'trees_B_large', w.x, w.z, 1.15 + r() * 0.3, r() * 6);
        else if (d > 11 && roll < 0.2) add(roll < 0.1 ? 'tree_single_A' : 'tree_single_B', w.x, w.z, 1.3, r() * 6);
        else if (roll > 0.94) add(`rock_single_${'ABCDE'[Math.floor(r() * 5)]}`, w.x, w.z, 1.6, r() * 6);
      }
    }
    // The two castles, facing each other across the field.
    add('building_castle_yellow', 0, HALF + 7.2, 2.6, Math.PI);
    add('building_castle_blue', 0, -(HALF + 7.2), 2.6, 0);
    // Camps: tents, weapon racks, barrels and banners beside each castle.
    for (const [side, sz] of [['yellow', 1], ['blue', -1]] as const) {
      for (const sx of [-1, 1]) {
        add('tent', sx * 6.2, sz * (HALF + 3.6), 2.6, sx * 0.4);
        add('tent', sx * 7.6, sz * (HALF + 6.2), 2.6, -sx * 0.3);
        add('weaponrack', sx * 4.6, sz * (HALF + 2.6), 2.4, sz > 0 ? Math.PI : 0);
        add('barrel', sx * 5.1, sz * (HALF + 4.9), 2.4);
        add('crate_A_big', sx * 5.5, sz * (HALF + 5.4), 2.2, 0.3);
        add('sack', sx * 4.9, sz * (HALF + 5.5), 2.4);
        add(`flag_${side}`, sx * (HALF + BORDER + 0.6), sz * (HALF + BORDER + 0.2), 3.2, sz > 0 ? Math.PI : 0);
        add(`flag_${side}`, sx * 3.1, sz * (HALF + 3.1), 3.6, sz > 0 ? Math.PI : 0);
      }
      add(side === 'yellow' ? 'building_tower_A_yellow' : 'building_tower_A_blue', 8.8, sz * (HALF + 8.5), 2.0);
      add(side === 'yellow' ? 'building_tower_A_yellow' : 'building_tower_A_blue', -8.8, sz * (HALF + 8.5), 2.0);
    }
    const { group } = instance(kit, items, { castShadow: true, receiveShadow: true, name: 'kingdom:valley' });
    return group;
  }, [kit]);
  return <primitive object={scene} />;
}
