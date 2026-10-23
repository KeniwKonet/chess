export {};
declare global {
  interface Window {
    __crCam?: { cam: { goal: { x: number; z: number; yaw: number; dist: number } }; jump: (p: object) => void };
    __crPerf?: { calls: number; triangles: number; fps: number };
  }
}
