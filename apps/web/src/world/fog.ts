/**
 * Fog of war on screen. The sim decides what each side can see (game-core,
 * per hex); this turns the player's view into a soft texture over the map and
 * shades every world material by it: visible ground at full brightness,
 * explored ground dimmed, never-seen ground dark. Enemy soldiers outside
 * sight are not drawn at all (see units/Units.tsx).
 */
import * as THREE from 'three';
import { fromWorld, key } from '@cr/game-core';
import { realm } from '../game';

const PER_UNIT = 2; // texels per world unit
const b = realm.bounds;
const W = Math.ceil((b.maxX - b.minX) * PER_UNIT);
const H = Math.ceil((b.maxZ - b.minZ) * PER_UNIT);
const data = new Uint8Array(W * H);
data.fill(255);
const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
tex.magFilter = THREE.LinearFilter;
tex.minFilter = THREE.LinearFilter;
tex.needsUpdate = true;

/** Cell index for every texel, computed once. */
const texelCell = new Int32Array(W * H).fill(-1);
{
  const idx = new Map(realm.cells.map((c, i) => [key(c), i]));
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const h = fromWorld(b.minX + (i + 0.5) / PER_UNIT, b.minZ + (j + 0.5) / PER_UNIT);
      texelCell[j * W + i] = idx.get(key(h)) ?? -1;
    }
  }
}

export const fogUniforms = {
  uFog: { value: tex as THREE.Texture },
  uFogRect: { value: new THREE.Vector4(b.minX, b.minZ, W / PER_UNIT, H / PER_UNIT) },
  uFogOn: { value: 0 },
};

export const FOG_LEVELS = { visible: 255, explored: 135, unknown: 70 };

/** Refresh the texture from the sim's visibility arrays. */
export function updateFog(visible: Uint8Array, explored: Uint8Array) {
  for (let t = 0; t < texelCell.length; t++) {
    const c = texelCell[t]!;
    data[t] = c < 0 ? FOG_LEVELS.explored : visible[c] ? FOG_LEVELS.visible : explored[c] ? FOG_LEVELS.explored : FOG_LEVELS.unknown;
  }
  tex.needsUpdate = true;
}

/** Add fog shading to a material, keeping any shader changes it already has. */
export function withFog<T extends THREE.Material>(mat: T): T {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, fogUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCrFog;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vec4 crWP = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
crWP = instanceMatrix * crWP;
#endif
vCrFog = (modelMatrix * crWP).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uFog;\nuniform vec4 uFogRect;\nuniform float uFogOn;\nvarying vec2 vCrFog;')
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
float crF = texture2D(uFog, (vCrFog - uFogRect.xy) / uFogRect.zw).r;
gl_FragColor.rgb *= mix(1.0, crF, uFogOn);`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|fog`;
  mat.needsUpdate = true;
  return mat;
}
