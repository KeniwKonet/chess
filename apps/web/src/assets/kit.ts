/**
 * Loads the packed asset kit (public/assets/kit.glb, built by tools/build-assets.mjs)
 * and exposes each model as a list of mesh parts with their local transforms,
 * ready for instancing.
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { withFog } from '../world/fog';

export interface KitPart {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Transform of the mesh relative to the model's root. */
  matrix: THREE.Matrix4;
}

export interface Kit {
  parts: Map<string, KitPart[]>;
  roots: Map<string, THREE.Object3D>;
  /** Shared material for all static models. */
  material: THREE.MeshStandardMaterial;
  /** Same atlas, with a vertex wind sway for trees. */
  foliage: THREE.MeshStandardMaterial;
  has: (model: string) => boolean;
}

/** kit.glb by default; set VITE_KIT_FILE=kit.json for hosts that only serve common web file types. */
export const KIT_URL = `${import.meta.env.BASE_URL}assets/${import.meta.env.VITE_KIT_FILE ?? 'kit.glb'}`;

/** Shared time uniform for animated materials. */
export const windTime = { value: 0 };

const FOLIAGE = /^(trees_|tree_single|hills_[ABC]_trees|mountain_[ABC]_grass_trees)/;
export const isFoliage = (model: string) => FOLIAGE.test(model);

export function buildKit(gltf: GLTF): Kit {
  const parts = new Map<string, KitPart[]>();
  const roots = new Map<string, THREE.Object3D>();
  gltf.scene.updateMatrixWorld(true);
  let material: THREE.MeshStandardMaterial | undefined;

  for (const root of gltf.scene.children) {
    roots.set(root.name, root);
    const inv = root.matrixWorld.clone().invert();
    const list: KitPart[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      material ??= mat;
      list.push({ name: mesh.name, geometry: mesh.geometry, material: mat, matrix: inv.clone().multiply(mesh.matrixWorld) });
    });
    parts.set(root.name, list);
  }
  if (!material) throw new Error('Asset kit contains no meshes');

  // Matte, toy-like finish.
  material.metalness = 0;
  material.roughness = 0.82;
  if (material.map) {
    material.map.anisotropy = 4;
    material.map.colorSpace = THREE.SRGBColorSpace;
  }

  const foliage = material.clone();
  foliage.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = windTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;\nattribute vec3 aOrigin;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3]);
#else
  vec3 ip = aOrigin;
#endif
  float h = max(transformed.y - ip.y - 0.25, 0.0);
  float s = sin(uWind * 1.7 + ip.x * 0.63 + ip.z * 0.41) + 0.4 * sin(uWind * 3.1 + ip.z * 1.3);
  transformed.x += s * 0.035 * h;
  transformed.z += s * 0.02 * h;`,
      );
  };
  foliage.customProgramCacheKey = () => 'foliage-wind';

  withFog(material);
  withFog(foliage);
  return { parts, roots, material, foliage, has: (m) => parts.has(m) };
}

/**
 * Build one InstancedMesh per mesh part of each model. Instances are grouped
 * by model, so draw calls scale with distinct models, not with object count.
 */
export function instance(
  kit: Kit,
  items: { model: string; matrix: THREE.Matrix4 }[],
  opts: { castShadow: boolean; receiveShadow: boolean; name: string },
): { group: THREE.Group; missing: string[] } {
  const group = new THREE.Group();
  group.name = opts.name;
  const byModel = new Map<string, THREE.Matrix4[]>();
  for (const it of items) {
    const arr = byModel.get(it.model) ?? [];
    arr.push(it.matrix);
    byModel.set(it.model, arr);
  }
  const missing: string[] = [];
  const tmp = new THREE.Matrix4();
  for (const [model, mats] of byModel) {
    const parts = kit.parts.get(model);
    if (!parts) {
      missing.push(model);
      continue;
    }
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, isFoliage(model) ? kit.foliage : kit.material, mats.length);
      mesh.name = `${model}:${part.name}`;
      mats.forEach((m, i) => mesh.setMatrixAt(i, tmp.multiplyMatrices(m, part.matrix)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = opts.castShadow;
      mesh.receiveShadow = opts.receiveShadow;
      group.add(mesh);
    }
  }
  return { group, missing };
}

/**
 * Bake static placements into a few merged meshes per map chunk. Everything
 * shares one material, so a chunk costs at most three draw calls (ground,
 * solid props, foliage), and chunks outside the view are culled.
 */
export function mergeChunks(
  kit: Kit,
  items: { model: string; matrix: THREE.Matrix4; interior?: boolean }[],
  opts: { name: string; chunk: number; castShadow: boolean; receiveShadow: boolean; ground?: boolean },
): { group: THREE.Group; missing: string[]; triangles: number } {
  const group = new THREE.Group();
  group.name = opts.name;
  const missing = new Set<string>();
  type Bucket = { foliage: boolean; pieces: { part: KitPart; m: THREE.Matrix4; origin: THREE.Vector3; interior: boolean }[] };
  const buckets = new Map<string, Bucket>();
  const full = new THREE.Matrix4();
  for (const it of items) {
    const parts = kit.parts.get(it.model);
    if (!parts) {
      missing.add(it.model);
      continue;
    }
    const origin = new THREE.Vector3().setFromMatrixPosition(it.matrix);
    const foliage = isFoliage(it.model);
    const key = `${Math.floor(origin.x / opts.chunk)},${Math.floor(origin.z / opts.chunk)},${foliage ? 'f' : 's'}`;
    const b = buckets.get(key) ?? { foliage, pieces: [] };
    for (const part of parts) b.pieces.push({ part, m: full.multiplyMatrices(it.matrix, part.matrix).clone(), origin, interior: !!it.interior });
    buckets.set(key, b);
  }
  let triangles = 0;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const [key, b] of buckets) {
    let vCount = 0;
    let iCount = 0;
    for (const { part } of b.pieces) {
      vCount += part.geometry.attributes.position!.count;
      iCount += part.geometry.index ? part.geometry.index.count : part.geometry.attributes.position!.count;
    }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const ori = b.foliage ? new Float32Array(vCount * 3) : null;
    const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0;
    let io = 0;
    for (const { part, m, origin, interior } of b.pieces) {
      const g = part.geometry;
      const P = g.attributes.position!;
      const N = g.attributes.normal;
      const U = g.attributes.uv;
      nm.getNormalMatrix(m);
      for (let i = 0; i < P.count; i++) {
        p.fromBufferAttribute(P, i).applyMatrix4(m);
        pos.set([p.x, p.y, p.z], (vo + i) * 3);
        if (N) {
          n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
          nor.set([n.x, n.y, n.z], (vo + i) * 3);
        }
        if (U) uv.set([U.getX(i), U.getY(i)], (vo + i) * 2);
        if (ori) ori.set([origin.x, origin.y, origin.z], (vo + i) * 3);
      }
      const ic = g.index ? g.index.count : P.count;
      const at = (i: number) => (g.index ? g.index.getX(i) : i);
      for (let t = 0; t < ic; t += 3) {
        const a = at(t) + vo, b2 = at(t + 1) + vo, c = at(t + 2) + vo;
        if (opts.ground && hiddenGroundFace(pos, a, b2, c, origin, interior)) continue;
        idx[io++] = a;
        idx[io++] = b2;
        idx[io++] = c;
      }
      vo += P.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (ori) geo.setAttribute('aOrigin', new THREE.BufferAttribute(ori, 3));
    geo.setIndex(new THREE.BufferAttribute(idx.slice(0, io), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    triangles += io / 3;
    const mesh = new THREE.Mesh(geo, b.foliage ? kit.foliage : kit.material);
    mesh.name = `${opts.name}:${key}`;
    mesh.castShadow = opts.castShadow;
    mesh.receiveShadow = opts.receiveShadow;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return { group, missing: [...missing], triangles };
}

/**
 * Ground tiles are 1 unit deep, viewed from above. Their undersides are never
 * visible, and neither are the outer walls of a tile with land on all six sides.
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
function hiddenGroundFace(pos: Float32Array, a: number, b: number, c: number, origin: THREE.Vector3, interior: boolean): boolean {
  _a.fromArray(pos, a * 3);
  _b.fromArray(pos, b * 3);
  _c.fromArray(pos, c * 3);
  _n.subVectors(_b, _a).cross(_c.clone().sub(_a)).normalize();
  if (_n.y < -0.5) return true;
  if (!interior) return false;
  const cx = (_a.x + _b.x + _c.x) / 3 - origin.x;
  const cy = (_a.y + _b.y + _c.y) / 3;
  const cz = (_a.z + _b.z + _c.z) / 3 - origin.z;
  return Math.abs(_n.y) < 0.3 && Math.hypot(cx, cz) > 0.9 && cy < -0.05;
}

/** Lower-detail substitutes used at medium and low quality. */
const LOD_SWAP: Record<string, string> = {
  trees_B_large: 'trees_B_medium',
  trees_A_large: 'trees_A_medium',
};
export function liteModel(kit: Kit, model: string): string {
  const swapped = LOD_SWAP[model] ?? model;
  return kit.has(`${swapped}__lite`) ? `${swapped}__lite` : swapped;
}
