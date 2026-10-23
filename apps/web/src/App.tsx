import { Component, Suspense, useEffect, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useUi } from './state/ui';
import { World, Lighting, WindClock } from './world/World';
import { Sea } from './world/Sea';
import { SelectionMarkers, CaptureRings } from './world/Markers';
import { FallbackWorld } from './world/FallbackWorld';
import { CameraRig } from './camera/CameraRig';
import { Overlay, OverlayProjector } from './hud/Overlay';
import { Hud } from './hud/Hud';
import { PerfProbe } from './hud/perf';
import { Units, UnitMarks, SimDriver } from './units/Units';
import { BoxSelect } from './hud/BoxSelect';

class AssetBoundary extends Component<{ children: ReactNode; fallback: ReactNode; what?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[ChessRealms] assets failed to load', err);
    if (this.props.what) {
      useUi.getState().addLog(this.props.what, 'system');
      return;
    }
    useUi.getState().setAssetsFailed(true);
    useUi.getState().addLog('3D models failed to load. Showing a simplified map.', 'system');
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Ready() {
  useEffect(() => {
    document.body.dataset.ready = '1';
    useUi.getState().addLog('Battlefield loaded: the Ashen Divide', 'system');
  }, []);
  return null;
}

export function App() {
  const quality = useUi((s) => s.quality);
  const failed = useUi((s) => s.assetsFailed);
  const dpr: [number, number] = quality === 'low' ? [1, 1] : quality === 'medium' ? [1, 1.5] : [1, 2];

  return (
    <div className="app">
      <Canvas
        key={quality === 'low' ? 'aa-off' : 'aa-on'}
        className="stage"
        dpr={dpr}
        shadows={quality !== 'low'}
        gl={{ antialias: quality !== 'low', powerPreference: 'high-performance' }}
        camera={{ fov: 34, near: 0.5, far: 700, position: [30, 60, 60] }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <Lighting quality={quality} />
        <Sea />
        <AssetBoundary fallback={<FallbackWorld />}>
          <Suspense fallback={null}>
            <World />
            <Ready />
          </Suspense>
        </AssetBoundary>
        <AssetBoundary fallback={null} what="Soldier models failed to load. Units are shown as chess tokens.">
          <Suspense fallback={null}>
            <Units />
          </Suspense>
        </AssetBoundary>
        <UnitMarks />
        <SimDriver />
        <CaptureRings />
        <SelectionMarkers />
        <WindClock />
        <CameraRig />
        <OverlayProjector />
        <PerfProbe />
      </Canvas>
      <Overlay />
      <BoxSelect />
      <Hud />
      <Loading failed={failed} />
    </div>
  );
}

function Loading({ failed }: { failed: boolean }) {
  const log = useUi((s) => s.log);
  const ready = log.some((l) => l.text.startsWith('Battlefield loaded')) || failed;
  return (
    <div className={`loading${ready ? ' done' : ''}`} aria-hidden={ready}>
      <div className="loading-mark">♜</div>
      <div className="loading-title">Chess Realms</div>
      <div className="loading-sub">Raising the Ashen Divide…</div>
      <div className="loading-bar"><span /></div>
    </div>
  );
}
