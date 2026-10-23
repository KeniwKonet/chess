import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { toWorld, type Hex } from '@cr/game-core';
import { realm, buildingById, buildingModel, cellByKey } from '../game';
import { useUi } from '../state/ui';
import type { Pick } from '../game';

export const SIDE_HEX = { sun: '#E8B33A', moon: '#5B9BF0', neutral: '#E6DCC3' } as const;

/** Flat hexagon outline lying on the ground (pointy-top, matching the tiles). */
function hexRing(inner: number, outer: number) {
  const g = new THREE.RingGeometry(inner, outer, 6, 1, Math.PI / 6);
  g.rotateX(-Math.PI / 2);
  return g;
}

function pickTarget(p: Pick): { hex: Hex; side: keyof typeof SIDE_HEX; scale: number } | null {
  if (!p) return null;
  if (p.kind === 'building') {
    const b = buildingById.get(p.id);
    if (!b) return null;
    return { hex: b, side: b.side, scale: Math.max(1, buildingModel(b).radius / 0.8) };
  }
  const c = cellByKey.get(p.key);
  return c ? { hex: c, side: 'neutral', scale: 1 } : null;
}

export function SelectionMarkers() {
  const selected = useUi((s) => s.selected);
  const hovered = useUi((s) => s.hovered);
  const sel = pickTarget(selected);
  const hov = pickTarget(hovered);
  const ring = useMemo(() => hexRing(1.02, 1.16), []);
  const thin = useMemo(() => hexRing(1.06, 1.12), []);
  const selRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = selRef.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    const s = (sel?.scale ?? 1) * (1 + Math.sin(t * 4) * 0.025);
    m.scale.set(s, 1, s);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.8 + Math.sin(t * 4) * 0.15;
  });
  const showHover = hov && !(sel && sel.hex.q === hov.hex.q && sel.hex.r === hov.hex.r);
  return (
    <>
      {sel && (
        <mesh ref={selRef} geometry={ring} position={[toWorld(sel.hex).x, 0.04, toWorld(sel.hex).z]} renderOrder={2}>
          <meshBasicMaterial color={SIDE_HEX[sel.side]} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      {showHover && (
        <mesh geometry={thin} position={[toWorld(hov.hex).x, 0.035, toWorld(hov.hex).z]} scale={[hov.scale, 1, hov.scale]} renderOrder={2}>
          <meshBasicMaterial color="#FFFFFF" transparent opacity={0.55} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/** Contested ground: a soft ring for each capture point in the holder's colour. */
export function CaptureRings() {
  const items = useMemo(
    () =>
      realm.captures.map((c) => {
        const w = toWorld(c);
        const r = c.radius * 2 + 0.6;
        const g = new THREE.RingGeometry(r - 0.16, r, 72);
        g.rotateX(-Math.PI / 2);
        const fill = new THREE.CircleGeometry(r - 0.16, 72);
        fill.rotateX(-Math.PI / 2);
        return { id: c.id, w, g, fill, colour: SIDE_HEX[c.owner] };
      }),
    [],
  );
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    mats.current.forEach((m, i) => m && (m.opacity = 0.55 + Math.sin(t * 1.5 + i) * 0.2));
  });
  return (
    <>
      {items.map((it, i) => (
        <group key={it.id} position={[it.w.x, 0.06, it.w.z]}>
          <mesh geometry={it.g} renderOrder={1}>
            <meshBasicMaterial ref={(m) => void (mats.current[i] = m!)} color={it.colour} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh geometry={it.fill} renderOrder={1}>
            <meshBasicMaterial color={it.colour} transparent opacity={0.07} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}
