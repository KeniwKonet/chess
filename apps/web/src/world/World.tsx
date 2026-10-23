import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { toWorld } from '@cr/game-core';
import { buildKit, KIT_URL, liteModel, mergeChunks, windTime, type Kit } from '../assets/kit';
import { realm, buildingById } from '../game';
import { layout } from './layout';
import { useUi, type Quality } from '../state/ui';

export function useKit(): Kit {
  const gltf = useLoader(GLTFLoader, KIT_URL, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
  return useMemo(() => buildKit(gltf), [gltf]);
}

/**
 * Terrain tiles, props and static buildings, merged into map chunks so the
 * whole static world costs a few dozen draw calls and off-screen chunks are culled.
 */
export function World() {
  const kit = useKit();
  const addLog = useUi((s) => s.addLog);
  const quality = useUi((s) => s.quality);
  const built = useMemo(() => {
    const l = layout(realm);
    const lod = (items: typeof l.props) => (quality === 'high' ? items : items.map((it) => ({ ...it, model: liteModel(kit, it.model) })));
    const tiles = mergeChunks(kit, l.tiles, { name: 'tiles', chunk: 16, castShadow: false, receiveShadow: true, ground: true });
    const solids = mergeChunks(kit, [...lod(l.props), ...lod(l.buildings)], { name: 'props', chunk: 16, castShadow: true, receiveShadow: true });
    return { l, groups: [tiles.group, solids.group], missing: [...tiles.missing, ...solids.missing] };
  }, [kit, quality]);
  useEffect(
    () => () => built.groups.forEach((g) => g.traverse((o) => (o as THREE.Mesh).geometry?.dispose())),
    [built],
  );

  useEffect(() => {
    if (built.missing.length) addLog(`Missing models, skipped: ${[...new Set(built.missing)].join(', ')}`, 'system');
  }, [built, addLog]);

  return (
    <group>
      {built.groups.map((g) => (
        <primitive key={g.name} object={g} />
      ))}
      <AnimatedBuildings kit={kit} items={built.l.animated} />
    </group>
  );
}

/**
 * Windmills, the watermill and catapult towers have separate moving parts in
 * the source models. These are turned procedurally here; the models ship no
 * animation clips.
 */
function AnimatedBuildings({ kit, items }: { kit: Kit; items: { id: string; model: string; matrix: THREE.Matrix4 }[] }) {
  const spinners = useRef<{ obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number; base: number }[]>([]);
  const group = useMemo(() => {
    const g = new THREE.Group();
    spinners.current = [];
    items.forEach((it, i) => {
      const src = kit.roots.get(it.model);
      if (!src) return;
      const o = src.clone(true);
      o.matrixAutoUpdate = false;
      o.matrix.copy(it.matrix);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          m.material = kit.material;
        }
        if (/windmill_top_fan/.test(c.name)) spinners.current.push({ obj: c, axis: 'z', speed: 0.9 + i * 0.07, base: c.rotation.z });
        if (/watermill_wheel/.test(c.name)) spinners.current.push({ obj: c, axis: 'x', speed: -0.7, base: c.rotation.x });
        if (/catapult_turret/.test(c.name)) spinners.current.push({ obj: c, axis: 'y', speed: 0, base: c.rotation.y });
      });
      o.userData.buildingId = it.id;
      g.add(o);
    });
    return g;
  }, [kit, items]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    for (const s of spinners.current) {
      // Catapult turrets sweep slowly as if keeping watch; mills turn steadily.
      s.obj.rotation[s.axis] = s.speed === 0 ? s.base + Math.sin(t * 0.35) * 0.6 : s.base + t * s.speed;
    }
  });
  return <primitive object={group} />;
}

/** Lights, fog and shadow configuration per quality level. */
export function Lighting({ quality }: { quality: Quality }) {
  const { gl, scene } = useThree();
  const light = useRef<THREE.DirectionalLight>(null);
  const b = realm.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 4;
  const shadows = quality !== 'low';
  const mapSize = quality === 'high' ? 2048 : 1024;

  useEffect(() => {
    scene.fog = new THREE.Fog('#9CCFEA', 80, 220);
    scene.background = new THREE.Color('#9CCFEA');
  }, [scene]);

  useEffect(() => {
    gl.shadowMap.enabled = shadows;
    gl.shadowMap.type = THREE.PCFShadowMap;
    // Medium renders the (static) shadow map once; high updates it every frame so moving parts cast live shadows.
    gl.shadowMap.autoUpdate = quality === 'high';
    gl.shadowMap.needsUpdate = true;
    const l = light.current;
    if (l) {
      l.shadow.mapSize.set(mapSize, mapSize);
      l.shadow.map?.dispose();
      l.shadow.map = null;
      l.shadow.camera.updateProjectionMatrix();
    }
    // Materials must recompile when shadows toggle.
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    const id = setTimeout(() => (gl.shadowMap.needsUpdate = true), 300);
    return () => clearTimeout(id);
  }, [gl, scene, shadows, quality, mapSize]);

  return (
    <>
      <hemisphereLight args={['#E9F4FF', '#7A8F4A', 1.25]} />
      <directionalLight
        ref={light}
        position={[cx - 34, 52, cz + 30]}
        intensity={2.4}
        color="#FFF1D6"
        castShadow={shadows}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={1}
        shadow-camera-far={160}
      >
        <object3D attach="target" position={[cx, 0, cz]} />
      </directionalLight>
    </>
  );
}

/** Advances the shared wind time used by the foliage shader. */
export function WindClock() {
  useFrame((state) => {
    windTime.value = state.clock.elapsedTime;
  });
  return null;
}

export const castlePos = () => toWorld(buildingById.get('sun_castle')!);
