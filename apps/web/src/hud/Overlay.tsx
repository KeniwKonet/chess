/**
 * World-anchored DOM labels (place names, building tags, health bars).
 * React renders the elements when selection changes; their screen positions
 * are written directly each frame by <OverlayProjector/> inside the canvas.
 */
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { toWorld } from '@cr/game-core';
import { realm, buildingById, buildingModel } from '../game';
import { useUi } from '../state/ui';
import { cam } from '../camera/camera';
import { zoomT } from '../camera/rts';

interface Anchor {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  /** Visible only within this zoom range (0 = closest, 1 = furthest). */
  minT: number;
  maxT: number;
}
const anchors = new Map<string, Anchor>();

function anchorRef(id: string, x: number, y: number, z: number, minT = 0, maxT = 1) {
  return (el: HTMLElement | null) => {
    if (el) anchors.set(id, { el, x, y, z, minT, maxT });
    else anchors.delete(id);
  };
}

const ownerName = { sun: 'Sun', moon: 'Moon', neutral: 'Unclaimed' } as const;

export function Overlay() {
  const showLabels = useUi((s) => s.showLabels);
  const selected = useUi((s) => s.selected);
  const hovered = useUi((s) => s.hovered);
  const focusIds = new Set<string>();
  if (selected?.kind === 'building') focusIds.add(selected.id);
  if (hovered?.kind === 'building') focusIds.add(hovered.id);

  return (
    <div className="overlay" aria-hidden="true">
      {showLabels &&
        realm.places.map((p) => {
          const w = toWorld(p);
          const cap = realm.captures.find((c) => c.id === p.id);
          if (p.kind === 'capture' || (p.kind === 'crossing' && p.id === 'ford')) return null;
          const range = p.kind === 'region' ? [0.25, 1] : p.kind === 'crossing' ? [0, 0.85] : [0, 1];
          return (
            <div key={p.id} ref={anchorRef(`place:${p.id}`, w.x, p.kind === 'capital' ? 6.8 : 0.6, w.z, range[0], range[1])} className={`tag tag-${p.kind}`}>
              {p.name.replace(/^the /, '')}
              {cap ? '' : null}
            </div>
          );
        })}
      {showLabels &&
        realm.captures.map((c) => {
          const w = toWorld(c);
          return (
            <div key={c.id} ref={anchorRef(`cap:${c.id}`, w.x, 3.2, w.z)} className={`tag tag-capture side-${c.owner}`}>
              <span className="tag-flag" />
              {c.name}
              <small>{c.owner === 'neutral' ? 'Contested' : `Held by ${ownerName[c.owner]}`}</small>
            </div>
          );
        })}
      {realm.buildings
        .filter((b) => b.hp < b.maxHp || focusIds.has(b.id))
        .map((b) => {
          const w = toWorld(b);
          const h = buildingModel(b).height + 0.5;
          const pct = b.maxHp ? Math.round((b.hp / b.maxHp) * 100) : 0;
          const focus = focusIds.has(b.id);
          return (
            <div key={b.id} ref={anchorRef(`b:${b.id}:${focus ? 'f' : 'd'}`, w.x, h, w.z, 0, focus ? 1 : 0.6)} className={`bar side-${b.side}${focus ? ' bar-focus' : ''}`}>
              {focus && <div className="bar-name">{b.name}</div>}
              {b.type === 'rubble' ? (
                <div className="bar-note">Destroyed</div>
              ) : (
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                  {b.progress !== undefined && <div className="bar-build" style={{ width: `${b.progress}%` }} />}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

const v = new THREE.Vector3();
export function OverlayProjector() {
  const { camera, size } = useThree();
  useFrame(() => {
    const t = zoomT(cam.current.dist);
    for (const a of anchors.values()) {
      const inRange = t >= a.minT && t <= a.maxT;
      v.set(a.x, a.y, a.z).project(camera);
      const visible = inRange && v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
      if (!visible) {
        if (a.el.style.visibility !== 'hidden') a.el.style.visibility = 'hidden';
        continue;
      }
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      a.el.style.visibility = 'visible';
      a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  });
  return null;
}

export { buildingById };
