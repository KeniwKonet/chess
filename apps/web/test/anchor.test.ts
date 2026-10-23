/** A placed soldier must stand on its unit position: posed feet at ground level, body centred over the point. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildUnitModels, UNIT_HEIGHT } from '../src/units/unitKit';

describe('soldier placement', () => {
  it('stands on the unit position at the intended height, at any heading', async () => {
    const buf = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/assets/units.glb'));
    const g = await new Promise<GLTF>((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
    const models = buildUnitModels(g);
    for (const m of Object.values(models)) {
      const P = m.geometry.attributes.position!, SI = m.geometry.attributes.aSkinIndex!, SW = m.geometry.attributes.aSkinWeight!;
      const data = m.bake.image.data as Float32Array, width = m.bake.image.width;
      const row = m.clips.idle.start;
      for (const heading of [0, 1.3, -2.4]) {
        // Same transform the renderer builds: T(pos) * R(heading) * S(scale) * T(-feet).
        const inst = new THREE.Matrix4()
          .compose(new THREE.Vector3(10, 0, 5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading), new THREE.Vector3().setScalar(m.scale))
          .multiply(new THREE.Matrix4().makeTranslation(-m.feet.x, -m.feet.y, -m.feet.z));
        const box = new THREE.Box3();
        const M = new THREE.Matrix4(), acc = new THREE.Vector3(), t = new THREE.Vector3();
        let feetSumX = 0, feetSumZ = 0, feetN = 0;
        for (let i = 0; i < P.count; i++) {
          acc.set(0, 0, 0);
          for (const k of [0, 1, 2, 3]) {
            const w = SW.getComponent(i, k);
            if (!w) continue;
            M.fromArray(data, (row * width + Math.round(SI.getComponent(i, k)) * 4) * 4);
            acc.addScaledVector(t.fromBufferAttribute(P, i).applyMatrix4(M), w);
          }
          acc.applyMatrix4(inst);
          box.expandByPoint(acc);
          if (acc.y < 0.06) { feetSumX += acc.x; feetSumZ += acc.z; feetN++; }
        }
        // The body's lowest point is the anchor; a sword tip or shield rim may dip a few cm lower.
        expect(box.min.y).toBeGreaterThan(-0.1);
        expect(box.min.y).toBeLessThan(0.02);
        expect(box.max.y).toBeGreaterThan(UNIT_HEIGHT * 0.9);
        expect(box.max.y).toBeLessThan(UNIT_HEIGHT * 1.35); // weapons may rise a little above the head
        expect(Math.hypot(feetSumX / feetN - 10, feetSumZ / feetN - 5)).toBeLessThan(0.12);
      }
    }
  });
});
