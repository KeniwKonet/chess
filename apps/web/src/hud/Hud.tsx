import { useEffect, useRef, useState } from 'react';
import { STARTING_RESOURCES, moveCost } from '@cr/game-core';
import { useUi } from '../state/ui';
import { buildingById, cellByKey, nearestPlace, realm, TERRAIN_LABEL, TYPE_LABEL } from '../game';
import { cam, flyTo, HOME_POSE, OVERVIEW_POSE } from '../camera/camera';
import { zoomAt, clampPose } from '../camera/rts';
import { focusPick } from '../camera/CameraRig';
import { Minimap } from './Minimap';
import { perf } from './perf';
import { UnitPanel, ArmyBar } from './UnitPanel';
import { WarTable } from './WarTable';
import { setPaused } from './Menus';
import { game, PLAYER } from '../sim/runner';

const fmt = (n: number) => n.toLocaleString('en-GB');
const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function Hud() {
  const screen = useUi((s) => s.screen);
  if (screen === 'title') return <Help />;
  return (
    <div className="hud">
      <TopLeft />
      <Resources />
      <Toolbar />
      <div className="bottom-left">
        <Minimap />
        <CamButtons />
      </div>
      <ArmyBar />
      <SelectionPanel />
      <UnitPanel />
      <FieldLog />
      <WarTable />
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
      <span className="chip chip-proto" title="Prototype: battlefield, armies, combat, Moon AI, War Table and match flow. Economy and extra unit types are not in this build.">
        Prototype
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
    <div className="resources panel" title="Sunspire's stockpile. Gathering and spending are not simulated in this build, so these numbers do not change; reinforcements come from barracks instead.">
      {items.map(([k, label, colour]) => (
        <div key={k} className="res">
          <span className="res-dot" style={{ background: colour }} />
          <span className="res-label">{label}</span>
          <span className="res-val">{fmt(STARTING_RESOURCES[k])}</span>
        </div>
      ))}
      <span className="res-note">Stockpile · economy not simulated</span>
    </div>
  );
}

function Toolbar() {
  const { showLabels, toggle, showPerf, addLog } = useUi();
  return (
    <div className="toolbar panel" role="toolbar" aria-label="View controls">
      <button className="btn" onClick={() => { flyTo(OVERVIEW_POSE); addLog('Strategic overview', 'system'); }} title="Strategic overview (O)">Overview</button>
      <button className="btn" onClick={() => { flyTo(HOME_POSE); addLog('Camera returned to Sunspire', 'system'); }} title="Return to Sunspire (H)">Sunspire</button>
      <button className={`btn${showLabels ? ' on' : ''}`} aria-pressed={showLabels} onClick={() => toggle('showLabels')} title="Map labels (L)">Labels</button>
      <WarTableButton />
      <button className={`btn${showPerf ? ' on' : ''}`} aria-pressed={showPerf} onClick={() => toggle('showPerf')} title="Performance stats (`)">Stats</button>
      <button className="btn" onClick={() => toggle('showHelp')} title="Controls (?)" aria-label="How to play">?</button>
      <button className="btn" onClick={() => toggle('showSettings')} title="Settings" aria-label="Settings">⚙</button>
      <button className="btn" onClick={() => setPaused(true)} title="Pause (P)" aria-label="Pause">❚❚</button>
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
  useUi((s) => s.unitRev); // live structure and ownership
  if (!selected) return null;

  if (selected.kind === 'building') {
    const def = buildingById.get(selected.id)!;
    const live = game.sim.building(def.id)!;
    const b = { ...def, hp: Math.ceil(live.hp), side: live.side };
    const pct = b.maxHp ? Math.round((b.hp / b.maxHp) * 100) : 0;
    const cap = b.capture ? game.sim.captures.find((c) => c.id === b.capture) : undefined;
    const own = b.side === PLAYER;
    const destroyed = live.destroyed;
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
        {b.type === 'rubble' || destroyed ? (
          <p className="sel-text">{b.type === 'rubble' ? 'Destroyed before this battle began.' : 'Destroyed in this battle.'} Rebuilding needs engineers and the economy, which are not in this build.</p>
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
        {cap && <p className="sel-text">Capture point. {cap.owner === 'sun' ? 'You hold it.' : cap.owner === 'moon' ? 'Moon holds it.' : 'No one holds it.'} Stand soldiers in the ring with no enemy inside to take it. {cap.id === 'vey' ? 'Holding Vey gives Scout Sight: your soldiers see further.' : ''}</p>}
        {live.weapon && !destroyed && <p className="sel-text">Shoots enemies within {live.weapon.range} units for {live.weapon.damage} damage.</p>}
        <div className="sel-actions">
          <button className="btn" onClick={() => { focusPick(); addLog(`Camera focused on ${b.name}`, 'system'); }}>Focus (F)</button>
          {own && b.type !== 'rubble' && !destroyed && (
            <button className="btn btn-locked" disabled title="Training, upgrades and repairs need the economy, which is not in this build. Barracks and ranges send reinforcements every 90 seconds while they stand.">
              Train <small>Economy</small>
            </button>
          )}
        </div>
        <p className="sel-foot">{b.type === 'barracks' || b.type === 'archery' ? 'While it stands it sends reinforcements every 90 seconds.' : b.type === 'castle' ? 'If this castle falls, the battle is lost.' : 'Resources are not simulated in this build.'}</p>
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
      <p className="sel-foot">Soldiers use these costs when they plan a march: roads speed them up, forest and the ford slow them down.</p>
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
          <p className="log-note">Orders, fighting, captures, reinforcements and War Table moves, as they happen.</p>
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
    ['Click a soldier', 'Select it. Shift-click adds or removes'],
    ['Left-drag', 'Box-select your soldiers (Shift adds)'],
    ['Double-click a soldier', 'Select all of that type in view'],
    ['Right-click', 'Move there, or attack the enemy under the pointer'],
    ['T, then click', 'Attack-move: advance and fight anything met on the way'],
    ['Tap (touch)', 'Select; with soldiers selected, move there or attack the enemy tapped'],
    ['X', 'Stop and hold position'],
    ['B', 'Open the War Table (chess that commands the battle)'],
    ['P · Esc', 'Pause'],
    ['Ctrl+A · Ctrl+1–9 · 1–9', 'Select all · set group · recall group (twice to jump)'],
    ['Right-drag · one finger', 'Pan. The ground stays under your pointer'],
    ['Wheel · pinch', 'Zoom toward the pointer'],
    ['Middle-drag · Alt-drag · two-finger twist · Q/E', 'Rotate'],
    ['W A S D · arrows', 'Pan'],
    ['Click a building or tile', 'Inspect it'],
    ['F · H · O · N', 'Focus selection · Sunspire · overview · face north'],
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
        <p className="sel-foot">
          Win by destroying Nocturne Castle or by checkmate on the War Table; lose if Sunspire falls. Idle soldiers defend themselves; capture rings change hands when only one side stands in them; barracks and ranges send reinforcements every 90 seconds while they stand. Zoomed far out, soldiers show as chess pieces: pawns are infantry, bishops are archers.
        </p>
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

function WarTableButton() {
  const show = useUi((s) => s.showWarTable);
  const toggle = useUi((s) => s.toggle);
  useUi((s) => s.unitRev);
  const wt = game.match.warTable;
  const yourMove = wt.turn === PLAYER && !wt.over;
  return (
    <button className={`btn${show ? ' on' : ''}${yourMove && !show ? ' nudge' : ''}`} aria-pressed={show} onClick={() => toggle('showWarTable')} title="The War Table: chess that commands the battle (B)">
      ♛ War Table{yourMove && !show ? <small>Your move</small> : null}
    </button>
  );
}
