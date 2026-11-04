/**
 * Chooses the game mode. Chess Kingdom (turn-based, every soldier a chess
 * piece) is the home screen; the real-time Battle of the Ashen Divide opens
 * with ?mode=battle (or ?server=… for its online mode).
 */
import { lazy, Suspense } from 'react';
import { KingdomApp } from './kingdom/KingdomApp';

const BattleApp = lazy(() => import('./App').then((m) => ({ default: m.App })));

export const MODE = (() => {
  if (typeof location === 'undefined') return 'kingdom';
  const q = new URLSearchParams(location.search);
  return q.get('mode') === 'battle' || q.has('server') ? 'battle' : 'kingdom';
})();

/** True when the browser can draw 3D (WebGL 2, or WebGL 1 as a fallback). */
export const HAS_WEBGL = (() => {
  if (typeof document === 'undefined') return true;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
})();

/** Shown instead of a crash when the browser or device cannot draw 3D. */
function NoWebGL() {
  return (
    <div className="no-webgl" role="alert">
      <section className="panel">
        <div className="title-mark" aria-hidden="true">♜</div>
        <h1>ChessFront</h1>
        <p className="title-sub">The Living Chess Experience</p>
        <p>
          This browser can't show 3D graphics, which the battlefield needs. Turn on hardware acceleration (or graphics
          acceleration) in your browser settings, update the browser, or open ChessFront in Chrome, Edge, Firefox or Safari.
        </p>
        <button className="btn btn-primary" onClick={() => location.reload()}>Try again</button>
      </section>
    </div>
  );
}

export function Root() {
  if (!HAS_WEBGL) return <NoWebGL />;
  if (MODE === 'battle') {
    return (
      <Suspense fallback={null}>
        <BattleApp />
      </Suspense>
    );
  }
  return <KingdomApp />;
}
