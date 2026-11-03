/**
 * The Chess Kingdom 3D scene: light, sky, the battlefield, both armies,
 * highlights for selection and legal moves, the orbit camera and touch/mouse
 * input. Taps go to the controller as squares; the rules decide the rest.
 */
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildKit, KIT_URL, windTime } from '../assets/kit';
import { fogUniforms } from '../world/fog';
import { useUi } from '../state/ui';
import { PerfProbe } from '../hud/perf';
import { BOARD_Y, SQ, squareAt, squarePos } from './board';
import { director } from './director';
import { frame, kc, play, startGame, tapSquare } from './controller';
import { useKingdom } from './store';
import { Plaza, Valley } from './Battlefield';
import { Badges, Characters, Effects, Towers } from './Pieces';

/** Orbit camera state (target is the board centre). */
export const kcam = { yaw: 0, pitch: 0.8, dist: 22, goalYaw: 0, goalPitch: 0.8, goalDist: 22, fit: 22 };

class Boundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error('[Kingdom] assets failed', e);
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

export function KingdomScene() {
  const quality = useUi((s) => s.quality);
  const dpr: [number, number] = quality === 'low' ? [1, 1] : quality === 'medium' ? [1, 1.5] : [1, 2];
  return (
    <Canvas
      key={quality === 'low' ? 'aa-off' : 'aa-on'}
      className="stage"
      dpr={dpr}
      shadows={quality !== 'low'}
      gl={{ antialias: quality !== 'low', powerPreference: 'high-performance' }}
      camera={{ fov: 38, near: 0.5, far: 300, position: [0, 18, 16] }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      <Sky />
      <Lights quality={quality} />
      <Plaza />
      <Boundary>
        <Suspense fallback={null}>
          <KitScene />
        </Suspense>
      </Boundary>
      <Boundary fallback={<Tokens />}>
        <Suspense fallback={<Tokens />}>
          <Characters />
        </Suspense>
      </Boundary>
      <Badges />
      <Effects />
      <Highlights />
      <Driver />
      <CameraRig />
      <Input />
      <PerfProbe />
    </Canvas>
  );
}

function KitScene() {
  const gltf = useLoader(GLTFLoader, KIT_URL, (l) => void l.setMeshoptDecoder(MeshoptDecoder));
  const kit = useMemo(() => buildKit(gltf), [gltf]);
  useEffect(() => {
    document.body.dataset.ready = '1';
    useUi.setState({ loaded: true });
  }, []);
  return (
    <>
      <Valley kit={kit} />
      <Towers kit={kit} />
    </>
  );
}

function Sky() {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color('#a9d4ec');
    scene.fog = new THREE.Fog('#a9d4ec', 38, 95);
    // The battle mode's fog of war shades shared kit materials; it never applies here.
    fogUniforms.uFogOn.value = 0;
  }, [scene]);
  return null;
}

function Lights({ quality }: { quality: string }) {
  const { gl } = useThree();
  const light = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    gl.shadowMap.enabled = quality !== 'low';
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.shadowMap.autoUpdate = true;
  }, [gl, quality]);
  const size = quality === 'high' ? 2048 : 1024;
  return (
    <>
      <hemisphereLight args={['#eef6ff', '#6f8a46', 1.15]} />
      <directionalLight
        ref={light}
        position={[-9, 18, 7]}
        intensity={2.2}
        color="#fff1d6"
        castShadow={quality !== 'low'}
        shadow-mapSize={[size, size]}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={2}
        shadow-camera-far={45}
        shadow-bias={-0.0006}
        shadow-normalBias={0.03}
      />
    </>
  );
}

/** Runs the controller (rules, AI, clocks, director) and the wind. */
function Driver() {
  useFrame((_, dt) => {
    const d = Math.min(dt, 0.1);
    windTime.value += d;
    frame(d);
  }, -1);
  return null;
}

/** Board highlights: selection, legal moves, captures, the last move and a king in check. */
function Highlights() {
  const rev = useKingdom((s) => s.rev);
  const selected = useKingdom((s) => s.selected);
  const targets = useKingdom((s) => s.targets);
  const meshes = useMemo(() => {
    const flat = (r0: number, r1: number) => new THREE.RingGeometry(r0, r1, 40).rotateX(-Math.PI / 2);
    const mat = (c: string, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, toneMapped: false });
    const mk = (geo: THREE.BufferGeometry, m: THREE.Material, n: number) => {
      const x = new THREE.InstancedMesh(geo, m, n);
      x.count = 0;
      x.frustumCulled = false;
      x.renderOrder = 2;
      return x;
    };
    return {
      sel: mk(flat(0.56, 0.72), mat('#ffe7a3', 0.95), 1),
      move: mk(new THREE.CircleGeometry(0.2, 24).rotateX(-Math.PI / 2), mat('#ffe7a3', 0.75), 32),
      take: mk(flat(0.6, 0.78), mat('#ff5a4a', 0.9), 16),
      last: mk(new THREE.PlaneGeometry(SQ * 0.96, SQ * 0.96).rotateX(-Math.PI / 2), mat('#f2c14e', 0.28), 2),
      check: mk(new THREE.CircleGeometry(0.75, 32).rotateX(-Math.PI / 2), mat('#ff3b30', 0.45), 1),
    };
  }, []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const at = (sq: string, y = 0.012) => {
    const p = squarePos(sq);
    return m.makeTranslation(p.x, BOARD_Y + y, p.z);
  };
  useEffect(() => {
    const g = kc.game;
    const { sel, move, take, last } = meshes;
    sel.count = 0;
    move.count = 0;
    take.count = 0;
    last.count = 0;
    if (selected) {
      sel.setMatrixAt(sel.count++, at(selected, 0.02));
      for (const t of targets) {
        if (g.tracker.on(t) || (g.tracker.on(selected)?.role === 'p' && t[0] !== selected[0])) take.setMatrixAt(take.count++, at(t, 0.022));
        else move.setMatrixAt(move.count++, at(t, 0.024));
      }
    }
    const lm = g.history.at(-1);
    if (lm) {
      last.setMatrixAt(last.count++, at(lm.from, 0.006));
      last.setMatrixAt(last.count++, at(lm.to, 0.006));
    }
    for (const x of Object.values(meshes)) x.instanceMatrix.needsUpdate = true;
  }, [rev, selected, targets, meshes]);
  useFrame(() => {
    // A pulsing red glow under a king in check (once the move's scene has played).
    const g = kc.game;
    const c = meshes.check;
    c.count = 0;
    if (!g.over && g.chess.inCheck() && !director.busy) {
      for (const [sq, id] of g.tracker.at) {
        const p = g.tracker.pieces.get(id)!;
        if (p.role === 'k' && p.colour === g.turn) {
          c.setMatrixAt(c.count++, at(sq, 0.01));
          (c.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(performance.now() / 160) * 0.2;
        }
      }
    }
    c.instanceMatrix.needsUpdate = true;
  });
  return (
    <group>
      {Object.values(meshes).map((x) => (
        <primitive key={x.uuid} object={x} />
      ))}
    </group>
  );
}

/** Simple chess tokens, if the character models fail to load. */
function Tokens() {
  const mesh = useMemo(() => {
    const x = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.42, 0.9, 16).translate(0, 0.45, 0), new THREE.MeshStandardMaterial({ roughness: 0.5 }), 40);
    x.frustumCulled = false;
    return x;
  }, []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const c = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    let i = 0;
    for (const p of director.pieces.values()) {
      if (p.fade <= 0 || p.role === 'r') continue;
      m.makeTranslation(p.x, BOARD_Y + p.y - p.sink, p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(p.colour === 'w' ? '#e8b33a' : '#5b9bf0'));
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

/** Camera position for a pose (target sits a little past the centre, toward the enemy). */
function placeCamera(camera: THREE.Camera, yaw: number, pitch: number, dist: number, target: THREE.Vector3) {
  target.set(-Math.sin(yaw) * 0.9, BOARD_Y, -Math.cos(yaw) * 0.9);
  const h = Math.cos(pitch) * dist;
  camera.position.set(target.x + Math.sin(yaw) * h, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * h);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

/**
 * The nearest distance at which the whole board (with its border, and soldiers
 * standing on the far rank) fits between the top and bottom player bars.
 */
function fitDistance(camera: THREE.PerspectiveCamera, yaw: number, pitch: number) {
  const probe = camera.clone();
  const target = new THREE.Vector3();
  const e = 4 * SQ + 0.5;
  const pts = [
    [-e, BOARD_Y, -e], [e, BOARD_Y, -e], [-e, BOARD_Y, e], [e, BOARD_Y, e],
    [-e, BOARD_Y + 1.7, -e], [e, BOARD_Y + 1.7, -e], [-e, BOARD_Y + 1.7, e], [e, BOARD_Y + 1.7, e],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const v = new THREE.Vector3();
  const fits = (d: number) => {
    placeCamera(probe, yaw, pitch, d, target);
    probe.updateProjectionMatrix();
    return pts.every((p) => {
      v.copy(p).project(probe);
      return Math.abs(v.x) < 0.98 && v.y > -0.8 && v.y < 0.8;
    });
  };
  let lo = 6;
  let hi = 90;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function CameraRig() {
  const { camera, size } = useThree();
  const viewFrom = useKingdom((s) => s.viewFrom);
  useEffect(() => {
    kcam.fit = fitDistance(camera as THREE.PerspectiveCamera, 0, kcam.goalPitch);
    kcam.goalDist = kcam.fit;
  }, [size, camera]);
  useEffect(() => {
    kcam.goalYaw = viewFrom === 'w' ? 0 : Math.PI;
    // Take the short way round.
    while (kcam.goalYaw - kcam.yaw > Math.PI) kcam.goalYaw -= Math.PI * 2;
    while (kcam.yaw - kcam.goalYaw > Math.PI) kcam.goalYaw += Math.PI * 2;
  }, [viewFrom]);
  const target = useMemo(() => new THREE.Vector3(0, BOARD_Y, 0.4), []);
  useFrame((_, dt) => {
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 5);
    kcam.yaw += (kcam.goalYaw - kcam.yaw) * k;
    kcam.pitch += (kcam.goalPitch - kcam.pitch) * k;
    kcam.dist += (kcam.goalDist - kcam.dist) * k;
    placeCamera(camera, kcam.yaw, kcam.pitch, kcam.dist, target);
  });
  return null;
}

/** Touch and mouse: tap to select/move, drag to turn the view, pinch or wheel to zoom. */
function Input() {
  const { camera, gl, size } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    el.style.touchAction = 'none';
    const pointers = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; t: number; yaw: number; pitch: number } | null = null;
    let moved = false;
    let pinch: { d: number; dist: number } | null = null;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_Y);
    const hit = new THREE.Vector3();

    const pick = (cx: number, cy: number): string | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // Soldiers first (a tap on a body counts for the square it stands on), nearest wins.
      let best: string | null = null;
      let bestT = Infinity;
      const o = ray.ray.origin;
      const d = ray.ray.direction;
      for (const [sq, id] of kc.game.tracker.at) {
        const v = director.pieces.get(id);
        if (!v || v.fade < 0.5) continue;
        const ox = o.x - v.x;
        const oz = o.z - v.z;
        const A = d.x * d.x + d.z * d.z;
        const B = 2 * (ox * d.x + oz * d.z);
        const C = ox * ox + oz * oz - 0.42 * 0.42;
        const disc = B * B - 4 * A * C;
        if (A < 1e-9 || disc < 0) continue;
        for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
          const y = o.y + d.y * t;
          if (t > 0 && y >= BOARD_Y && y <= BOARD_Y + 1.3 && t < bestT) {
            bestT = t;
            best = sq;
          }
        }
      }
      if (best) return best;
      return ray.ray.intersectPlane(plane, hit) ? squareAt(hit.x, hit.z) : null;
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        start = { x: e.clientX, y: e.clientY, t: performance.now(), yaw: kcam.goalYaw, pitch: kcam.goalPitch };
        moved = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), dist: kcam.goalDist };
        moved = true;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        kcam.goalDist = THREE.MathUtils.clamp((pinch.dist * pinch.d) / Math.max(20, d), kcam.fit * 0.45, kcam.fit * 1.4);
        return;
      }
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 9) moved = true;
      if (moved) {
        kcam.goalYaw = start.yaw - (dx / size.width) * Math.PI * 1.4;
        kcam.goalPitch = THREE.MathUtils.clamp(start.pitch + (dy / size.height) * 1.2, 0.5, 1.4);
      }
    };
    const up = (e: PointerEvent) => {
      const was = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0 && start && was && !moved && performance.now() - start.t < 700) {
        const sq = pick(e.clientX, e.clientY);
        if (sq) tapSquare(sq);
        else useKingdom.setState({ selected: null, targets: [], card: null });
      }
      if (pointers.size === 0) start = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      kcam.goalDist = THREE.MathUtils.clamp(kcam.goalDist * Math.exp(e.deltaY * 0.0012), kcam.fit * 0.45, kcam.fit * 1.4);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    // Test and tooling hook: which square is under a screen point, and where a square is on screen.
    (window as unknown as Record<string, unknown>).__crKingdom = {
      pick,
      project: (sq: string) => {
        const p = squarePos(sq);
        const v = new THREE.Vector3(p.x, BOARD_Y + 0.05, p.z).project(camera);
        const r = el.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
      kc,
      director,
      play,
      startGame,
      settleCamera: () => {
        kcam.yaw = kcam.goalYaw;
        kcam.pitch = kcam.goalPitch;
        kcam.dist = kcam.goalDist;
      },
    };
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [camera, gl, size]);
  return null;
}
