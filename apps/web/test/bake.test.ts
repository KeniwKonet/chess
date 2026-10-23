/**
 * The baked animation must reproduce three.js's own skinning exactly: for
 * sampled frames of every clip, each vertex of the flattened soldier,
 * transformed by the baked bone matrices, must land where the original
 * SkinnedMesh (or bone-attached weapon) puts it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildUnitModels, type ClipName } from '../src/units/unitKit';

async function load(): Promise<GLTF> {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/assets/units.glb');
  const buf = fs.readFileSync(file);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return new Promise((res, rej) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
}

const SRC: Record<string, Record<ClipName, string>> = {
  knight: { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack: '1H_Melee_Attack_Chop', hit: 'Hit_A', death: 'Death_A', cheer: 'Cheer' },
  rogue: { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack: '1H_Ranged_Shoot', hit: 'Hit_A', death: 'Death_A', cheer: 'Cheer' },
};

describe('baked soldier animation', () => {
  it('matches three.js skinning for every clip, within 1 mm of model scale', async () => {
    const models = buildUnitModels(await load());
    // Fresh copy for the reference pose (the bake moves the original rig).
    const ref = await load();
    for (const [type, char] of [['infantry', 'knight'], ['archer', 'rogue']] as const) {
      const m = models[type];
      const root = ref.scene.getObjectByName(char)!;
      root.updateMatrixWorld(true);
      const Rinv = root.matrixWorld.clone().invert();
      for (const lodPass of [false, true]) {
      const skinned: THREE.SkinnedMesh[] = [];
      const rigid: THREE.Mesh[] = [];
      root.traverse((o) => {
        if (o.name.endsWith('__lod') !== lodPass) return;
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
        else if ((o as THREE.Mesh).isMesh) rigid.push(o as THREE.Mesh);
      });
      const geo = lodPass ? m.lodGeometry : m.geometry;
      const P = geo.attributes.position!;
      const SI = geo.attributes.aSkinIndex!;
      const SW = geo.attributes.aSkinWeight!;
      const data = m.bake.image.data as Float32Array;
      const width = m.bake.image.width;
      const mixer = new THREE.AnimationMixer(root);
      mixer.stopAllAction();
      let worst = 0;
      for (const clipName of Object.keys(SRC[char]!) as ClipName[]) {
        const clip = ref.animations.find((a) => a.name === `${char}|${SRC[char]![clipName]}`)!;
        const baked = m.clips[clipName];
        for (const f of [0, Math.floor(baked.frames / 3), baked.frames - 1]) {
          mixer.stopAllAction();
          mixer.clipAction(clip).play();
          mixer.setTime((f / baked.frames) * clip.duration);
          root.updateMatrixWorld(true);
          for (const s of skinned) s.skeleton.update();
          // Expected positions, in the same order the bake appended them.
          const expected: THREE.Vector3[] = [];
          const v = new THREE.Vector3();
          for (const s of skinned) {
            for (let i = 0; i < s.geometry.attributes.position!.count; i++) {
              s.getVertexPosition(i, v);
              expected.push(v.clone().applyMatrix4(s.matrixWorld).applyMatrix4(Rinv));
            }
          }
          for (const r of rigid) {
            let p = r.parent;
            while (p && !(p as THREE.Bone).isBone) p = p.parent;
            if (!p) continue;
            for (let i = 0; i < r.geometry.attributes.position!.count; i++) {
              expected.push(v.fromBufferAttribute(r.geometry.attributes.position!, i).applyMatrix4(r.matrixWorld).applyMatrix4(Rinv).clone());
            }
          }
          expect(expected.length).toBe(P.count);
          const row = baked.start + f;
          const M = new THREE.Matrix4();
          const acc = new THREE.Vector3();
          const tmp = new THREE.Vector3();
          // Check every 7th vertex to keep the test quick.
          for (let i = 0; i < P.count; i += 7) {
            acc.set(0, 0, 0);
            for (const k of [0, 1, 2, 3]) {
              const w = SW.getComponent(i, k);
              if (!w) continue;
              const b = Math.round(SI.getComponent(i, k));
              M.fromArray(data, (row * width + b * 4) * 4);
              acc.addScaledVector(tmp.fromBufferAttribute(P, i).applyMatrix4(M), w);
            }
            worst = Math.max(worst, acc.distanceTo(expected[i]!));
          }
        }
      }
      // Model units are roughly metres-scale (about 2.5 tall); 1e-3 is sub-millimetre at game scale.
      expect(worst, `${type}${lodPass ? ' (low detail)' : ''} worst vertex error`).toBeLessThan(1e-3);
      }
    }
  });

  it('bakes every clip the game uses, from the file', async () => {
    const models = buildUnitModels(await load());
    for (const m of Object.values(models)) {
      for (const c of ['idle', 'walk', 'run', 'attack', 'hit', 'death', 'cheer'] as ClipName[]) {
        expect(m.clips[c].frames).toBeGreaterThan(5);
      }
      expect(m.bake.image.height).toBe(Object.values(m.clips).reduce((s, c) => s + c.frames, 0));
    }
  });
});
