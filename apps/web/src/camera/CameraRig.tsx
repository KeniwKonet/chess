/**
 * Mouse, keyboard and touch camera control plus hover/selection picking.
 *
 * Bindings (see Help panel):
 *   left-click            select a unit, building or tile;  shift-click adds/removes units
 *   left-drag             box-select your units (shift adds);  double-click a soldier: all of that type in view
 *   right-click           order selected units to that point;  right-drag  pan (ground stays under the pointer)
 *   middle-drag / Alt-drag  rotate;  touch: one finger pans, a tap selects, or orders selected units
 *   wheel / pinch         zoom toward the pointer
 *   two-finger twist      rotate
 *   WASD / arrows         pan;  Q / E rotate;  + / - zoom
 *   H                     return to Sunspire;  O overview;  F focus selection;  N face north
 *   X stop;  Ctrl+A select all;  Ctrl+1-9 set group, 1-9 recall (twice to jump);  Esc clear
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { toWorld } from '@cr/game-core';
import { cam, flyTo, HOME_POSE, OVERVIEW_POSE } from './camera';
import { clampPose, eye, panScreen, rayGround, step, zoomAt, type CamPose } from './rts';
import { pick, realm, buildingById, cellByKey, nearestPlace, TERRAIN_LABEL } from '../game';
import { useUi } from '../state/ui';
import { game, orderMove, orderAttack, orderStop, ownUnits, pickUnit, renderPos, PLAYER, describeUnits, ownSelected, visibleToPlayer } from '../sim/runner';
import { box } from '../hud/BoxSelect';
import { setPaused } from '../hud/Menus';

const CLICK_PX = 6;

/**
 * Effect of holding a camera key for `secs` seconds. Held keys are integrated
 * by wall-clock time (not per rendered frame) so slow devices and quick taps
 * still move the camera the right amount.
 */
function heldKey(k: string, secs: number, g: CamPose): CamPose {
  const pan = g.dist * 1.1 * secs;
  switch (k) {
    case 'a': case 'arrowleft': return panScreen(g, -pan, 0);
    case 'd': case 'arrowright': return panScreen(g, pan, 0);
    case 'w': case 'arrowup': return panScreen(g, 0, pan);
    case 's': case 'arrowdown': return panScreen(g, 0, -pan);
    case 'q': return { ...g, yaw: g.yaw + 1.6 * secs };
    case 'e': return { ...g, yaw: g.yaw - 1.6 * secs };
    case '+': case '=': return zoomAt(g, Math.exp(-1.4 * secs));
    case '-': case '_': return zoomAt(g, Math.exp(1.4 * secs));
    default: return g;
  }
}
const HELD = new Set(['a', 'd', 'w', 's', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'q', 'e', '+', '=', '-', '_']);

export function focusPick(): boolean {
  const ui = useUi.getState();
  if (ui.selectedUnits.length) {
    const us = ui.selectedUnits.map((id) => game.sim.unit(id)).filter((u) => !!u);
    if (us.length) {
      const c = us.reduce((a, u) => ({ x: a.x + u!.x / us.length, z: a.z + u!.z / us.length }), { x: 0, z: 0 });
      flyTo({ x: c.x, z: c.z, dist: Math.min(cam.goal.dist, 22) });
      return true;
    }
  }
  const s = ui.selected;
  if (!s) return false;
  const h = s.kind === 'building' ? buildingById.get(s.id) : cellByKey.get(s.key);
  if (!h) return false;
  const w = toWorld(h);
  flyTo({ x: w.x, z: w.z, dist: Math.min(cam.goal.dist, 24) });
  return true;
}

export function describePick(p: ReturnType<typeof pick>): string {
  if (!p) return '';
  if (p.kind === 'building') {
    const b = buildingById.get(p.id)!;
    return `${b.name} (${b.side === 'sun' ? 'Sun' : b.side === 'moon' ? 'Moon' : 'Neutral'})`;
  }
  const c = cellByKey.get(p.key)!;
  const what = c.bridge ? 'Bridge' : c.ford ? 'Ford' : c.river ? 'River' : c.road ? 'Road' : TERRAIN_LABEL[c.terrain];
  return `${what}, ${nearestPlace(c.q, c.r)}`;
}

export function CameraRig() {
  const { camera, gl, size } = useThree();
  const pointers = useRef(new Map<number, { x: number; y: number; button: number; shift: boolean }>());
  const drag = useRef<{
    mode: 'pan' | 'rotate' | 'touch' | 'box' | null;
    button?: number;
    touch?: boolean;
    shift?: boolean;
    startX: number;
    startY: number;
    moved: boolean;
    t0: number;
    grab?: { x: number; z: number };
    startPose?: CamPose;
    pinch?: { d: number; a: number; mid: { x: number; y: number } };
  }>({ mode: null, startX: 0, startY: 0, moved: false, t0: 0 });
  const keys = useRef(new Map<string, number>());
  const hoverAt = useRef<{ x: number; y: number } | null>(null);
  const intro = useRef(true);
  const lastClick = useRef(0);
  const lastGroup = useRef({ n: 0, t: 0 });
  const lastClickUnit = useRef<number | null>(null);
  const ray = useRef(new THREE.Raycaster());
  const ndc = useRef(new THREE.Vector2());
  const sharp = useRef(2.2);

  // Fly from the overview down to Sunspire once on load.
  useEffect(() => {
    const id = setTimeout(() => {
      if (useUi.getState().screen !== 'title') flyTo(HOME_POSE);
    }, 700);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    // Test hook: world point to page pixels.
    (window as unknown as { __crProject: (x: number, y: number, z: number) => { x: number; y: number } }).__crProject = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const r = gl.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
  }, [camera, gl]);

  useEffect(() => {
    const el = gl.domElement;
    el.style.touchAction = 'none';

    const rayFrom = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      ndc.current.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc.current, camera);
      return ray.current.ray;
    };
    const groundAt = (cx: number, cy: number) => {
      const r = rayFrom(cx, cy);
      return rayGround(r.origin, r.direction, 0);
    };
    const userInput = () => {
      if (intro.current) {
        intro.current = false;
        sharp.current = 10;
        // Take over from wherever the fly-in had got to.
        cam.goal = { ...cam.current };
      }
    };

    const onDown = (e: PointerEvent) => {
      const st = useUi.getState();
      if (st.screen === 'title' || st.paused) return;
      userInput();
      el.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      const d = drag.current;
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        d.mode = 'touch';
        d.moved = true;
        box.active = false;
        d.pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), a: Math.atan2(b!.y - a!.y, b!.x - a!.x), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
        d.startPose = { ...cam.goal };
        return;
      }
      d.touch = e.pointerType === 'touch';
      d.button = e.button;
      // Mouse: left = select (click or box), right = order (click) or pan (drag),
      // middle or Alt+left = rotate. Touch: one finger pans; a tap selects or orders.
      d.mode = e.button === 1 || (e.button === 0 && e.altKey) ? 'rotate' : e.button === 0 && !d.touch ? 'box' : 'pan';
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.moved = false;
      d.shift = e.shiftKey;
      d.t0 = performance.now();
      d.grab = groundAt(e.clientX, e.clientY) ?? undefined;
      d.startPose = { ...cam.goal };
    };

    const onMove = (e: PointerEvent) => {
      hoverAt.current = { x: e.clientX, y: e.clientY };
      const p = pointers.current.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const d = drag.current;
      if (d.mode === 'touch' && pointers.current.size >= 2 && d.pinch && d.startPose) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const ang = Math.atan2(b!.y - a!.y, b!.x - a!.x);
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        let pose: CamPose = { ...d.startPose, yaw: d.startPose.yaw - (ang - d.pinch.a) };
        pose = zoomAt(pose, d.pinch.d / Math.max(dist, 1));
        const k = (pose.dist / size.height) * 1.1;
        pose = panScreen(pose, -(mid.x - d.pinch.mid.x) * k, (mid.y - d.pinch.mid.y) * k);
        cam.goal = clampPose(pose, realm.bounds);
        return;
      }
      if (!d.mode || d.mode === 'touch') return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > CLICK_PX) d.moved = true;
      if (!d.moved || !d.startPose) return;
      if (d.mode === 'box') {
        const r = el.getBoundingClientRect();
        box.active = true;
        box.x0 = d.startX - r.left;
        box.y0 = d.startY - r.top;
        box.x1 = e.clientX - r.left;
        box.y1 = e.clientY - r.top;
        return;
      }
      if (d.mode === 'rotate') {
        cam.goal = { ...d.startPose, yaw: d.startPose.yaw - ((e.clientX - d.startX) / size.width) * Math.PI * 1.6 };
        return;
      }
      // Grab-pan: keep the grabbed ground point under the pointer.
      if (d.grab) {
        const now = groundAt(e.clientX, e.clientY);
        if (now) {
          cam.goal = clampPose({ ...cam.goal, x: cam.goal.x + (d.grab.x - now.x), z: cam.goal.z + (d.grab.z - now.z) }, realm.bounds);
          // Snap current too so the grab stays exact while dragging.
          cam.current.x = cam.goal.x;
          cam.current.z = cam.goal.z;
        }
      }
    };

    /** Screen position of a unit (its chest), in canvas pixels. */
    const v3 = new THREE.Vector3();
    const screenOf = (x: number, z: number) => {
      v3.set(x, 0.35, z).project(camera);
      return { x: ((v3.x + 1) / 2) * size.width, y: ((1 - v3.y) / 2) * size.height, front: v3.z < 1 };
    };

    const finishBox = (shift: boolean) => {
      const ui = useUi.getState();
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
      const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      box.active = false;
      const inside = ownUnits()
        .filter((u) => {
          const p = renderPos(u);
          const s = screenOf(p.x, p.z);
          return s.front && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
        })
        .map((u) => u.id);
      const ids = shift ? [...new Set([...ui.selectedUnits.filter((id) => game.sim.unit(id)?.side === PLAYER), ...inside])] : inside;
      if (!ids.length && !shift) {
        ui.selectUnits([]);
        return;
      }
      ui.selectUnits(ids);
      if (inside.length) ui.addLog(`Selected ${describeUnits(ids)}`, 'sun');
    };

    /** An enemy soldier or standing enemy building under the pointer, if any. */
    const enemyAt = (cx: number, cy: number): import('@cr/game-core').TargetRef | null => {
      const r = rayFrom(cx, cy);
      const uid = pickUnit(r.origin, r.direction);
      if (uid !== null) {
        const u = game.sim.unit(uid)!;
        return u.side !== PLAYER && visibleToPlayer(u) ? { kind: 'unit', id: uid } : null;
      }
      const p = pick(r.origin, r.direction);
      if (p?.kind === 'building') {
        const b = game.sim.building(p.id);
        if (b && !b.destroyed && b.side !== PLAYER && b.side !== 'neutral') return { kind: 'building', id: b.id };
      }
      return null;
    };

    /** Order selected soldiers at a screen point: attack what's there, or move (or attack-move). */
    const orderAt = (cx: number, cy: number, attackMove: boolean): boolean => {
      if (!ownSelected().length) return false;
      const t = enemyAt(cx, cy);
      if (t) return orderAttack(t);
      const g = groundAt(cx, cy);
      return !!g && orderMove(g.x, g.z, attackMove);
    };

    /** Left click / tap: select a unit, or (touch, with your units selected) order them, or inspect. */
    const click = (cx: number, cy: number, shift: boolean, touch: boolean) => {
      const ui = useUi.getState();
      if (ui.attackMode) {
        ui.setAttackMode(false);
        if (orderAt(cx, cy, true)) return;
      }
      // Touch with your soldiers selected: tapping an enemy attacks it.
      if (touch && ownSelected().length) {
        const t = enemyAt(cx, cy);
        if (t && orderAttack(t)) return;
      }
      const r = rayFrom(cx, cy);
      const unitId = pickUnit(r.origin, r.direction);
      const now = performance.now();
      const double = now - lastClick.current < 320;
      lastClick.current = now;
      if (unitId !== null) {
        const u = game.sim.unit(unitId)!;
        lastClickUnit.current = unitId;
        if (double && u.side === PLAYER) {
          // Double-click: everyone of that type in view.
          const ids = ownUnits(u.type)
            .filter((o) => {
              const p = renderPos(o);
              const s = screenOf(p.x, p.z);
              return s.front && s.x >= 0 && s.x <= size.width && s.y >= 0 && s.y <= size.height;
            })
            .map((o) => o.id);
          ui.selectUnits(ids);
          ui.addLog(`Selected ${describeUnits(ids)} in view`, 'sun');
          return;
        }
        if (shift && u.side === PLAYER) {
          const cur = ui.selectedUnits.filter((id) => game.sim.unit(id)?.side === PLAYER);
          ui.selectUnits(cur.includes(unitId) ? cur.filter((id) => id !== unitId) : [...cur, unitId]);
          return;
        }
        ui.selectUnits([unitId]);
        ui.addLog(`Selected ${u.name}${u.side === PLAYER ? '' : ' (enemy)'}`, u.side === PLAYER ? 'sun' : 'moon');
        return;
      }
      const p = pick(r.origin, r.direction);
      if (touch && ownSelected().length && p?.kind !== 'building') {
        const g = groundAt(cx, cy);
        if (g && orderMove(g.x, g.z)) return;
      }
      if (double && p && ui.selected && JSON.stringify(p) === JSON.stringify(ui.selected)) {
        focusPick();
        ui.addLog(`Camera focused on ${describePick(p)}`, 'system');
        return;
      }
      if (!p && ui.selectedUnits.length) {
        ui.selectUnits([]);
        return;
      }
      ui.select(p);
      if (p) ui.addLog(`Selected ${describePick(p)}`, p.kind === 'building' ? (buildingById.get(p.id)?.side === 'moon' ? 'moon' : 'sun') : 'info');
    };

    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      const single = pointers.current.size === 1;
      const quick = performance.now() - d.t0 < 600;
      pointers.current.delete(e.pointerId);
      const mode = d.mode;
      if (pointers.current.size === 0) d.mode = null;
      else if (pointers.current.size === 1) {
        // Continue as a one-finger pan from here.
        const [rest] = [...pointers.current.values()];
        d.mode = 'pan';
        d.startX = rest!.x;
        d.startY = rest!.y;
        d.moved = true;
        d.grab = groundAt(rest!.x, rest!.y) ?? undefined;
        d.startPose = { ...cam.goal };
        return;
      }
      if (!single) return;
      if (mode === 'box' && d.moved && box.active) return finishBox(!!d.shift);
      box.active = false;
      if (d.moved || !quick) return;
      if (d.button === 2) {
        // Right-click: attack the enemy under the pointer, or move there.
        const ui = useUi.getState();
        const attackMove = ui.attackMode;
        ui.setAttackMode(false);
        if (!orderAt(e.clientX, e.clientY, attackMove) && ui.selectedUnits.length) {
          ui.addLog('Those are Moon soldiers: you can inspect them but not command them', 'system');
        }
        return;
      }
      if (d.button === 0 || d.touch) click(e.clientX, e.clientY, !!d.shift, !!d.touch);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userInput();
      const anchor = groundAt(e.clientX, e.clientY) ?? undefined;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      cam.goal = clampPose(zoomAt(cam.goal, Math.exp(delta * 0.0012), anchor), realm.bounds);
    };
    const onLeave = () => {
      hoverAt.current = null;
      useUi.getState().hover(null);
      useUi.getState().hoverUnit(null);
    };
    const onContext = (e: Event) => e.preventDefault();

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      const ui = useUi.getState();
      if (HELD.has(k)) {
        userInput();
        if (!keys.current.has(k)) keys.current.set(k, performance.now());
        if (k.startsWith('arrow')) e.preventDefault();
      }
      if (k === 'h') { userInput(); flyTo(HOME_POSE); ui.addLog('Camera returned to Sunspire', 'system'); }
      if (k === 'o') { userInput(); flyTo(OVERVIEW_POSE); ui.addLog('Strategic overview', 'system'); }
      if (k === 'n') { userInput(); flyTo({ yaw: Math.round(cam.goal.yaw / (Math.PI * 2)) * Math.PI * 2 }); }
      if (k === 'f') { userInput(); if (focusPick()) ui.addLog(ui.selectedUnits.length ? 'Camera focused on the selection' : `Camera focused on ${describePick(ui.selected)}`, 'system'); }
      if (k === 'escape') {
        if (ui.showHelp) ui.toggle('showHelp');
        else if (ui.showSettings) ui.toggle('showSettings');
        else if (ui.attackMode) ui.setAttackMode(false);
        else if (ui.selected || ui.selectedUnits.length) { ui.select(null); ui.selectUnits([]); }
        else if (ui.screen === 'playing' && !ui.result) setPaused(!ui.paused);
      }
      if (k === 'p' && ui.screen === 'playing' && !ui.result) setPaused(!ui.paused);
      if (k === 'b' && ui.screen === 'playing') ui.toggle('showWarTable');
      if (k === 'x') { if (orderStop()) e.preventDefault(); }
      if (k === 't' && ownSelected().length) { ui.setAttackMode(!ui.attackMode); }
      if (k === 'escape' && ui.attackMode) ui.setAttackMode(false);
      if (k === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const ids = ownUnits().map((u) => u.id);
        ui.selectUnits(ids);
        ui.addLog(`Selected all: ${describeUnits(ids)}`, 'sun');
      }
      if (/^[1-9]$/.test(k)) {
        const n = Number(k);
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const ids = ownSelected();
          if (ids.length) {
            game.groups.set(n, ids);
            ui.addLog(`Group ${n} set: ${describeUnits(ids)}`, 'sun');
          }
        } else {
          const ids = (game.groups.get(n) ?? []).filter((id) => (game.sim.unit(id)?.hp ?? 0) > 0);
          if (ids.length) {
            const again = lastGroup.current.n === n && performance.now() - lastGroup.current.t < 400;
            ui.selectUnits(ids);
            if (again) {
              const c = ids.map((id) => game.sim.unit(id)!).reduce((a, u) => ({ x: a.x + u.x / ids.length, z: a.z + u.z / ids.length }), { x: 0, z: 0 });
              userInput();
              flyTo({ x: c.x, z: c.z });
            }
            lastGroup.current = { n, t: performance.now() };
          }
        }
      }
      if (k === '?' || (k === '/' && e.shiftKey)) ui.toggle('showHelp');
      if (k === '`') ui.toggle('showPerf');
      if (k === 'l') ui.toggle('showLabels');
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const since = keys.current.get(k);
      if (since !== undefined) {
        // Credit the time held since the last frame, then release.
        cam.goal = clampPose(heldKey(k, Math.min((performance.now() - since) / 1000, 0.25), cam.goal), realm.bounds);
        keys.current.delete(k);
      }
    };
    const onBlur = () => keys.current.clear();

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [camera, gl, size]);

  const corners = useRef([new THREE.Vector2(-1, -1), new THREE.Vector2(1, -1), new THREE.Vector2(1, 1), new THREE.Vector2(-1, 1)]);
  const hoverTimer = useRef(0);

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    // Held keys, integrated by wall-clock time.
    let goal = cam.goal;
    const now = performance.now();
    for (const [k, since] of keys.current) {
      goal = heldKey(k, Math.min((now - since) / 1000, 0.25), goal);
      keys.current.set(k, now);
    }
    // Edge scrolling.
    const speed = cam.goal.dist * 1.1 * dt;
    let right = 0;
    let up = 0;
    const ui = useUi.getState();
    if (ui.edgeScroll && hoverAt.current && !drag.current.mode) {
      const r = gl.domElement.getBoundingClientRect();
      const m = 18;
      if (hoverAt.current.x - r.left < m) right -= speed;
      if (r.right - hoverAt.current.x < m) right += speed;
      if (hoverAt.current.y - r.top < m) up += speed;
      if (r.bottom - hoverAt.current.y < m) up -= speed;
    }
    if (right || up) goal = panScreen(goal, right, up);
    if (goal !== cam.goal) cam.goal = clampPose(goal, realm.bounds);

    if (intro.current && Math.abs(cam.current.dist - cam.goal.dist) < 0.5 && cam.goal.dist === HOME_POSE.dist) {
      intro.current = false;
      sharp.current = 10;
    }
    cam.moving = step(cam.current, cam.goal, dt, sharp.current);

    // Keep at least ~40 degrees of horizontal view on portrait screens.
    const persp = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(size.height, 1);
    const fov = Math.min(58, Math.max(34, (2 * Math.atan(Math.tan((20 * Math.PI) / 180) / aspect) * 180) / Math.PI));
    if (Math.abs(persp.fov - fov) > 0.01) {
      persp.fov = fov;
      persp.updateProjectionMatrix();
    }

    const e = eye(cam.current);
    camera.position.set(e.x, e.y, e.z);
    camera.lookAt(cam.current.x, 0, cam.current.z);
    camera.updateMatrixWorld();

    const fog = state.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = cam.current.dist * 1.25;
      fog.far = cam.current.dist * 3.4 + 40;
    }

    // Ground footprint for the minimap.
    cam.footprint = corners.current.map((c) => {
      ray.current.setFromCamera(c, camera);
      const g = rayGround(ray.current.ray.origin, ray.current.ray.direction, 0);
      if (g) return g;
      // Corner above the horizon: project far along the view direction instead.
      const d = ray.current.ray.direction;
      return { x: e.x + d.x * 400, z: e.z + d.z * 400 };
    });

    // Hover picking at most ~20 times a second, and not while dragging.
    hoverTimer.current += dt;
    if (hoverAt.current && !drag.current.mode && hoverTimer.current > 0.05) {
      hoverTimer.current = 0;
      const r = gl.domElement.getBoundingClientRect();
      ndc.current.set(((hoverAt.current.x - r.left) / r.width) * 2 - 1, -((hoverAt.current.y - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc.current, camera);
      const uid = pickUnit(ray.current.ray.origin, ray.current.ray.direction);
      ui.hoverUnit(uid);
      const p = uid === null ? pick(ray.current.ray.origin, ray.current.ray.direction) : null;
      ui.hover(p);
      const enemyUnder = (uid !== null && game.sim.unit(uid)?.side !== PLAYER) || (p?.kind === 'building' && game.sim.building(p.id)?.side === 'moon' && !game.sim.building(p.id)?.destroyed);
      const armed = ownSelected().length > 0;
      gl.domElement.style.cursor =
        armed && (enemyUnder || ui.attackMode)
          ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M4 20 L18 6 M14 4 L20 4 L20 10 M4 16 L8 20' stroke='%23F0604F' stroke-width='2.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") 4 20, crosshair`
          : uid !== null || p?.kind === 'building' ? 'pointer' : drag.current.mode === 'pan' ? 'grabbing' : armed ? 'crosshair' : 'default';
    }
  });

  return null;
}
