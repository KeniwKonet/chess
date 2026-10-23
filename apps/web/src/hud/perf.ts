import { useFrame, useThree } from '@react-three/fiber';

/** Renderer stats, written each frame by <PerfProbe/>, read by the Stats panel and tests. */
export const perf = { fps: 0, ms: 0, calls: 0, triangles: 0, geometries: 0, textures: 0, dpr: 1, frames: 0 };

declare global {
  interface Window {
    __crPerf?: typeof perf;
  }
}
if (typeof window !== 'undefined') window.__crPerf = perf;

export function PerfProbe() {
  const { gl } = useThree();
  useFrame((_, dt) => {
    // gl.info holds the previous frame's totals here (it resets at the start of each render).
    perf.calls = gl.info.render.calls;
    perf.triangles = gl.info.render.triangles;
    perf.geometries = gl.info.memory.geometries;
    perf.textures = gl.info.memory.textures;
    perf.dpr = gl.getPixelRatio();
    const ms = dt * 1000;
    perf.ms = perf.ms ? perf.ms * 0.92 + ms * 0.08 : ms;
    perf.fps = 1000 / perf.ms;
    perf.frames++;
  });
  return null;
}
