import { useEffect, useRef, useState } from 'react';
import { STARTING_RESOURCES, moveCost } from '@cr/game-core';
import { useUi, type Quality } from '../state/ui';
import { buildingById, cellByKey, nearestPlace, realm, TERRAIN_LABEL, TYPE_LABEL } from '../game';
import { cam, flyTo, HOME_POSE, OVERVIEW_POSE } from '../camera/camera';
import { zoomAt, clampPose } from '../camera/rts';
import { focusPick } from '../camera/CameraRig';
import { Minimap } from './Minimap';
import { perf } from './perf';

const fmt = (n: number) => n.toLocaleString('en-GB');
const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function Hud() {
  return (
    <div className="hud">
      <TopLeft />
      <Resources />
      <Toolbar />
      <div className="bottom-left">
        <Minimap />
        <CamButtons />
      </div>
      <SelectionPanel />
      <FieldLog />
      <Help />
      <PerfPanel />
    </div>
  );
}

function TopLeft() {
  return (
    <div className="brand panel">
      <div className="brand-mark" aria-hidden="true">♜</div>
      <div>
        <div className="brand-name">Chess Realms</div>
        <div className="brand-sub">The Ashen Divide · Sun vs Moon</div>
      </div>
      <span className="chip chip-proto" title="Milestone 1: terrain, buildings, lighting and camera. Units, combat and the War Table come in later milestones.">
        Milestone 1 build
      </span>
    </div>
  );
}

function Resources() {
  const items: [keyof typeof STARTING_RESOURCES, string, string][] = [
    ['gold', 'Gold', '#F2C14E'],
    ['food', 'Food', '#9CD06A'],
    ['wood', 'Wood', '#C98E52'],
    ['iron', 'Iron', '#B9C3CF'],
  ];
  return (
    <div className="resources panel" title="Sunspire's starting stockpile. The economy is not simulated until milestone 3, so these numbers do not change.">
      {items.map(([k, label, colour]) => (
        <div key={k} className="res">
          <span className="res-dot" style={{ background: colour }} />
          <span className="res-label">{label}</span>
          <span className="res-val">{fmt(STARTING_RESOURCES[k])}</span>
        </div>
      ))}
      <span className="res-note">Starting stock · not yet simulated</span>
    </div>
  );
}

function Toolbar() {
  const { quality, setQuality, showLabels, toggle, showPerf, addLog } = useUi();
  const qs: Quality[] = ['low', 'medium', 'high'];
  return (
    <div className="toolbar panel" role="toolbar" aria-label="View controls">
      <button className="btn" onClick={() => { flyTo(OVERVIEW_POSE); addLog('Strategic overview', 'system'); }} title="Strategic overview (O)">Overview</button>
      <button className="btn" onClick={() => { flyTo(HOME_POSE); addLog('Camera returned to Sunspire', 'system'); }} title="Return to Sunspire (H)">Sunspire</button>
      <button className={`btn${showLabels ? ' on' : ''}`} aria-pressed={showLabels} onClick={() => toggle('showLabels')} title="Map labels (L)">Labels</button>
      <div className="seg" role="group" aria-label="Graphics quality">
        {qs.map((q) => (
          <button key={q} className={`btn${quality === q ? ' on' : ''}`} aria-pressed={quality === q} onClick={() => { setQuality(q); addLog(`Graphics quality: ${q}`, 'system'); }}>
            {q[0]!.toUpperCase() + q.slice(1)}
          </button>
        ))}
      </div>
      <button className={`btn${showPerf ? ' on' : ''}`} aria-pressed={showPerf} onClick={() => toggle('showPerf')} title="Performance stats (`)">Stats</button>
      <button className="btn" onClick={() => toggle('showHelp')} title="Controls (?)">?</button>
      <button className="btn btn-locked" disabled title="The War Table (chessboard) connects to this battlefield in milestone 5">
        War Table <small>M5</small>
      </button>
    </div>
  );
}

function CamButtons() {
  const zoom = (f: number) => (cam.goal = clampPose(zoomAt(cam.goal, f), realm.bounds));
  const rot = (d: number) => flyTo({ yaw: cam.goal.yaw + d });
  return (
    <div className="cam-buttons panel" aria-label="Camera">
      <button className="btn icon" onClick={() => zoom(0.7)} aria-label="Zoom in">+</button>
      <button className="btn icon" onClick={() => zoom(1.4)} aria-label="Zoom out">−</button>
      <button className="btn icon" onClick={() => rot(Math.PI / 4)} aria-label="Rotate left">⟲</button>
      <button className="btn icon" onClick={() => rot(-Math.PI / 4)} aria-label="Rotate right">⟳</button>
    </div>
  );
}

function SelectionPanel() {
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);
  const addLog = useUi((s) => s.addLog);
  if (!selected) return null;

  if (selected.kind === 'building') {
    const b = buildingById.get(selected.id)!;
    const pct = b.maxHp ? Math.round((b.hp / b.maxHp) * 100) : 0;
    const cap = b.capture ? realm.captures.find((c) => c.id === b.capture) : undefined;
    const own = b.side === 'sun';
    return (
      <section className={`selection panel side-${b.side}`} aria-label="Selection">
        <header>
          <div>
            <div className="sel-kicker">{TYPE_LABEL[b.type]} · {own ? 'Yours (Sun)' : b.side === 'moon' ? 'Enemy (Moon)' : 'Neutral'}</div>
            <h2>{b.name}</h2>
            <div className="sel-where">{nearestPlace(b.q, b.r)}</div>
          </div>
          <button className="btn icon" onClick={() => select(null)} aria-label="Close">×</button>
        </header>
        {b.type === 'rubble' ? (
          <p className="sel-text">Destroyed before this battle began. Engineers will be able to rebuild here once construction is in (milestone 3).</p>
        ) : (
          <div className="hp">
            <div className="hp-row"><span>Structure</span><span>{fmt(b.hp)} / {fmt(b.maxHp)}</span></div>
            <div className="bar-track big"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
            {b.progress !== undefined && (
              <>
                <div className="hp-row"><span>Construction</span><span>{b.progress}%</span></div>
                <div className="bar-track big"><div className="bar-build" style={{ width: `${b.progress}%` }} /></div>
              </>
            )}
          </div>
        )}
        {cap && <p className="sel-text">Capture point. {cap.owner === 'sun' ? 'You hold it.' : cap.owner === 'moon' ? 'Moon holds it.' : 'No one holds it.'} {cap.id === 'vey' ? 'Holding Vey unlocks Scout Sight on the War Table.' : ''}</p>}
        <div className="sel-actions">
          <button className="btn" onClick={() => { focusPick(); addLog(`Camera focused on ${b.name}`, 'system'); }}>Focus (F)</button>
          {own && b.type !== 'rubble' && (
            <>
              <button className="btn btn-locked" disabled title="Training arrives with units in milestone 2–3">Train <small>M3</small></button>
              <button className="btn btn-locked" disabled title="Upgrades and repairs need the economy (milestone 3)">Upgrade <small>M3</small></button>
            </>
          )}
        </div>
        <p className="sel-foot">Values are this scenario's starting state. Combat and the economy do not run yet.</p>
      </section>
    );
  }

  const c = cellByKey.get(selected.key)!;
  const cost = moveCost(c);
  const what = c.bridge ? 'Bridge' : c.ford ? 'Ford' : c.river ? 'River' : c.road ? 'Road' : TERRAIN_LABEL[c.terrain];
  return (
    <section className="selection panel side-neutral" aria-label="Selection">
      <header>
        <div>
          <div className="sel-kicker">Terrain</div>
          <h2>{what}</h2>
          <div className="sel-where">{nearestPlace(c.q, c.r)}</div>
        </div>
        <button className="btn icon" onClick={() => select(null)} aria-label="Close">×</button>
      </header>
      <p className="sel-text">
        {cost === Infinity
          ? 'Impassable. Armies must go around.'
          : `Passable. Movement cost ${cost.toFixed(1)}× ${cost < 1 ? '(roads are faster)' : cost > 1 ? '(slower going)' : '(normal)'}.`}
        {c.ford ? ' The Ford of Ash is the only place the river can be waded.' : ''}
      </p>
      <p className="sel-foot">Movement costs are real map data; units that use them arrive in milestone 2.</p>
    </section>
  );
}

function FieldLog() {
  const log = useUi((s) => s.log);
  const [open, setOpen] = useState(typeof window === 'undefined' || window.innerWidth > 760);
  return (
    <section className={`log panel${open ? '' : ' closed'}`} aria-label="Field log">
      <button className="log-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Field log</span>
        <span className="log-count">{log.length}</span>
      </button>
      {open && (
        <>
          <p className="log-note">Your actions this session. Battle reports start when combat runs (milestone 3).</p>
          <ol>
            {log.length === 0 && <li className="log-empty">Click a building or tile to inspect it.</li>}
            {log.map((e) => (
              <li key={e.id} className={`tone-${e.tone}`}>
                <time>{clock(e.t)}</time>
                {e.text}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Help() {
  const show = useUi((s) => s.showHelp);
  const toggle = useUi((s) => s.toggle);
  const edgeScroll = useUi((s) => s.edgeScroll);
  if (!show) return null;
  const rows: [string, string][] = [
    ['Drag', 'Pan. The ground stays under your pointer'],
    ['Wheel · pinch', 'Zoom toward the pointer'],
    ['Middle-drag · Shift-drag · two-finger twist', 'Rotate'],
    ['W A S D · arrows', 'Pan'],
    ['Q · E', 'Rotate'],
    ['+ · −', 'Zoom'],
    ['Click', 'Inspect a building or tile'],
    ['Double-click · F', 'Focus the camera on the selection'],
    ['H · O · N', 'Sunspire · overview · face north'],
    ['L · ` · Esc', 'Labels · stats · clear selection'],
  ];
  return (
    <div className="modal-scrim" onClick={() => toggle('showHelp')}>
      <section className="help panel" role="dialog" aria-modal="true" aria-label="Controls" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Controls</h2>
          <button className="btn icon" onClick={() => toggle('showHelp')} aria-label="Close">×</button>
        </header>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="help-settings">
          <button className={`btn${edgeScroll ? ' on' : ''}`} aria-pressed={edgeScroll} onClick={() => toggle('edgeScroll')}>
            Edge panning {edgeScroll ? 'on' : 'off'}
          </button>
        </div>
        <p className="sel-foot">Once units arrive (milestone 2), left-drag will box-select and right-drag will pan.</p>
      </section>
    </div>
  );
}

function PerfPanel() {
  const show = useUi((s) => s.showPerf);
  const quality = useUi((s) => s.quality);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!show) return;
    const id = setInterval(() => {
      if (!ref.current) return;
      ref.current.textContent =
        `${perf.fps.toFixed(0)} fps   ${perf.ms.toFixed(1)} ms\n` +
        `draw calls  ${perf.calls}\n` +
        `triangles   ${fmt(perf.triangles)}\n` +
        `geometries  ${perf.geometries}   textures ${perf.textures}\n` +
        `pixel ratio ${perf.dpr.toFixed(2)}   quality ${quality}\n` +
        `camera dist ${cam.current.dist.toFixed(1)}`;
    }, 400);
    return () => clearInterval(id);
  }, [show, quality]);
  if (!show) return null;
  return (
    <div className="perf panel" aria-label="Performance">
      <pre ref={ref}>measuring…</pre>
    </div>
  );
}
