import { describe, expect, it } from 'vitest';
import { axes, clampPose, eye, pitchFor, panScreen, step, zoomAt, ZOOM_MAX, ZOOM_MIN, rayGround, type CamPose } from '../src/camera/rts';

const base: CamPose = { x: 10, z: 10, yaw: 0, dist: 40 };

describe('RTS camera', () => {
  it('looks down more steeply as it zooms out', () => {
    let last = -Infinity;
    for (let d = ZOOM_MIN; d <= ZOOM_MAX; d += 4) {
      const p = pitchFor(d);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(pitchFor(ZOOM_MIN)).toBeLessThan(pitchFor(ZOOM_MAX));
  });

  it('sits south of the target when facing north, at the right distance', () => {
    const e = eye(base);
    expect(e.z).toBeGreaterThan(base.z);
    expect(e.x).toBeCloseTo(base.x, 6);
    expect(Math.hypot(e.x - base.x, e.y, e.z - base.z)).toBeCloseTo(base.dist, 6);
  });

  it('pans relative to the screen whatever the rotation', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      const p = { ...base, yaw };
      const e = eye(p);
      // Screen-up pan moves the target away from the camera.
      const moved = panScreen(p, 0, 5);
      expect(Math.hypot(moved.x - p.x, moved.z - p.z)).toBeCloseTo(5, 6);
      const toTarget = { x: p.x - e.x, z: p.z - e.z };
      const dir = { x: moved.x - p.x, z: moved.z - p.z };
      expect(toTarget.x * dir.x + toTarget.z * dir.z).toBeGreaterThan(0);
      // Right is perpendicular to forward.
      const a = axes(yaw);
      expect(a.right.x * a.forward.x + a.right.z * a.forward.z).toBeCloseTo(0, 9);
    }
  });

  it('zooms toward the cursor point and respects limits', () => {
    const anchor = { x: 20, z: 4 };
    const z = zoomAt(base, 0.5, anchor);
    expect(z.dist).toBe(20);
    // Target moved halfway toward the anchor.
    expect(z.x).toBeCloseTo(15, 6);
    expect(z.z).toBeCloseTo(7, 6);
    expect(zoomAt(base, 0.01).dist).toBe(ZOOM_MIN);
    expect(zoomAt(base, 100).dist).toBe(ZOOM_MAX);
  });

  it('clamps the target to the map', () => {
    const b = { minX: 0, maxX: 60, minZ: 0, maxZ: 36 };
    const c = clampPose({ x: -50, z: 99, yaw: 0, dist: 500 }, b, 2);
    expect(c).toEqual({ x: -2, z: 38, yaw: 0, dist: ZOOM_MAX });
  });

  it('eases toward the goal without overshoot, independent of frame rate', () => {
    const run = (dt: number) => {
      const cur = { ...base };
      const goal = { x: 30, z: -5, yaw: 3, dist: 20 };
      for (let t = 0; t < 1; t += dt) step(cur, goal, dt);
      return cur;
    };
    const a = run(1 / 30);
    const b = run(1 / 144);
    expect(a.x).toBeCloseTo(b.x, 1);
    expect(a.x).toBeLessThanOrEqual(30);
    expect(a.dist).toBeGreaterThanOrEqual(20);
  });

  it('turns the shortest way around', () => {
    const cur = { ...base, yaw: 3.0 };
    step(cur, { ...base, yaw: -3.0 }, 0.016);
    expect(cur.yaw).toBeGreaterThan(3.0);
  });

  it('finds where a ray meets the ground', () => {
    expect(rayGround({ x: 0, y: 10, z: 0 }, { x: 1, y: -1, z: 0 })).toEqual({ x: 10, z: 0 });
    expect(rayGround({ x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });
});
