/** Graphics and interface settings, shared by both game modes. */
import { useUi, IS_MOBILE, type Quality } from '../state/ui';

/** Settings dialog; `kingdom` hides the options that only apply to battle mode. */
export function Settings({ kingdom = false }: { kingdom?: boolean }) {
  const { quality, setQuality, showLabels, showPerf, edgeScroll, toggle } = useUi();
  const qs: Quality[] = ['low', 'medium', 'high'];
  return (
    <div className="menu-scrim" onClick={() => toggle('showSettings')}>
      <section className="menu panel" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="menu-head">
          <h2>Settings</h2>
          <button className="btn icon" onClick={() => toggle('showSettings')} aria-label="Close">×</button>
        </header>
        <div className="setting">
          <span id="set-quality">Graphics quality</span>
          <div className="seg" role="group" aria-labelledby="set-quality">
            {qs.map((q) => (
              <button key={q} className={`btn${quality === q ? ' on' : ''}`} aria-pressed={quality === q} onClick={() => setQuality(q)}>
                {q[0]!.toUpperCase() + q.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <p className="setting-note">Low: no shadows or anti-aliasing. Medium (phones): shadows drawn once, simpler models. High: live shadows, full detail.</p>
        {!kingdom && <div className="setting">
          <span>Map labels</span>
          <button className={`btn${showLabels ? ' on' : ''}`} aria-pressed={showLabels} onClick={() => toggle('showLabels')}>{showLabels ? 'On' : 'Off'}</button>
        </div>}
        <div className="setting">
          <span>Performance stats (frame rate)</span>
          <button className={`btn${showPerf ? ' on' : ''}`} aria-pressed={showPerf} onClick={() => toggle('showPerf')}>{showPerf ? 'On' : 'Off'}</button>
        </div>
        {!IS_MOBILE && !kingdom && (
          <div className="setting">
            <span>Edge panning</span>
            <button className={`btn${edgeScroll ? ' on' : ''}`} aria-pressed={edgeScroll} onClick={() => toggle('edgeScroll')}>{edgeScroll ? 'On' : 'Off'}</button>
          </div>
        )}
      </section>
    </div>
  );
}
