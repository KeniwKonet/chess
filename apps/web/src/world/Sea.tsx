/**
 * Stylised sea around the island: depth tint and an animated foam line that
 * follows the actual coastline (from a distance field baked once from the map).
 */
import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { toWorld } from '@cr/game-core';
import { realm } from '../game';

const SIZE = 420;
const RES = 192;
export const SEA_LEVEL = -0.42;

function bakeDistance(): { tex: THREE.DataTexture; origin: [number, number]; span: number } {
  const b = realm.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 30;
  const ox = (b.minX + b.maxX) / 2 - span / 2;
  const oz = (b.minZ + b.maxZ) / 2 - span / 2;
  const data = new Uint8Array(RES * RES);
  const centres = realm.cells.map(toWorld);
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const x = ox + ((i + 0.5) / RES) * span;
      const z = oz + ((j + 0.5) / RES) * span;
      let d = Infinity;
      for (const c of centres) {
        const dd = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (dd < d) d = dd;
      }
      // Distance from the tile edge (≈ centre distance - 1), in units, capped at 12.
      data[j * RES + i] = Math.round((Math.min(Math.max(Math.sqrt(d) - 1, 0), 12) / 12) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, origin: [ox, oz], span };
}

export function Sea() {
  const material = useMemo(() => {
    const { tex, origin, span } = bakeDistance();
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDist: { value: tex },
        uOrigin: { value: new THREE.Vector2(...origin) },
        uSpan: { value: span },
        uShallow: { value: new THREE.Color('#4FC3E8') },
        uDeep: { value: new THREE.Color('#1E6FB8') },
        uFoam: { value: new THREE.Color('#F4FBFF') },
        uFogColor: { value: new THREE.Color('#9CCFEA') },
        uFogNear: { value: 60 },
        uFogFar: { value: 200 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying float vDepth;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vec4 mv = viewMatrix * w;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uDist; uniform vec2 uOrigin; uniform float uSpan;
        uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uFoam;
        uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar;
        varying vec3 vWorld; varying float vDepth;
        void main() {
          vec2 uv = (vWorld.xz - uOrigin) / uSpan;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float d = mix(1.0, texture2D(uDist, uv).r, inside) * 12.0;
          vec3 col = mix(uShallow, uDeep, smoothstep(0.2, 9.0, d));
          // Gentle sun glints drifting across the water.
          float w = sin(vWorld.x * 0.21 + vWorld.z * 0.12 + uTime * 0.6) + sin(vWorld.z * 0.27 - uTime * 0.45);
          col += 0.03 * smoothstep(1.2, 2.0, w);
          // Foam bands that pulse outward from the shore.
          float wobble = sin(vWorld.x * 1.3 + uTime * 1.1) * 0.12 + sin(vWorld.z * 1.7 - uTime * 0.9) * 0.1;
          float band1 = 1.0 - smoothstep(0.0, 0.18, abs(d - (0.25 + wobble)));
          float pulse = fract(uTime * 0.18);
          float band2 = (1.0 - smoothstep(0.0, 0.14, abs(d - (0.6 + pulse * 1.8 + wobble)))) * (1.0 - pulse);
          col = mix(col, uFoam, clamp(band1 * 0.9 + band2 * 0.55, 0.0, 1.0));
          float fog = smoothstep(uFogNear, uFogFar, vDepth);
          gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
          #include <colorspace_fragment>
        }`,
    });
  }, []);

  useFrame((state) => {
    material.uniforms.uTime!.value = state.clock.elapsedTime;
    const fog = state.scene.fog as THREE.Fog | null;
    if (fog) {
      material.uniforms.uFogNear!.value = fog.near;
      material.uniforms.uFogFar!.value = fog.far;
    }
  });

  const c = { x: (realm.bounds.minX + realm.bounds.maxX) / 2, z: (realm.bounds.minZ + realm.bounds.maxZ) / 2 };
  return (
    <mesh rotation-x={-Math.PI / 2} position={[c.x, SEA_LEVEL, c.z]} material={material} renderOrder={-1}>
      <planeGeometry args={[SIZE, SIZE, 1, 1]} />
    </mesh>
  );
}
