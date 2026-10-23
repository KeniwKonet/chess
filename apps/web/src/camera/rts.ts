/**
 * RTS camera model, independent of three.js and React so it can be unit tested.
 *
 * The camera orbits a ground target (x, z) at a distance. Pitch is tied to
 * zoom: close up it lowers toward the horizon for detail, far out it rises
 * toward top-down for a strategic read. Yaw is free but snaps back to north
 * on request. Input writes to `goal`; `step()` eases `current` toward it.
 */
export interface CamPose {
  x: number;
  z: number;
  /** Radians. 0 = looking north (toward -z). */
  yaw: number;
  /** Distance from target. */
  dist: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const ZOOM_MIN = 14;
export const ZOOM_MAX = 92;
export const PITCH_NEAR = (44 * Math.PI) / 180;
export const PITCH_FAR = (66 * Math.PI) / 180;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 0 when fully zoomed in, 1 when fully zoomed out. */
export const zoomT = (dist: number) => clamp((dist - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN), 0, 1);

export function pitchFor(dist: number): number {
  const t = zoomT(dist);
  // Ease so most of the tilt change happens at the close end.
  const e = 1 - (1 - t) * (1 - t);
  return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * e;
}

/** World-space camera position for a pose. */
export function eye(p: CamPose): { x: number; y: number; z: number } {
  const pitch = pitchFor(p.dist);
  const h = Math.cos(pitch) * p.dist;
  return {
    x: p.x + Math.sin(p.yaw) * h,
    y: Math.sin(pitch) * p.dist,
    z: p.z + Math.cos(p.yaw) * h,
  };
}

/** Ground-plane unit vectors for screen right and screen up (away from camera). */
export function axes(yaw: number) {
  return {
    right: { x: Math.cos(yaw), z: -Math.sin(yaw) },
    forward: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
  };
}

export function clampPose(p: CamPose, b: Bounds, margin = 2): CamPose {
  return {
    x: clamp(p.x, b.minX - margin, b.maxX + margin),
    z: clamp(p.z, b.minZ - margin, b.maxZ + margin),
    yaw: p.yaw,
    dist: clamp(p.dist, ZOOM_MIN, ZOOM_MAX),
  };
}

/** Pan by screen-relative amounts (in world units along screen right / up). */
export function panScreen(p: CamPose, right: number, up: number): CamPose {
  const a = axes(p.yaw);
  return { ...p, x: p.x + a.right.x * right + a.forward.x * up, z: p.z + a.right.z * right + a.forward.z * up };
}

/**
 * Zoom by a factor while keeping a ground point (under the cursor) fixed on screen.
 * Exact for the target point; approximate elsewhere because pitch also changes.
 */
export function zoomAt(p: CamPose, factor: number, anchor?: { x: number; z: number }): CamPose {
  const dist = clamp(p.dist * factor, ZOOM_MIN, ZOOM_MAX);
  const k = 1 - dist / p.dist;
  if (!anchor) return { ...p, dist };
  return { ...p, dist, x: p.x + (anchor.x - p.x) * k, z: p.z + (anchor.z - p.z) * k };
}

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Frame-rate independent easing of current toward goal. Returns true while still moving. */
export function step(current: CamPose, goal: CamPose, dt: number, sharpness = 10): boolean {
  const a = 1 - Math.exp(-sharpness * dt);
  current.x += (goal.x - current.x) * a;
  current.z += (goal.z - current.z) * a;
  current.dist += (goal.dist - current.dist) * a;
  current.yaw += angleDelta(current.yaw, goal.yaw) * a;
  return (
    Math.abs(goal.x - current.x) > 1e-3 ||
    Math.abs(goal.z - current.z) > 1e-3 ||
    Math.abs(goal.dist - current.dist) > 1e-3 ||
    Math.abs(angleDelta(current.yaw, goal.yaw)) > 1e-4
  );
}

/** Intersect a ray with the ground plane y = h. */
export function rayGround(
  o: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
  h = 0,
): { x: number; z: number } | null {
  if (Math.abs(d.y) < 1e-6) return null;
  const t = (h - o.y) / d.y;
  if (t < 0) return null;
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}
