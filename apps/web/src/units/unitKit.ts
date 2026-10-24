/**
 * Soldier models with baked animation, for instanced rendering.
 *
 * At load, each character (KayKit Knight = infantry, Rogue = archers) is
 * flattened into one geometry whose vertices carry bone indices and weights,
 * including the rigid parts (helmet, sword, shield, crossbow, cape) bound to
 * the bone they hang from. Every frame of every clip the game uses is then
 * sampled once from the real animation data into a float texture of bone
 * matrices. Drawing a whole company is a single instanced draw call; each
 * soldier picks its own clip and frame through a per-instance attribute.
 *
 * Only clips that exist in the files are used (see CLIP_SOURCES).
 */
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { UnitType } from '@cr/game-core';
import { withFog } from '../world/fog';

export const BAKE_FPS = 30;
export const UNIT_HEIGHT = 0.78;

export type ClipName = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death' | 'cheer';
/** Game clip -> clip name in the model file. */
const CLIP_SOURCES: Record<UnitType, Record<ClipName, string>> = {
  infantry: { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack: '1H_Melee_Attack_Chop', hit: 'Hit_A', death: 'Death_A', cheer: 'Cheer' },
  archer: { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack: '1H_Ranged_Shoot', hit: 'Hit_A', death: 'Death_A', cheer: 'Cheer' },
};
const MODEL_OF: Record<UnitType, string> = { infantry: 'knight', archer: 'rogue' };

export interface BakedClip {
  start: number;
  frames: number;
  duration: number;
}

export interface UnitModel {
  type: UnitType;
  geometry: THREE.BufferGeometry;
  /** Simplified geometry (about 40% of the triangles) for mid-range zoom, same skinning. */
  lodGeometry: THREE.BufferGeometry;
  bake: THREE.DataTexture;
  clips: Record<ClipName, BakedClip>;
  bones: number;
  /** Uniform scale that makes the model UNIT_HEIGHT tall. */
  scale: number;
  /** Model-space point under the feet (rest pose); instances are placed so it lands on the unit's position. */
  feet: THREE.Vector3;
}

export const UNITS_URL = `${import.meta.env.BASE_URL}assets/${import.meta.env.VITE_UNITS_FILE ?? 'units.glb'}`;
export const unitTextureUrl = (type: UnitType, side: 'sun' | 'moon') => `${import.meta.env.BASE_URL}assets/units/${MODEL_OF[type]}_${side}.png`;

function nearestBone(o: THREE.Object3D): THREE.Bone | null {
  let p = o.parent;
  while (p) {
    if ((p as THREE.Bone).isBone) return p as THREE.Bone;
    p = p.parent;
  }
  return null;
}

export function buildUnitModels(gltf: GLTF): Record<UnitType, UnitModel> {
  const out = {} as Record<UnitType, UnitModel>;
  for (const type of ['infantry', 'archer'] as UnitType[]) {
    const name = MODEL_OF[type];
    const root = gltf.scene.getObjectByName(name);
    if (!root) throw new Error(`units file has no "${name}" model`);
    out[type] = bakeCharacter(type, root, gltf.animations.filter((a) => a.name.startsWith(`${name}|`)));
  }
  return out;
}

function bakeCharacter(type: UnitType, root: THREE.Object3D, clips: THREE.AnimationClip[]): UnitModel {
  root.updateMatrixWorld(true);
  const R = root.matrixWorld.clone();
  const Rinv = R.clone().invert();
  const skinned: THREE.SkinnedMesh[] = [];
  const rigid: THREE.Mesh[] = [];
  const skinnedLod: THREE.SkinnedMesh[] = [];
  const rigidLod: THREE.Mesh[] = [];
  root.traverse((o) => {
    const lod = o.name.endsWith('__lod');
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) (lod ? skinnedLod : skinned).push(o as THREE.SkinnedMesh);
    else if ((o as THREE.Mesh).isMesh) (lod ? rigidLod : rigid).push(o as THREE.Mesh);
  });
  if (!skinned.length) throw new Error(`${type}: no skinned meshes`);
  // Skinned vertices: world = G * sum_i w_i * (bone_i.matrixWorld * boneInverse_i) * bindMatrix * v,
  // where G = mesh.matrixWorld * bindMatrixInverse (three's "attached" bind mode). G must be shared.
  const G = skinned[0]!.matrixWorld.clone().multiply(skinned[0]!.bindMatrixInverse);
  for (const m of skinned) {
    const g = m.matrixWorld.clone().multiply(m.bindMatrixInverse);
    if (!g.elements.every((e, i) => Math.abs(e - G.elements[i]!) < 1e-4)) throw new Error(`${type}: skinned parts disagree on bind space`);
  }
  const Ginv = G.clone().invert();
  /** Bake entries: skeleton bones (skinned vertices) and attachment bones (rigid parts), kept separate. */
  type Entry = { obj: THREE.Object3D; inv: THREE.Matrix4; rigid: boolean };
  const entries: Entry[] = [];
  // Each skinned part has its own skin; the same bone can carry a different inverse bind per skin.
  const skinEntry = new Map<string, number>();
  const rigidEntry = new Map<THREE.Object3D, number>();
  const skinIndexOf = (b: THREE.Bone, inv: THREE.Matrix4) => {
    const k = `${b.uuid}:${inv.elements.map((e) => e.toFixed(5)).join(',')}`;
    let i = skinEntry.get(k);
    if (i === undefined) {
      i = entries.push({ obj: b, inv: inv.clone(), rigid: false }) - 1;
      skinEntry.set(k, i);
    }
    return i;
  };
  const rigidIndexOf = (b: THREE.Object3D) => {
    let i = rigidEntry.get(b);
    if (i === undefined) {
      // Rest pose as loaded, before any animation runs.
      i = entries.push({ obj: b, inv: b.matrixWorld.clone().invert(), rigid: true }) - 1;
      rigidEntry.set(b, i);
    }
    return i;
  };

  /** Flatten parts into one geometry in root-local bind space, bound to the shared bake entries. */
  const flatten = (skinnedParts: THREE.SkinnedMesh[], rigidParts: THREE.Mesh[]) => {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const si: number[] = [];
    const sw: number[] = [];
    const idx: number[] = [];
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, skin: (i: number) => [number[], number[]]) => {
      const P = g.attributes.position!;
      const N = g.attributes.normal;
      const U = g.attributes.uv;
      const nm = new THREE.Matrix3().getNormalMatrix(m);
      const base = pos.length / 3;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
        if (N) {
          n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
          nor.push(n.x, n.y, n.z);
        } else nor.push(0, 1, 0);
        uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
        const [a, w] = skin(i);
        si.push(...a);
        sw.push(...w);
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
      else for (let i = 0; i < P.count; i++) idx.push(i + base);
    };
    for (const m of skinnedParts) {
      const remap = m.skeleton.bones.map((b, i) => skinIndexOf(b, m.skeleton.boneInverses[i]!));
      const SI = m.geometry.attributes.skinIndex!;
      const SW = m.geometry.attributes.skinWeight!;
      // v_bind = Rinv * G * bindMatrix * v; paired with F = Rinv * G * boneW * boneInv * Ginv * R.
      add(m.geometry, Rinv.clone().multiply(G).multiply(m.bindMatrix), (i) => [
        [remap[SI.getX(i)]!, remap[SI.getY(i)]!, remap[SI.getZ(i)]!, remap[SI.getW(i)]!],
        [SW.getX(i), SW.getY(i), SW.getZ(i), SW.getW(i)],
      ]);
    }
    const skinnedVertexCount = pos.length / 3;
    for (const m of rigidParts) {
      const b = nearestBone(m);
      if (!b) continue;
      const bi = rigidIndexOf(b);
      // v_bind = Rinv * mesh.matrixWorld(rest) * v; paired with F = Rinv * boneW * boneW(rest)^-1 * R.
      add(m.geometry, Rinv.clone().multiply(m.matrixWorld), () => [
        [bi, 0, 0, 0],
        [1, 0, 0, 0],
      ]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('aSkinIndex', new THREE.Float32BufferAttribute(si, 4));
    geometry.setAttribute('aSkinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geometry.setIndex(idx);
    return { geometry, pos, si, sw, skinnedVertexCount };
  };
  const full = flatten(skinned, rigid);
  const lod = skinnedLod.length ? flatten(skinnedLod, rigidLod) : full;
  const { geometry, pos, si, sw, skinnedVertexCount } = full;
  const v = new THREE.Vector3();

  // Bake every frame of each clip the game uses.
  const mixer = new THREE.AnimationMixer(root);
  const src = CLIP_SOURCES[type];
  const plan = (Object.keys(src) as ClipName[]).map((k) => {
    const clip = clips.find((c) => c.name === `${MODEL_OF[type]}|${src[k]}`);
    if (!clip) throw new Error(`${type}: clip ${src[k]} missing from the model file`);
    return { k, clip, frames: Math.max(2, Math.round(clip.duration * BAKE_FPS)) };
  });
  const totalRows = plan.reduce((s, p) => s + p.frames, 0);
  const width = entries.length * 4;
  const data = new Float32Array(width * totalRows * 4);
  const F = new THREE.Matrix4();
  const clipsOut = {} as Record<ClipName, BakedClip>;
  let row = 0;
  for (const p of plan) {
    mixer.stopAllAction();
    const action = mixer.clipAction(p.clip);
    action.play();
    clipsOut[p.k] = { start: row, frames: p.frames, duration: p.clip.duration };
    for (let f = 0; f < p.frames; f++) {
      mixer.setTime((f / p.frames) * p.clip.duration);
      root.updateMatrixWorld(true);
      entries.forEach((e, b) => {
        if (e.rigid) F.copy(Rinv).multiply(e.obj.matrixWorld).multiply(e.inv).multiply(R);
        else F.copy(Rinv).multiply(G).multiply(e.obj.matrixWorld).multiply(e.inv).multiply(Ginv).multiply(R);
        data.set(F.elements, (row * width + b * 4) * 4);
      });
      row++;
    }
  }
  mixer.stopAllAction();

  // Size and anchor from the first Idle frame as actually posed (bind space is not a pose).
  // Feet: centre of the body (skinned parts, weapons excluded) at its lowest point.
  const body = new THREE.Box3();
  const idleRow = clipsOut.idle.start;
  const M = new THREE.Matrix4();
  const acc = new THREE.Vector3();
  for (let i = 0; i < skinnedVertexCount; i++) {
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw[i * 4 + k]!;
      if (!w) continue;
      M.fromArray(data, (idleRow * width + si[i * 4 + k]! * 4) * 4);
      acc.addScaledVector(v.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!).applyMatrix4(M), w);
    }
    body.expandByPoint(acc);
  }
  const scale = UNIT_HEIGHT / Math.max(0.01, body.max.y - body.min.y);
  const feet = new THREE.Vector3((body.min.x + body.max.x) / 2, body.min.y, (body.min.z + body.max.z) / 2);
  const bake = new THREE.DataTexture(data, width, totalRows, THREE.RGBAFormat, THREE.FloatType);
  bake.magFilter = THREE.NearestFilter;
  bake.minFilter = THREE.NearestFilter;
  bake.generateMipmaps = false;
  bake.needsUpdate = true;
  return { type, geometry, lodGeometry: lod.geometry, bake, clips: clipsOut, bones: entries.length, scale, feet };
}

/** Standard material that skins vertices from the baked texture, per instance. */
export function bakedMaterial(model: UnitModel, map: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.75, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBake = { value: model.bake };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2D uBake;
attribute vec4 aSkinIndex;
attribute vec4 aSkinWeight;
attribute vec3 aFrame;
mat4 crBone(int row, float b) {
  int x = int(b + 0.5) * 4;
  return mat4(texelFetch(uBake, ivec2(x, row), 0), texelFetch(uBake, ivec2(x + 1, row), 0),
              texelFetch(uBake, ivec2(x + 2, row), 0), texelFetch(uBake, ivec2(x + 3, row), 0));
}
mat4 crSkin(int row) {
  return aSkinWeight.x * crBone(row, aSkinIndex.x) + aSkinWeight.y * crBone(row, aSkinIndex.y)
       + aSkinWeight.z * crBone(row, aSkinIndex.z) + aSkinWeight.w * crBone(row, aSkinIndex.w);
}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `mat4 crM = crSkin(int(aFrame.x + 0.5)) * (1.0 - aFrame.z) + crSkin(int(aFrame.y + 0.5)) * aFrame.z;
vec3 objectNormal = normalize(mat3(crM) * normal);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = (crM * vec4(position, 1.0)).xyz;');
  };
  mat.customProgramCacheKey = () => `baked-${model.type}`;
  return withFog(mat);
}

/** Row pair and blend for a clip at a time (seconds), looping or held on the last frame. */
export function frameAt(clip: BakedClip, t: number, loop = true): [number, number, number] {
  const f = (t / clip.duration) * clip.frames;
  if (!loop && f >= clip.frames - 1) return [clip.start + clip.frames - 1, clip.start + clip.frames - 1, 0];
  const i = Math.floor(f);
  const a = ((i % clip.frames) + clip.frames) % clip.frames;
  const b = loop ? (a + 1) % clip.frames : Math.min(a + 1, clip.frames - 1);
  return [clip.start + a, clip.start + b, f - i];
}

/** Chess-piece tokens for the strategic zoom: pawns for infantry, bishops for archers (as on the War Table). */
export function tokenGeometry(type: UnitType): THREE.BufferGeometry {
  const pawn: [number, number][] = [
    [0, 0], [0.36, 0], [0.36, 0.07], [0.28, 0.12], [0.2, 0.18], [0.14, 0.42], [0.22, 0.47], [0.13, 0.52], [0.2, 0.6], [0.2, 0.7], [0.12, 0.79], [0, 0.82],
  ];
  const bishop: [number, number][] = [
    [0, 0], [0.36, 0], [0.36, 0.07], [0.28, 0.12], [0.18, 0.2], [0.12, 0.5], [0.22, 0.56], [0.12, 0.6], [0.17, 0.7], [0.19, 0.82], [0.14, 0.95], [0.07, 1.02], [0.08, 1.06], [0, 1.1],
  ];
  const pts = (type === 'infantry' ? pawn : bishop).map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 14);
  g.computeVertexNormals();
  return g;
}
