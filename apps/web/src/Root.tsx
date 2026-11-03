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

export function Root() {
  if (MODE === 'battle') {
    return (
      <Suspense fallback={null}>
        <BattleApp />
      </Suspense>
    );
  }
  return <KingdomApp />;
}
