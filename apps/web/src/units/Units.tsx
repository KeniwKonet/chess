import { useEffect, useMemo } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { UNIT_DEFS, type UnitType } from '@cr/game-core';
import { advance, game, renderPos } from '../sim/runner';
import { useUi } from '../state/ui';
import { cam } from '../camera/camera';
import { zoomT } from '../camera/rts';
import { bakedMaterial, buildUnitModels, frameAt, tokenGeometry, unitTextureUrl, UNITS_URL, type ClipName } from './unitKit';

const SIDES = ['sun', 'moon'] as const;
const TYPES: UnitType[] = ['infantry', 'archer'];
const CAP = 64;
/** Above this zoom level soldiers are drawn as chess-piece tokens. */
export const TOKEN_ZOOM = 0.55;
const SIDE_COLOUR = { sun: new THREE.Color('#E8B33A'), moon: new THREE.Color('#5B9BF0') };

/**
 * Ticks the simulation. Mounted even when models fail to load, so the game still runs.
 * Negative priority: runs before every other frame callback, so models, rings and
 * labels all read the same interpolated positions in a frame (R3F keeps rendering
 * automatically for priorities <= 0).
 */
export function SimDriver() {
  useFrame((_, dt) => advance(dt), -1);
  return null;
}

/** Set once the soldier models have loaded; until then (or if they fail) everyone is drawn as a token. */
export const unitAssets = { ready: false };

export function Units() {
  const gltf = useLoader(GLTFLoader, UNITS_URL, (l) => void l.setMeshoptDecoder(MeshoptDecoder));
  const textures = useLoader(
    THREE.TextureLoader,
    TYPES.flatMap((t) => SIDES.map((s) => unitTextureUrl(t, s))),
  );
  const models = useMemo(() => buildUnitModels(gltf), [gltf]);

  const layers = useMemo(() => {
    const out: { type: UnitType; side: 'sun' | 'moon'; lod: boolean; mesh: THREE.InstancedMesh; frame: THREE.InstancedBufferAttribute }[] = [];
    let k = 0;
    for (const type of TYPES) {
      for (const side of SIDES) {
        const tex = textures[k++]!;
        for (const lod of [false, true]) {
        tex.flipY = false; // glTF UV convention
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const model = models[type];
        const geo = (lod ? model.lodGeometry : model.geometry).clone();
        const frame = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
        frame.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aFrame', frame);
        const mesh = new THREE.InstancedMesh(geo, bakedMaterial(model, tex), CAP);
        mesh.name = `units:${type}:${side}${lod ? ':lod' : ''}`;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        out.push({ type, side, lod, mesh, frame });
        }
      }
    }
    return out;
  }, [models, textures]);

  useEffect(() => {
    unitAssets.ready = true;
    document.body.dataset.units = '1';
    return () => void (unitAssets.ready = false);
  }, []);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const Y = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const p3 = useMemo(() => new THREE.Vector3(), []);
  const s3 = useMemo(() => new THREE.Vector3(), []);
  const feetOffset = useMemo(
    () => ({
      infantry: new THREE.Matrix4().makeTranslation(-models.infantry.feet.x, -models.infantry.feet.y, -models.infantry.feet.z),
      archer: new THREE.Matrix4().makeTranslation(-models.archer.feet.x, -models.archer.feet.y, -models.archer.feet.z),
    }),
    [models],
  );

  const frustum = useMemo(() => new THREE.Frustum(), []);
  const pv = useMemo(() => new THREE.Matrix4(), []);
  const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 0.7), []);

  useFrame(({ camera }) => {
    const tokensOn = zoomT(cam.current.dist) > TOKEN_ZOOM;
    for (const l of layers) l.mesh.count = 0;
    if (!tokensOn) {
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      // Full detail close to the camera; the simplified soldier further out.
      const lodDist = useUi.getState().quality === 'high' ? 26 : 17;
      for (const u of game.sim.units) {
        if (u.hp <= 0) continue;
        const p = renderPos(u);
        sphere.center.set(p.x, 0.4, p.z);
        if (!frustum.intersectsSphere(sphere)) continue;
        const lod = camera.position.distanceTo(sphere.center) > lodDist;
        const l = layers.find((x) => x.type === u.type && x.side === u.side && x.lod === lod)!;
        const model = models[u.type];
        const i = l.mesh.count++;
        q.setFromAxisAngle(Y, p.facing);
        m4.compose(p3.set(p.x, 0, p.z), q, s3.setScalar(model.scale));
        m4.multiply(feetOffset[u.type]);
        l.mesh.setMatrixAt(i, m4);
        // Animation: idle, or walk/run matched to how far the unit moved this tick.
        const speed = u.moved / 0.1;
        const def = UNIT_DEFS[u.type];
        let clip: ClipName = 'idle';
        let rate = 1;
        if (u.state === 'moving' && speed > 0.05) {
          clip = speed > def.speed * 1.15 ? 'run' : 'walk';
          rate = Math.min(1.8, Math.max(0.6, speed / (clip === 'run' ? def.speed * 1.4 : def.speed)));
        }
        const phase = (u.id * 0.37) % 1;
        const c = model.clips[clip];
        const [a, b, f] = frameAt(c, game.time * rate + phase * c.duration);
        l.frame.setXYZ(i, a, b, f);
      }
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

/**
 * Everything about units that needs no downloaded assets: chess-piece tokens
 * (strategic zoom, or if the soldier models fail), blob shadows, selection
 * rings and move-order markers.
 */
export function UnitMarks() {
  const tokens = useMemo(
    () =>
      TYPES.map((type) => {
        const mesh = new THREE.InstancedMesh(tokenGeometry(type), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), CAP * 2);
        mesh.name = `tokens:${type}`;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        return { type, mesh };
      }),
    [],
  );

  const shadows = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const geo = new THREE.PlaneGeometry(0.8, 0.8);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }), CAP * 2);
    mesh.name = 'units:blob-shadows';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
  }, []);

  const rings = useMemo(() => {
    const geo = new THREE.RingGeometry(0.3, 0.38, 24);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }), CAP * 2);
    mesh.name = 'units:selection';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return mesh;
  }, []);

  const markerMeshes = useMemo(() => {
    const geo = new THREE.RingGeometry(0.55, 0.7, 32);
    geo.rotateX(-Math.PI / 2);
    return Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#8CF08C', transparent: true, depthWrite: false, toneMapped: false }));
      m.visible = false;
      m.renderOrder = 4;
      return m;
    });
  }, []);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const p3 = useMemo(() => new THREE.Vector3(), []);
  const s3 = useMemo(() => new THREE.Vector3(), []);
  const white = useMemo(() => new THREE.Color('#FFFFFF'), []);

  useFrame(() => {
    const tokensOn = zoomT(cam.current.dist) > TOKEN_ZOOM || !unitAssets.ready;
    const ui = useUi.getState();
    const selected = new Set(ui.selectedUnits);
    for (const t of tokens) t.mesh.count = 0;
    shadows.count = 0;
    rings.count = 0;
    for (const u of game.sim.units) {
      if (u.hp <= 0) continue;
      const p = renderPos(u);
      m4.makeTranslation(p.x, 0.02, p.z);
      shadows.setMatrixAt(shadows.count++, m4);
      const sel = selected.has(u.id);
      if (sel || ui.hoveredUnit === u.id) {
        const r = (sel ? 1 : 0.85) * (tokensOn ? 1.5 : 1);
        m4.makeScale(r, 1, r).setPosition(p.x, 0.035, p.z);
        rings.setMatrixAt(rings.count, m4);
        rings.setColorAt(rings.count, sel ? SIDE_COLOUR[u.side] : white);
        rings.count++;
      }
      if (tokensOn) {
        const t = tokens.find((x) => x.type === u.type)!;
        m4.compose(p3.set(p.x, 0, p.z), q.identity(), s3.setScalar(1.25));
        t.mesh.setMatrixAt(t.mesh.count, m4);
        t.mesh.setColorAt(t.mesh.count, SIDE_COLOUR[u.side]);
        t.mesh.count++;
      }
    }
    for (const t of tokens) {
      t.mesh.instanceMatrix.needsUpdate = true;
      if (t.mesh.instanceColor) t.mesh.instanceColor.needsUpdate = true;
    }
    shadows.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;

    // Move-order markers: a ring that shrinks into the target point.
    markerMeshes.forEach((m, i) => {
      const mk = game.markers[game.markers.length - 1 - i];
      if (!mk) {
        m.visible = false;
        return;
      }
      const age = (game.time - mk.t0) / 1.2;
      m.visible = age < 1;
      const s = 1.4 - age * 0.9;
      m.scale.set(s, 1, s);
      m.position.set(mk.x, 0.05, mk.z);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - age);
      mat.color.set(mk.ok ? '#8CF08C' : '#F2C14E');
    });
  });

  return (
    <group>
      {tokens.map((t) => (
        <primitive key={t.mesh.name} object={t.mesh} />
      ))}
      <primitive object={shadows} />
      <primitive object={rings} />
      {markerMeshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  );
}
