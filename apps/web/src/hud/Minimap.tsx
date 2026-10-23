/**
 * North-up minimap drawn from the same map data as the 3D world. The base
 * layer is painted once; the camera footprint is redrawn each animation frame
 * outside React.
 */
import { useEffect, useRef } from 'react';
import { CIRCUMRADIUS, toWorld } from '@cr/game-core';
import { realm, buildingModel } from '../game';
import { cam, flyTo } from '../camera/camera';
import { useUi } from '../state/ui';

const W = 232;
const PAD = 6;
const b = realm.bounds;
const scale = (W - PAD * 2) / (b.maxX - b.minX);
const H = Math.round((b.maxZ - b.minZ) * scale + PAD * 2);
const toMap = (x: number, z: number) => ({ x: PAD + (x - b.minX) * scale, y: PAD + (z - b.minZ) * scale });
const toWorldPt = (mx: number, my: number) => ({ x: (mx - PAD) / scale + b.minX, z: (my - PAD) / scale + b.minZ });

const TERRAIN = { grass: '#8DBA45', forest: '#3F7F3A', hill: '#A2B85A', mountain: '#8E8A80', field: '#E3B54F', water: '#3E8FD0' };
const SIDE = { sun: '#F2C14E', moon: '#6FA8FF', neutral: '#EADFC8' };

function paintBase(): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = '#2A6FAE';
  g.fillRect(0, 0, W, H);
  const r = CIRCUMRADIUS * scale * 1.02;
  const hex = (x: number, y: number, rr: number) => {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
  };
  for (const cell of realm.cells) {
    const w = toWorld(cell);
    const p = toMap(w.x, w.z);
    g.fillStyle = cell.river && !cell.bridge && !cell.ford ? '#3E8FD0' : cell.road || cell.bridge || cell.ford ? '#D9B27C' : TERRAIN[cell.terrain];
    hex(p.x, p.y, r);
    g.fill();
  }
  for (const cp of realm.captures) {
    const w = toWorld(cp);
    const p = toMap(w.x, w.z);
    g.strokeStyle = SIDE[cp.owner];
    g.lineWidth = 1.5;
    g.setLineDash([3, 2]);
    g.beginPath();
    g.arc(p.x, p.y, (cp.radius * 2 + 0.6) * scale, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }
  for (const bd of realm.buildings) {
    const w = toWorld(bd);
    const p = toMap(w.x, w.z);
    const s = bd.type === 'castle' ? 7 : buildingModel(bd).height > 2 ? 4.5 : 3.5;
    g.fillStyle = bd.type === 'rubble' ? '#5A4A3A' : SIDE[bd.side];
    g.strokeStyle = '#1A140E';
    g.lineWidth = 1;
    g.beginPath();
    g.rect(p.x - s / 2, p.y - s / 2, s, s);
    g.fill();
    g.stroke();
  }
  return c;
}

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const addLog = useUi((s) => s.addLog);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext('2d')!;
    const base = paintBase();
    let raf = 0;
    const draw = () => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(base, 0, 0);
      g.scale(dpr, dpr);
      const fp = cam.footprint;
      if (fp.length === 4) {
        g.beginPath();
        fp.forEach((pt, i) => {
          const p = toMap(pt.x, pt.z);
          if (i === 0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        });
        g.closePath();
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fill();
        g.strokeStyle = '#FFFFFF';
        g.lineWidth = 1.5;
        g.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = toWorldPt(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H);
    flyTo({ x: w.x, z: w.z });
  };

  return (
    <div className="minimap panel">
      <canvas
        ref={ref}
        style={{ width: W, height: H }}
        aria-label="Minimap. Click or drag to move the camera."
        role="img"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          jump(e);
        }}
        onPointerMove={(e) => dragging.current && jump(e)}
        onPointerUp={() => {
          if (dragging.current) addLog('Camera moved from the minimap', 'system');
          dragging.current = false;
        }}
      />
      <Compass />
    </div>
  );
}

function Compass() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.style.setProperty('--yaw', `${(cam.current.yaw * 180) / Math.PI}deg`);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <button
      ref={ref}
      className="compass"
      title="Face north (N)"
      aria-label="Face north"
      onClick={() => flyTo({ yaw: Math.round(cam.goal.yaw / (Math.PI * 2)) * Math.PI * 2 })}
    >
      <span>N</span>
    </button>
  );
}

export const MINIMAP_SIZE = { W, H };
