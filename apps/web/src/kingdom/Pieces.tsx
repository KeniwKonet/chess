/**
 * Draws the two armies from the director's piece states:
 *   - characters (Footman, Raider, Ranger, Sorceress, King): baked animation,
 *     one instanced draw per character and side;
 *   - Siege Towers (rooks): the hex kit's catapult tower, with a swinging arm;
 *   - a gold crown over each King;
 *   - optional chess-piece icons above every soldier, for instant reading;
 *   - projectiles and bursts (bolts, spells, boulders, dust, promotion light).
 */
import { useEffect, useMemo, useRef } from 'react';
import { assetUrl } from '../assets/files';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Role } from '@cr/chess-core';
import { bakeCharacter, bakedMaterial, frameAt, type UnitModel } from '../units/unitKit';
import type { Kit } from '../assets/kit';
import { BOARD_Y, CLIPS, GLYPH, HEIGHT, MODEL_OF, TEXTURE_OF, type ClipKey, type PieceModel } from './board';
import { director } from './director';
import { useKingdom } from './store';

export const PIECES_URL = assetUrl('pieces');
const MODELS: PieceModel[] = ['footman', 'raider', 'ranger', 'sorceress', 'king'];
const SIDES = ['w', 'b'] as const;
const CAP = 10;
const texUrl = (m: PieceModel, side: 'w' | 'b') => `${import.meta.env.BASE_URL}assets/units/${TEXTURE_OF[m]}_${side === 'w' ? 'sun' : 'moon'}.png`;

export function Characters() {
  const gltf = useLoader(GLTFLoader, PIECES_URL, (l) => void l.setMeshoptDecoder(MeshoptDecoder));
  const textures = useLoader(THREE.TextureLoader, MODELS.flatMap((m) => SIDES.map((s) => texUrl(m, s))));
  const models = useMemo(() => {
    const out = {} as Record<PieceModel, UnitModel<ClipKey>>;
    for (const m of MODELS) {
      const root = gltf.scene.getObjectByName(m);
      if (!root) throw new Error(`pieces file has no "${m}"`);
      out[m] = bakeCharacter<ClipKey>(m, root, gltf.animations.filter((a) => a.name.startsWith(`${m}|`)), CLIPS[m] as Record<ClipKey, string>, m, HEIGHT[m]);
      director.clipLen[m] = Object.fromEntries(Object.entries(out[m].clips).map(([k, c]) => [k, (c as { duration: number }).duration]));
    }
    return out;
  }, [gltf]);

  const layers = useMemo(() => {
    const out: { model: PieceModel; side: 'w' | 'b'; mesh: THREE.InstancedMesh; frame: THREE.InstancedBufferAttribute; feet: THREE.Matrix4 }[] = [];
    let k = 0;
    for (const m of MODELS) {
      for (const side of SIDES) {
        const tex = textures[k++]!;
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const model = models[m];
        const geo = model.geometry.clone();
        const frame = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
        frame.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aFrame', frame);
        const mesh = new THREE.InstancedMesh(geo, bakedMaterial(model as UnitModel<string>, tex), CAP);
        mesh.name = `piece:${m}:${side}`;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        out.push({ model: m, side, mesh, frame, feet: new THREE.Matrix4().makeTranslation(-model.feet.x, -model.feet.y, -model.feet.z) });
      }
    }
    return out;
  }, [models, textures]);

  useEffect(() => {
    document.body.dataset.pieces = '1';
    return () => void delete document.body.dataset.pieces;
  }, []);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const p3 = useMemo(() => new THREE.Vector3(), []);
  const s3 = useMemo(() => new THREE.Vector3(), []);
  const Y = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame(() => {
    for (const l of layers) l.mesh.count = 0;
    const t = director.now;
    for (const p of director.pieces.values()) {
      if (p.role === 'r' || p.fade <= 0) continue;
      const name = MODEL_OF[p.role];
      const l = layers.find((x) => x.model === name && x.side === p.colour)!;
      if (l.mesh.count >= CAP) continue;
      const model = models[name];
      const i = l.mesh.count++;
      q.setFromAxisAngle(Y, p.yaw);
      // Fallen soldiers sink and shrink away; promoted ones swell briefly.
      const sc = model.scale * (0.55 + 0.45 * p.fade) * (1 + p.glow * 0.15);
      m4.compose(p3.set(p.x, BOARD_Y + p.y - p.sink, p.z), q, s3.setScalar(sc));
      m4.multiply(l.feet);
      l.mesh.setMatrixAt(i, m4);
      const clip = model.clips[p.clip] ?? model.clips.idle;
      const f = frameAt(clip, Math.max(0, t - p.clipStart), p.loop);
      l.frame.setXYZ(i, f[0], f[1], f[2]);
    }
    for (const l of layers) {
      l.mesh.instanceMatrix.needsUpdate = true;
      l.frame.needsUpdate = true;
    }
  });

  return (
    <group>
      {layers.map((l) => (
        <primitive key={l.mesh.name} object={l.mesh} />
      ))}
    </group>
  );
}

/** Rooks: catapult siege towers from the hex kit, one small group each, with the arm animated. */
export function Towers({ kit }: { kit: Kit }) {
  const group = useRef<THREE.Group>(null);
  const towers = useRef(new Map<string, { root: THREE.Group; arm: THREE.Object3D | null; armBase: THREE.Matrix4 }>());
  const make = useMemo(
    () => (colour: 'w' | 'b') => {
      const model = colour === 'w' ? 'building_tower_catapult_yellow' : 'building_tower_catapult_blue';
      const root = new THREE.Group();
      let arm: THREE.Object3D | null = null;
      let armBase = new THREE.Matrix4();
      const body = new THREE.Group();
      body.scale.setScalar(0.9);
      root.add(body);
      for (const part of kit.parts.get(model) ?? []) {
        const mesh = new THREE.Mesh(part.geometry, kit.material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(part.matrix);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        body.add(mesh);
        if (/arm/i.test(part.name)) {
          arm = mesh;
          armBase = part.matrix.clone();
        }
      }
      // A wheeled wooden base, so it reads as a siege engine that rolls.
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 1.2), new THREE.MeshStandardMaterial({ color: '#6b4a2b', roughness: 0.9 }));
      base.position.y = 0.06;
      base.castShadow = true;
      root.add(base);
      const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 14);
      const wheelMat = new THREE.MeshStandardMaterial({ color: '#3b2a1a', roughness: 0.9 });
      for (const [x, z] of [[-0.58, -0.4], [0.58, -0.4], [-0.58, 0.4], [0.58, 0.4]] as const) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, 0.14, z);
        root.add(w);
      }
      body.position.y = 0.12;
      return { root, arm, armBase };
    },
    [kit],
  );
  const tmp = useMemo(() => new THREE.Matrix4(), []);
  const rot = useMemo(() => new THREE.Matrix4(), []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const seen = new Set<string>();
    for (const p of director.pieces.values()) {
      if (p.role !== 'r' || p.fade <= 0) continue;
      seen.add(p.id);
      let t = towers.current.get(p.id);
      if (!t) {
        t = make(p.colour);
        towers.current.set(p.id, t);
        g.add(t.root);
      }
      t.root.visible = true;
      t.root.position.set(p.x, BOARD_Y - p.sink, p.z);
      t.root.rotation.set(0, p.yaw, 0);
      t.root.rotateZ(p.tilt);
      t.root.scale.setScalar(1 + p.glow * 0.15);
      if (t.arm) {
        rot.makeRotationX(p.arm);
        tmp.copy(t.armBase).multiply(rot);
        t.arm.matrix.copy(tmp);
      }
    }
    for (const [id, t] of towers.current) if (!seen.has(id)) t.root.visible = false;
  });
  return <group ref={group} />;
}

/** Gold crowns over the Kings, and chess icons over every soldier (optional). */
export function Badges() {
  const icons = useKingdom((s) => s.icons);
  const crown = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.2, 0.16, 0.15, 10, 1, true);
    const m = new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 0.6, roughness: 0.35, side: THREE.DoubleSide, emissive: '#5a3a00', emissiveIntensity: 0.4 });
    const mesh = new THREE.InstancedMesh(g, m, 2);
    mesh.frustumCulled = false;
    return mesh;
  }, []);
  const spikes = useMemo(() => {
    const g = new THREE.ConeGeometry(0.045, 0.11, 5);
    const m = new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 0.6, roughness: 0.35 });
    const mesh = new THREE.InstancedMesh(g, m, 2 * 6);
    mesh.frustumCulled = false;
    return mesh;
  }, []);
  // One icon atlas: 6 roles x 2 sides.
  const iconMesh = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 6 * 64;
    c.height = 2 * 64;
    const x = c.getContext('2d')!;
    const roles: Role[] = ['k', 'q', 'r', 'b', 'n', 'p'];
    roles.forEach((r, i) => {
      for (let s = 0; s < 2; s++) {
        const cx = i * 64 + 32;
        const cy = s * 64 + 32;
        x.beginPath();
        x.arc(cx, cy, 27, 0, Math.PI * 2);
        x.fillStyle = s === 0 ? '#2b2116' : '#16233a';
        x.fill();
        x.lineWidth = 4;
        x.strokeStyle = s === 0 ? '#e8b33a' : '#5b9bf0';
        x.stroke();
        x.fillStyle = s === 0 ? '#ffe7a3' : '#cfe3ff';
        x.font = '38px "Segoe UI Symbol","Noto Sans Symbols 2","DejaVu Sans",serif';
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(GLYPH[r], cx, cy + 2);
      }
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(0.4, 0.4);
    const uv = new THREE.InstancedBufferAttribute(new Float32Array(40 * 2), 2);
    geo.setAttribute('aCell', uv);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = (vMapUv + aCell) * vec2(1.0/6.0, 0.5);\n#endif');
    };
    const mesh = new THREE.InstancedMesh(geo, mat, 40);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    return { mesh, uv };
  }, []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const v = useMemo(() => new THREE.Vector3(), []);
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const sc = useMemo(() => new THREE.Vector3(), []);
  const order: Role[] = ['k', 'q', 'r', 'b', 'n', 'p'];

  useFrame(({ camera }) => {
    let c = 0;
    let sp = 0;
    let ic = 0;
    for (const p of director.pieces.values()) {
      if (p.fade <= 0.05) continue;
      if (p.role === 'k') {
        const y = BOARD_Y + p.y - p.sink + HEIGHT.king + 0.05 + Math.sin(director.now * 2 + (p.colour === 'w' ? 0 : 1)) * 0.015;
        m4.compose(v.set(p.x, y, p.z), q.identity(), one);
        crown.setMatrixAt(c++, m4);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          m4.makeTranslation(p.x + Math.cos(a) * 0.19, y + 0.11, p.z + Math.sin(a) * 0.19);
          spikes.setMatrixAt(sp++, m4);
        }
      }
      if (icons && ic < 40) {
        const h = p.role === 'r' ? 1.95 : HEIGHT[MODEL_OF[p.role as Exclude<Role, 'r'>]];
        const y = BOARD_Y + p.y - p.sink + h + (p.role === 'k' ? 0.42 : 0.3);
        m4.compose(v.set(p.x, y, p.z), camera.quaternion, sc.setScalar(p.fade));
        iconMesh.mesh.setMatrixAt(ic, m4);
        iconMesh.uv.setXY(ic, order.indexOf(p.role), p.colour === 'w' ? 1 : 0);
        ic++;
      }
    }
    crown.count = c;
    spikes.count = sp;
    iconMesh.mesh.count = ic;
    crown.instanceMatrix.needsUpdate = true;
    spikes.instanceMatrix.needsUpdate = true;
    iconMesh.mesh.instanceMatrix.needsUpdate = true;
    iconMesh.uv.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={crown} />
      <primitive object={spikes} />
      <primitive object={iconMesh.mesh} />
    </group>
  );
}

/** Bolts, spell orbs, boulders, impact bursts, dust and the promotion light. */
export function Effects() {
  const pool = useMemo(() => {
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => Array.from({ length: n }, () => {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      return m;
    });
    const glow = (c: string) => new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const bolt = new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5).rotateX(Math.PI / 2);
    return {
      bolt: make(bolt, new THREE.MeshStandardMaterial({ color: '#4a3826' }), 4),
      orb: make(new THREE.SphereGeometry(0.14, 12, 10), glow('#ffd36a'), 4),
      halo: make(new THREE.SphereGeometry(0.3, 12, 10), glow('#ffd36a'), 4),
      boulder: make(new THREE.DodecahedronGeometry(0.17), new THREE.MeshStandardMaterial({ color: '#7a7064', roughness: 1 }), 4),
      burst: make(new THREE.SphereGeometry(0.4, 14, 10), glow('#ffffff'), 6),
      light: make(new THREE.CylinderGeometry(0.55, 0.55, 5, 18, 1, true), glow('#ffe08a'), 2),
      dust: make(new THREE.SphereGeometry(0.6, 10, 8), new THREE.MeshBasicMaterial({ color: '#b8a98c', transparent: true, depthWrite: false }), 6),
    };
  }, []);
  const all = useMemo(() => Object.values(pool).flat(), [pool]);
  const v = useMemo(() => new THREE.Vector3(), []);
  const n = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    for (const m of all) m.visible = false;
    const used: Record<string, number> = {};
    const take = (k: keyof typeof pool) => {
      const i = (used[k] = (used[k] ?? -1) + 1);
      return pool[k][i];
    };
    const t = director.now;
    for (const e of director.effects) {
      const k = Math.min(1, Math.max(0, (t - e.t0) / e.dur));
      const pos = (kk: number, out: THREE.Vector3) => out.set(e.from.x + (e.to.x - e.from.x) * kk, e.from.y + (e.to.y - e.from.y) * kk + Math.sin(kk * Math.PI) * e.arc, e.from.z + (e.to.z - e.from.z) * kk);
      if (e.kind === 'bolt' || e.kind === 'boulder' || e.kind === 'orb') {
        if (t - e.t0 > e.dur) continue;
        const m = take(e.kind);
        if (!m) continue;
        pos(k, m.position);
        m.visible = true;
        if (e.kind === 'bolt') m.lookAt(pos(Math.min(1, k + 0.05), n));
        if (e.kind === 'boulder') m.rotation.set(t * 7, t * 5, 0);
        if (e.kind === 'orb') {
          (m.material as THREE.MeshBasicMaterial).color.set(e.colour);
          const h = take('halo');
          if (h) {
            h.visible = true;
            h.position.copy(m.position);
            const mat = h.material as THREE.MeshBasicMaterial;
            mat.color.set(e.colour);
            mat.opacity = 0.35 + Math.sin(t * 30) * 0.1;
          }
        }
      } else if (e.kind === 'burst') {
        const m = take('burst');
        if (!m) continue;
        m.visible = k < 1;
        m.position.set(e.from.x, e.from.y, e.from.z);
        m.scale.setScalar(0.3 + k * 1.4);
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.set(e.colour);
        mat.opacity = (1 - k) * 0.8;
      } else if (e.kind === 'light') {
        const m = take('light');
        if (!m) continue;
        m.visible = k < 1;
        m.position.set(e.from.x, BOARD_Y + 2.5, e.from.z);
        m.scale.set(1 - k * 0.6, 1, 1 - k * 0.6);
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.set(e.colour);
        mat.opacity = Math.sin(k * Math.PI) * 0.55;
      } else if (e.kind === 'dust') {
        for (let j = 0; j < 3; j++) {
          const m = take('dust');
          if (!m) break;
          m.visible = k < 1;
          const a = j * 2.1;
          m.position.set(e.from.x + Math.cos(a) * k * 0.6, BOARD_Y + 0.3 + k * 0.5, e.from.z + Math.sin(a) * k * 0.6);
          m.scale.setScalar(0.4 + k * 0.9);
          (m.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.6;
        }
      }
    }
    void v;
  });

  return (
    <group>
      {all.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
    </group>
  );
}
