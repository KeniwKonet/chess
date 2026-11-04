/**
 * Match flow screens: title (with difficulty), pause, settings and the
 * end-of-battle summary. They sit over the live 3D world, in the v2 design's
 * walnut-and-bronze style.
 */
import { useEffect, useState } from 'react';
import { DIFFICULTY, type Difficulty } from '@cr/game-core';
import { useUi } from '../state/ui';
import { Settings } from './Settings';
export { Settings };
import { game, newMatch, PLAYER, onlineServer, connectRemote } from '../sim/runner';
import { flyTo, homePose, OVERVIEW_POSE } from '../camera/camera';

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
  // Portrait phones open close to the army, so frame it rather than the castle.
  const home = homePose();
  const us = game.sim.units.filter((u) => u.side === PLAYER);
  const portrait = window.innerHeight > window.innerWidth * 1.15;
  if (portrait && us.length) {
    flyTo({ ...home, x: us.reduce((a, u) => a + u.x, 0) / us.length - 1, z: us.reduce((a, u) => a + u.z, 0) / us.length });
  } else flyTo(home);
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
      <section className="menu panel title-card" aria-label="ChessFront">
        <h1 className="title-logo">
          <img src={`${import.meta.env.BASE_URL}brand/logo.webp`} alt="ChessFront" width={1200} height={507} />
        </h1>
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


declare global {
  interface Window {
    __crStart?: (d: Difficulty) => void;
  }
}
/** Test hook: start a match without clicking through the title screen. */
if (typeof window !== 'undefined') window.__crStart = startMatch;
