/**
 * The single mutable camera instance shared by the 3D rig, the minimap and the
 * overlay. Plain object on purpose: it changes every frame and must not touch
 * React state.
 */
import { toWorld } from '@cr/game-core';
import { realm, buildingById } from '../game';
import { clampPose, type CamPose } from './rts';

const sun = buildingById.get('sun_castle')!;
const home = toWorld(sun);
const centre = { x: (realm.bounds.minX + realm.bounds.maxX) / 2, z: (realm.bounds.minZ + realm.bounds.maxZ) / 2 };

export const HOME_POSE: CamPose = { x: home.x + 4, z: home.z - 1, yaw: 0, dist: 30 };
/**
 * Where a battle opens. On a tall, narrow screen the default framing leaves the
 * soldiers tiny, so portrait phones start closer, centred on the army.
 */
export function homePose(): CamPose {
  const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth * 1.15;
  return portrait ? { ...HOME_POSE, x: home.x + 6.5, dist: 21 } : HOME_POSE;
}
export const OVERVIEW_POSE: CamPose = { x: centre.x, z: centre.z + 2, yaw: 0, dist: 80 };

export const cam = {
  /** Starts on the strategic overview and flies in to Sunspire on load. */
  current: { ...OVERVIEW_POSE, dist: 92 } as CamPose,
  goal: { ...OVERVIEW_POSE } as CamPose,
  /** Ground footprint of the view (four corners, world x/z), for the minimap. */
  footprint: [] as { x: number; z: number }[],
  moving: true,
};

export function flyTo(pose: Partial<CamPose>) {
  cam.goal = clampPose({ ...cam.goal, ...pose }, realm.bounds);
}

declare global {
  interface Window {
    __crCam?: { cam: typeof cam; flyTo: typeof flyTo; jump: (p: Partial<CamPose>) => void };
  }
}
/** Test hook: lets automated checks place the camera precisely. */
if (typeof window !== 'undefined') {
  window.__crCam = { cam, flyTo, jump: (p) => { flyTo(p); cam.current = { ...cam.goal }; } };
}
