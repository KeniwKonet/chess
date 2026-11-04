/** Chess Kingdom: the 3D battlefield, its HUD, and the shared settings. */
import { useEffect } from 'react';
import { useUi } from '../state/ui';
import { Settings } from '../hud/Settings';
import { KingdomPerf } from './KingdomPerf';
import { KingdomScene } from './KingdomScene';
import { KingdomHud, syncDirectorSpeed } from './KingdomHud';
import { openFromUrl } from './online';
import './kingdom.css';

export function KingdomApp() {
  const loaded = useUi((s) => s.loaded);
  const showSettings = useUi((s) => s.showSettings);
  useEffect(() => {
    syncDirectorSpeed();
    document.title = 'ChessFront · The Living Chess Experience';
    // An invite (?play=…) or spectator (?watch=…) link opens straight into online play.
    openFromUrl();
  }, []);
  return (
    <div className="app kingdom">
      <KingdomScene />
      <KingdomHud />
      <KingdomPerf />
      {showSettings && <Settings kingdom />}
      <div className={`loading${loaded ? ' done' : ''}`} aria-hidden={loaded}>
        <div className="loading-mark">♜</div>
        <div className="loading-title">ChessFront</div>
        <div className="loading-sub">Mustering the armies…</div>
        <div className="loading-bar"><span /></div>
      </div>
    </div>
  );
}
