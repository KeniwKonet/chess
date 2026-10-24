/**
 * Match flow screens: title (with difficulty), pause, settings and the
 * end-of-battle summary. They sit over the live 3D world, in the v2 design's
 * walnut-and-bronze style.
 */
import { useEffect, useState } from 'react';
import { DIFFICULTY, type Difficulty } from '@cr/game-core';
import { useUi, type Quality } from '../state/ui';
import { game, newMatch, PLAYER, onlineServer, connectRemote } from '../sim/runner';
import { flyTo, HOME_POSE, OVERVIEW_POSE } from '../camera/camera';

const clock = (ticks: number) => {
  const s = Math.floor(ticks / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function startMatch(d: Difficulty) {
  const ui = useUi.getState();
  newMatch(d);
  ui.setDifficulty(d);
  ui.setScreen('playing');
  ui.setPaused(false);
  useUi.setState({ result: null, showWarTable: false });
  game.paused = false;
  flyTo(HOME_POSE);
}

export function setPaused(p: boolean) {
  useUi.getState().setPaused(p);
  game.paused = p;
}

export function Menus() {
  const screen = useUi((s) => s.screen);
  const paused = useUi((s) => s.paused);
  const result = useUi((s) => s.result);
  const showSettings = useUi((s) => s.showSettings);

  // The summary appears a moment after the battle ends, so the cheer and the fall can be seen.
  useEffect(() => {
    if (!result || screen !== 'playing') return;
    const id = setTimeout(() => useUi.getState().setScreen('summary'), 3500);
    return () => clearTimeout(id);
  }, [result, screen]);

  return (
    <>
      {screen === 'title' && <Title />}
      {screen === 'playing' && paused && <Pause />}
      {screen === 'summary' && <Summary />}
      {showSettings && <Settings />}
    </>
  );
}

function Title() {
  const difficulty = useUi((s) => s.difficulty);
  const setDifficulty = useUi((s) => s.setDifficulty);
  const toggle = useUi((s) => s.toggle);
  // Slow drift over the map behind the title.
  useEffect(() => {
    game.paused = true;
    flyTo({ ...OVERVIEW_POSE, dist: 70 });
    let a = 0;
    const id = setInterval(() => {
      a += 0.0025;
      flyTo({ yaw: Math.sin(a) * 0.35 });
    }, 50);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="menu-scrim title-scrim">
      <section className="menu panel title-card" aria-label="Chess Realms">
        <div className="title-mark" aria-hidden="true">♜</div>
        <h1>Chess Realms</h1>
        <p className="title-sub">The Ashen Divide · Sun against Moon</p>
        <p className="title-text">
          Command the Sun's soldiers across a living battlefield, and move your pieces on the War Table to drive them. Take the crossings, hold Vey Watchtower, and bring down Nocturne Castle before the Moon takes Sunspire.
        </p>
        <fieldset className="difficulty">
          <legend>Moon commander</legend>
          {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
            <label key={d} className={`diff${difficulty === d ? ' on' : ''}`}>
              <input type="radio" name="difficulty" id={`diff-${d}`} checked={difficulty === d} onChange={() => setDifficulty(d)} />
              <span className="diff-name">{DIFFICULTY[d].label}</span>
              <span className="diff-note">
                {d === 'recruit' ? 'Attacks late, retreats early, plays chess one move deep' : d === 'captain' ? 'A fair fight on both boards' : 'Attacks early, fights to the end, looks three moves ahead'}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="menu-actions">
          {onlineServer ? (
            <button className="btn btn-primary" onClick={() => connectRemote(onlineServer!)} autoFocus>
              Join the online battle
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => startMatch(difficulty)} autoFocus>
              Begin the battle
            </button>
          )}
          <button className="btn" onClick={() => toggle('showHelp')}>How to play</button>
          <button className="btn" onClick={() => toggle('showSettings')}>Settings</button>
        </div>
        <p className="menu-foot">
          {onlineServer ? `Server: ${onlineServer}. The server runs the battle; this screen shows what your side can see.` : 'Single player against the Moon AI. Online battles run the same rules on a server (see docs/MILESTONE-6.md).'}
        </p>
      </section>
    </div>
  );
}

function Pause() {
  const toggle = useUi((s) => s.toggle);
  const difficulty = useUi((s) => s.difficulty);
  return (
    <div className="menu-scrim">
      <section className="menu panel" role="dialog" aria-modal="true" aria-label="Paused">
        <h2>Paused</h2>
        <p className="menu-sub">{clock(game.sim.tick)} into the battle · {DIFFICULTY[difficulty].label}</p>
        <div className="menu-actions col">
          <button className="btn btn-primary" onClick={() => setPaused(false)} autoFocus>Resume</button>
          <button className="btn" onClick={() => toggle('showHelp')}>How to play</button>
          <button className="btn" onClick={() => toggle('showSettings')}>Settings</button>
          <button className="btn" onClick={() => startMatch(difficulty)}>Restart the battle</button>
          <button className="btn" onClick={() => { setPaused(false); game.paused = true; useUi.getState().setScreen('title'); }}>Quit to title</button>
        </div>
      </section>
    </div>
  );
}

function Summary() {
  const result = useUi((s) => s.result)!;
  const difficulty = useUi((s) => s.difficulty);
  const [hidden, setHidden] = useState(false);
  const won = result.winner === PLAYER;
  const st = game.sim.stats;
  const chess = game.match.warTable?.summary();
  if (hidden)
    return (
      <button className="btn btn-primary summary-reopen" onClick={() => setHidden(false)}>
        Battle report
      </button>
    );
  const rows: [string, number, number][] = [
    ['Enemy soldiers killed', st.sun.kills, st.moon.kills],
    ['Soldiers lost', st.sun.losses, st.moon.losses],
    ['Buildings destroyed', st.sun.buildingsDestroyed, st.moon.buildingsDestroyed],
    ['Points captured', st.sun.captures, st.moon.captures],
    ['Reinforcements', st.sun.reinforcements, st.moon.reinforcements],
  ];
  return (
    <div className="menu-scrim">
      <section className={`menu panel summary ${won ? 'won' : 'lost'}`} role="dialog" aria-modal="true" aria-label="Battle report">
        <div className="summary-kicker">{won ? 'Victory' : 'Defeat'}</div>
        <h2>{result.reason}</h2>
        <p className="menu-sub">
          {clock(game.sim.tick)} · against a {DIFFICULTY[difficulty].label} Moon commander
        </p>
        <table className="stats">
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col" className="sun">Sun</th>
              <th scope="col" className="moon">Moon</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, a, b]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{a}</td>
                <td>{b}</td>
              </tr>
            ))}
            {chess && (
              <tr>
                <th scope="row">War Table moves</th>
                <td>{chess.sunMoves}</td>
                <td>{chess.moonMoves}</td>
              </tr>
            )}
          </tbody>
        </table>
        {chess && <p className="menu-sub">War Table: {chess.text}</p>}
        <div className="menu-actions">
          <button className="btn btn-primary" onClick={() => startMatch(difficulty)} autoFocus>Rematch</button>
          <button className="btn" onClick={() => { game.paused = true; useUi.getState().setScreen('title'); }}>Change difficulty</button>
          <button className="btn" onClick={() => setHidden(true)}>Look at the field</button>
        </div>
      </section>
    </div>
  );
}

function Settings() {
  const { quality, setQuality, showLabels, edgeScroll, toggle } = useUi();
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
        <div className="setting">
          <span>Map labels</span>
          <button className={`btn${showLabels ? ' on' : ''}`} aria-pressed={showLabels} onClick={() => toggle('showLabels')}>{showLabels ? 'On' : 'Off'}</button>
        </div>
        <div className="setting">
          <span>Edge panning</span>
          <button className={`btn${edgeScroll ? ' on' : ''}`} aria-pressed={edgeScroll} onClick={() => toggle('edgeScroll')}>{edgeScroll ? 'On' : 'Off'}</button>
        </div>
      </section>
    </div>
  );
}

declare global {
  interface Window {
    __crStart?: (d: Difficulty) => void;
  }
}
/** Test hook: start a match without clicking through the title screen. */
if (typeof window !== 'undefined') window.__crStart = startMatch;
