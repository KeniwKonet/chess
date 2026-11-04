/** Chess Kingdom screens and HUD: home, setup, player bars and clocks, role cards, promotion, menu, result. */
import { useEffect, useReducer, useState } from 'react';
import { AI_LEVELS, CHESS_NAME, ROLE_NAME, ROLE_RULE, resultText, TIME_CONTROLS, type AiLevel, type Colour, type Role } from '@cr/chess-core';
import { useUi } from '../state/ui';
import { GLYPH } from './board';
import { aiColour, choosePromotion, exitToHome, kc, offerDraw, resign, setAnimSpeed, setSound, startGame, takeback } from './controller';
import { enterOnline, useOnline } from './online';
import { OnlineBanner, OnlineMenuExtras, OnlineResult, OnlineScreen } from './OnlineHud';
import { ClashMenuExtras, ClashPanel, ClashResult, ClustersScreen } from './ClusterHud';
import { useClusters } from './clash';
import { SocialBar, SocialPanels } from './AccountHud';
import { TournamentsScreen } from './TournamentHud';
import { AdminScreen } from './AdminHud';
import { useKingdom } from './store';
import { director } from './director';
import { unlockAudio } from './sound';

const SIDE_NAME: Record<Colour, string> = { w: 'Sun', b: 'Moon' };

export function KingdomHud() {
  const screen = useKingdom((s) => s.screen);
  return (
    <div className="k-hud">
      {screen === 'home' && <Home />}
      {screen === 'setup' && <Setup />}
      {screen === 'online' && <OnlineScreen />}
      {screen === 'clusters' && <ClustersScreen />}
      {screen === 'tournaments' && <TournamentsScreen />}
      {screen === 'admin' && <AdminScreen />}
      <SocialPanels />
      {screen === 'playing' && <Playing />}
    </div>
  );
}

// ---------------------------------------------------------------- home and setup

const MODES: { id: string; title: string; blurb: string; tag?: string }[] = [
  { id: 'ai', title: 'Play the computer', blurb: 'Four commanders, from Squire to Warlord.' },
  { id: 'online', title: 'Play online', blurb: 'Invite a friend by link or get paired. Ratings, streaks, rivals.' },
  { id: 'clusters', title: 'Clash of Clusters', blurb: 'Your team is one army: every member commands a soldier.', tag: 'New' },
  { id: 'tournaments', title: 'Tournaments', blurb: 'Swiss and knockout events with live standings.', tag: 'New' },
  { id: 'local', title: 'Two players, one device', blurb: 'Pass and play, with chess clocks.' },
  { id: 'battle', title: 'Real-time battle', blurb: 'Armies march live while a chessboard commands them.' },
];

function Home() {
  const [show, setShow] = useState(false);
  const go = (id: string) => {
    unlockAudio();
    if (id === 'ai' || id === 'local') useKingdom.setState({ opponent: id, screen: 'setup' });
    else if (id === 'online') enterOnline();
    else if (id === 'clusters') useKingdom.setState({ screen: 'clusters' });
    else if (id === 'tournaments') useKingdom.setState({ screen: 'tournaments' });
    else if (id === 'battle') location.search = '?mode=battle';
  };
  return (
    <div className="k-scrim">
      <section className="k-home k-picker panel" aria-label="ChessFront">
        <header className="k-picker-head">
          <span className="title-mark" aria-hidden="true">♜</span>
          <div>
            <h1>ChessFront</h1>
            <p className="title-sub">The Living Chess Experience</p>
          </div>
          <SocialBar />
        </header>
        <p className="k-lede">Two kingdoms at war, and every soldier moves by the rules of chess. Choose how you want to fight.</p>
        <ul className="k-modecards">
          {MODES.map((m) => (
            <li key={m.id}>
              <button className="k-modecard" onClick={() => go(m.id)} aria-label={`${m.title}. ${m.blurb}`}>
                <span className="k-modecard-shot">
                  <img src={`${import.meta.env.BASE_URL}modes/${m.id}.jpg`} alt="" loading="lazy" width={480} height={300} />
                  {m.tag && <span className="k-modecard-tag">{m.tag}</span>}
                </span>
                <span className="k-modecard-text">
                  <b>{m.title}</b>
                  <small>{m.blurb}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="k-home-foot">
          <button className="btn" onClick={() => setShow(true)}>How to play</button>
          <button className="btn" onClick={() => useUi.setState({ showSettings: true })}>Settings</button>
        </div>
      </section>
      {show && <RulesSheet onClose={() => setShow(false)} />}
    </div>
  );
}

function Setup() {
  const s = useKingdom();
  const ai = s.opponent === 'ai';
  const set = (p: Partial<typeof s>) => useKingdom.setState(p);
  return (
    <div className="k-scrim">
      <section className="k-setup panel" aria-label={ai ? 'Play the computer' : 'Two players'}>
        <header className="k-setup-head">
          <button className="btn icon" aria-label="Back" onClick={() => set({ screen: 'home' })}>←</button>
          <h2>{ai ? 'Play the computer' : 'Two players, one device'}</h2>
        </header>
        {ai && (
          <fieldset className="k-choices">
            <legend>Opponent</legend>
            {(Object.keys(AI_LEVELS) as AiLevel[]).map((l) => (
              <label key={l} className={`diff${s.aiLevel === l ? ' on' : ''}`}>
                <input type="radio" name="level" checked={s.aiLevel === l} onChange={() => set({ aiLevel: l })} />
                <span className="diff-name">{AI_LEVELS[l].label}</span>
                <span className="diff-note">{AI_LEVELS[l].blurb}</span>
              </label>
            ))}
          </fieldset>
        )}
        {ai && (
          <fieldset className="k-choices row">
            <legend>Your army</legend>
            {(['w', 'b', 'random'] as const).map((c) => (
              <button key={c} type="button" className={`btn k-pill${s.side === c ? ' on' : ''}`} aria-pressed={s.side === c} onClick={() => set({ side: c })}>
                {c === 'w' ? '☀ Sun (moves first)' : c === 'b' ? '☾ Moon' : 'Random'}
              </button>
            ))}
          </fieldset>
        )}
        <fieldset className="k-choices row">
          <legend>Clock</legend>
          {Object.keys(TIME_CONTROLS).map((k) => (
            <button key={k} type="button" className={`btn k-pill${s.tc === k ? ' on' : ''}`} aria-pressed={s.tc === k} onClick={() => set({ tc: k })}>
              {k === 'untimed' ? 'No clock' : `${k.replace('+', ' min + ')} s`}
            </button>
          ))}
        </fieldset>
        {!ai && (
          <label className="setting">
            <span>Turn the board to whoever's move it is</span>
            <input type="checkbox" checked={s.flipEachTurn} onChange={(e) => set({ flipEachTurn: e.target.checked })} />
          </label>
        )}
        <div className="menu-actions">
          <button className="btn btn-primary" onClick={() => startGame({ opponent: s.opponent })} autoFocus>
            To battle
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- in game

function useTicker(ms: number) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Playing() {
  const viewFrom = useKingdom((s) => s.viewFrom);
  useKingdom((s) => s.rev);
  const top: Colour = viewFrom === 'w' ? 'b' : 'w';
  return (
    <>
      <PlayerBar colour={top} where="top" />
      <PlayerBar colour={viewFrom} where="bottom" />
      <Toast />
      <RoleCard />
      <Promotion />
      <Moves />
      <OnlineBanner />
      <ClashPanel />
      <GameMenu />
      {kc.opponent === 'online' ? <OnlineResult /> : kc.opponent === 'clash' ? <ClashResult /> : <Result />}
    </>
  );
}

function clockText(ms: number) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return s.toFixed(1);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function PlayerBar({ colour, where }: { colour: Colour; where: 'top' | 'bottom' }) {
  useTicker(100);
  const thinking = useKingdom((s) => s.thinking);
  const og = useOnline((s) => s.game);
  const cl = useClusters((s) => s.clash);
  const g = kc.game;
  const away = kc.opponent === 'online' && og && og.status === 'playing' && !og.presence[colour];
  const name = (() => {
    if (kc.opponent === 'ai') return colour === aiColour() ? `${SIDE_NAME[colour]} · ${AI_LEVELS[useKingdom.getState().aiLevel].label} (computer)` : `${SIDE_NAME[colour]} · You`;
    if (kc.opponent === 'clash') {
      const side = colour === 'w' ? cl?.white : cl?.black;
      return side ? `${side.name} · ${side.rating}${cl?.you === colour ? ' (your cluster)' : ''}` : SIDE_NAME[colour];
    }
    if (kc.opponent === 'online') {
      const p = colour === 'w' ? og?.white : og?.black;
      if (!p) return SIDE_NAME[colour];
      return `${p.name}${p.rating !== null ? ` · ${p.rating}${p.provisional ? '?' : ''}` : ''}${og?.you === colour ? ' (you)' : ''}`;
    }
    return `${SIDE_NAME[colour]} · Player ${colour === 'w' ? 1 : 2}`;
  })();
  const toMove = !g.over && g.turn === colour;
  const left = g.timeLeft(colour, kc.clockNow());
  const taken = g.fallen(colour === 'w' ? 'b' : 'w');
  const adv = g.material() * (colour === 'w' ? 1 : -1);
  const values: Record<Role, number> = { q: 9, r: 5, b: 3, n: 3, p: 1, k: 0 };
  return (
    <section className={`k-bar panel ${where} side-${colour}${toMove ? ' to-move' : ''}`} aria-label={`${SIDE_NAME[colour]} army`}>
      <span className={`k-avatar side-${colour}`} aria-hidden="true">{GLYPH.k}</span>
      <div className="k-who">
        <div className="k-name">{name}</div>
        <div className="k-taken" aria-label={`Captured: ${taken.map((p) => ROLE_NAME[p.role]).join(', ') || 'none'}`}>
          {[...taken].sort((a, b) => values[b.role] - values[a.role]).map((p) => (
            <span key={p.id} className={`k-taken-p side-${p.colour}`}>{GLYPH[p.role]}</span>
          ))}
          {adv > 0 && <span className="k-adv">+{adv}</span>}
        </div>
      </div>
      {toMove && kc.opponent === 'ai' && colour === aiColour() && thinking && <span className="k-thinking">thinking…</span>}
      {away && <span className="k-away" title="Lost connection">away</span>}
      {g.timeControl && (
        <time className={`k-clock${toMove ? ' running' : ''}${left < 20_000 ? ' low' : ''}`} aria-label={`${SIDE_NAME[colour]} clock`}>
          {clockText(left)}
        </time>
      )}
      {where === 'bottom' && (
        <div className="k-actions">
          <button className="btn" onClick={() => useKingdom.setState((s) => ({ showMoves: !s.showMoves }))} aria-label="Moves" aria-pressed={useKingdom.getState().showMoves}>≡</button>
          <button className="btn" onClick={() => useKingdom.setState({ showMenu: true })} aria-label="Game menu">☰</button>
        </div>
      )}
    </section>
  );
}

function Toast() {
  const t = useKingdom((s) => s.toast);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!t) return;
    setShown(t.id);
    const id = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(id);
  }, [t]);
  if (!t || shown !== t.id) return null;
  return (
    <div className={`k-toast tone-${t.tone}`} role="status">
      {t.text}
    </div>
  );
}

function RoleCard() {
  const card = useKingdom((s) => s.card);
  const targets = useKingdom((s) => s.targets);
  const selected = useKingdom((s) => s.selected);
  if (!card) return null;
  const mine = selected && targets.length > 0;
  return (
    <aside className={`k-card panel side-${card.colour}`} aria-live="polite">
      <span className={`k-card-glyph side-${card.colour}`}>{GLYPH[card.role]}</span>
      <div>
        <div className="k-card-name">
          {ROLE_NAME[card.role]} <small>the {CHESS_NAME[card.role]} · {SIDE_NAME[card.colour]}</small>
        </div>
        <p>{ROLE_RULE[card.role]}</p>
        {selected && kc.game.tracker.on(selected)?.colour === kc.game.turn && (
          <p className="k-card-hint">{mine ? `${targets.length} square${targets.length === 1 ? '' : 's'} it can reach are marked. Tap one to move.` : 'It has no legal move right now.'}</p>
        )}
      </div>
    </aside>
  );
}

function Promotion() {
  const p = useKingdom((s) => s.promotion);
  if (!p) return null;
  const c = kc.game.turn;
  return (
    <div className="k-scrim" onClick={() => choosePromotion(null)}>
      <section className="k-promo panel" role="dialog" aria-modal="true" aria-label="Promotion" onClick={(e) => e.stopPropagation()}>
        <h2>Promotion</h2>
        <p className="menu-sub">Your Footman reached the far rank. Who do they become?</p>
        <div className="k-promo-row">
          {(['q', 'r', 'b', 'n'] as Role[]).map((r) => (
            <button key={r} className="k-promo-btn" onClick={() => choosePromotion(r)} aria-label={`${ROLE_NAME[r]} (${CHESS_NAME[r]})`} autoFocus={r === 'q'}>
              <span className={`k-card-glyph side-${c}`}>{GLYPH[r]}</span>
              <b>{ROLE_NAME[r]}</b>
              <small>{CHESS_NAME[r]}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Moves() {
  const show = useKingdom((s) => s.showMoves);
  useKingdom((s) => s.rev);
  if (!show) return null;
  const h = kc.game.history;
  const rows: { n: number; w?: string; b?: string }[] = [];
  for (const m of h) {
    const n = Math.ceil(m.ply / 2);
    if (m.colour === 'w') rows.push({ n, w: m.san });
    else if (rows.length && rows.at(-1)!.n === n && !rows.at(-1)!.b) rows.at(-1)!.b = m.san;
    else rows.push({ n, b: m.san });
  }
  return (
    <aside className="k-moves panel" aria-label="Moves">
      <header>
        <h2>Moves</h2>
        <button className="btn icon" aria-label="Close" onClick={() => useKingdom.setState({ showMoves: false })}>×</button>
      </header>
      {rows.length === 0 ? (
        <p className="log-empty">No moves yet.</p>
      ) : (
        <ol>
          {rows.map((r) => (
            <li key={r.n}>
              <span className="k-mn">{r.n}.</span>
              <span>{r.w ?? '…'}</span>
              <span>{r.b ?? ''}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function GameMenu() {
  const s = useKingdom();
  if (!s.showMenu) return null;
  const g = kc.game;
  const close = () => useKingdom.setState({ showMenu: false });
  const canTakeback = kc.opponent === 'ai' && !g.timeControl && !g.over && g.history.some((m) => m.colour === kc.you);
  const isOnline = kc.opponent === 'online';
  const isClash = kc.opponent === 'clash';
  const watching = (isOnline || isClash) && !kc.you;
  const early = g.history.length < 2;
  return (
    <div className="k-scrim" onClick={close}>
      <section className="menu panel k-menu" role="dialog" aria-modal="true" aria-label="Game menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-head">
          <h2>Game</h2>
          <button className="btn icon" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="menu-actions col">
          {canTakeback && <button className="btn" onClick={() => { takeback(); close(); }}>↶ Take back my move</button>}
          {!g.over && !watching && !isClash && kc.opponent !== 'local' && !(isOnline && early) && <button className="btn" onClick={() => { offerDraw(); close(); }}>½ Offer a draw</button>}
          {!g.over && kc.opponent === 'local' && <button className="btn" onClick={() => { offerDraw(); close(); }}>½ Agree a draw</button>}
          {!g.over && !watching && !isClash && <button className="btn" onClick={() => resign()}>{isOnline && early ? '✕ Call the game off (no rating change)' : '⚑ Resign'}</button>}
          {isOnline && <OnlineMenuExtras close={close} />}
          {isClash && <ClashMenuExtras close={close} />}
          <button className="btn" onClick={() => useKingdom.setState((x) => ({ viewFrom: x.viewFrom === 'w' ? 'b' : 'w' }))}>⟲ Turn the board around</button>
          <button className="btn" onClick={() => useKingdom.setState({ showHelp: true })}>? How each soldier moves</button>
          {!isOnline && !isClash && <button className="btn" onClick={() => exitToHome()}>⌂ Leave to the main menu</button>}
        </div>
        <div className="setting">
          <span>Battle animations</span>
          <div className="seg">
            {(['cinematic', 'quick', 'off'] as const).map((v) => (
              <button key={v} className={`btn${s.animSpeed === v ? ' on' : ''}`} aria-pressed={s.animSpeed === v} onClick={() => setAnimSpeed(v)}>
                {v === 'cinematic' ? 'Full' : v === 'quick' ? 'Quick' : 'Off'}
              </button>
            ))}
          </div>
        </div>
        <div className="setting">
          <span>Chess icons over soldiers</span>
          <button className={`btn${s.icons ? ' on' : ''}`} aria-pressed={s.icons} onClick={() => useKingdom.setState({ icons: !s.icons })}>{s.icons ? 'On' : 'Off'}</button>
        </div>
        <div className="setting">
          <span>Sound</span>
          <button className={`btn${s.sound ? ' on' : ''}`} aria-pressed={s.sound} onClick={() => setSound(!s.sound)}>{s.sound ? 'On' : 'Off'}</button>
        </div>
        <div className="setting">
          <span>Graphics</span>
          <button className="btn" onClick={() => useUi.setState({ showSettings: true })}>Settings</button>
        </div>
      </section>
      {s.showHelp && <RulesSheet onClose={() => useKingdom.setState({ showHelp: false })} />}
    </div>
  );
}

function Result() {
  const s = useKingdom();
  if (!s.result || !s.showResult) return null;
  const r = s.result;
  const you = kc.you;
  const won = you !== 'both' && r.winner === you;
  const lost = you !== 'both' && r.winner && r.winner !== you;
  const kicker = r.winner === null ? 'Draw' : you === 'both' ? `${SIDE_NAME[r.winner]} wins` : won ? 'Victory' : 'Defeat';
  const moves = Math.ceil(kc.game.history.length / 2);
  return (
    <div className="k-scrim">
      <section className={`menu panel summary ${won ? 'won' : lost ? 'lost' : ''}`} role="dialog" aria-modal="true" aria-label="Battle report">
        <div className="summary-kicker">{kicker}</div>
        <h2>{resultText(r)}</h2>
        <p className="menu-sub">
          {moves} move{moves === 1 ? '' : 's'}
          {kc.opponent === 'ai' ? ` against the ${AI_LEVELS[s.aiLevel].label} computer` : ''}.
          {' '}Sun lost {kc.game.fallen('w').length}, Moon lost {kc.game.fallen('b').length} soldiers.
        </p>
        <div className="menu-actions">
          <button className="btn btn-primary" onClick={() => startGame({ opponent: kc.opponent })} autoFocus>Rematch</button>
          <button className="btn" onClick={() => useKingdom.setState({ showResult: false, showMoves: true })}>Review the moves</button>
          <button className="btn" onClick={() => exitToHome()}>Main menu</button>
        </div>
      </section>
    </div>
  );
}

function RulesSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="k-scrim" onClick={onClose}>
      <section className="help panel k-rules" role="dialog" aria-modal="true" aria-label="How each soldier moves" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>The armies</h2>
          <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="k-lede">Each kingdom fields sixteen soldiers. They move and capture exactly as chess pieces do, and nothing else. Tap a soldier to see where it can go; tap a marked square to move. Put the enemy King in checkmate to win.</p>
        <dl>
          {(['k', 'q', 'r', 'b', 'n', 'p'] as Role[]).map((r) => (
            <div key={r}>
              <dt>
                <span className="k-rule-glyph">{GLYPH[r]}</span> {ROLE_NAME[r]} <small>({CHESS_NAME[r]})</small>
              </dt>
              <dd>{ROLE_RULE[r]}</dd>
            </div>
          ))}
        </dl>
        <p className="sel-foot">
          Also standard chess: castling (King and Siege Tower), en passant, promotion, check, checkmate, stalemate, threefold repetition and the fifty-move rule. With a clock, run out of time and you lose, unless your opponent could never checkmate.
        </p>
      </section>
    </div>
  );
}

/** Keep the director's speed in step with the setting even before a game starts. */
export function syncDirectorSpeed() {
  const v = useKingdom.getState().animSpeed;
  director.speed = v === 'cinematic' ? 1 : v === 'quick' ? 2.2 : 0;
}
