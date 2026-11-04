/** Online play screens: sign-in, lobby (invite a friend, find an opponent, watch, leaderboard), waiting rooms, and the in-game online banners. */
import { useEffect, useReducer, useState, type ReactElement } from 'react';
import { NAME_RULE, ONLINE_TIME_CONTROLS, PASSWORD_MIN, onlineResultText, type Colour, type OnlineTc, type RatingCategory, type SeatInfo } from '@cr/chess-core';
import { kc } from './controller';
import {
  api,
  cancelWaiting,
  claimIn,
  createInvite,
  enterOnline,
  inviteLink,
  joinGame,
  leaveOnlineGame,
  login,
  logout,
  onlineClaim,
  onlineDecline,
  onlineDraw,
  onlineRematch,
  openSocket,
  playAsGuest,
  refreshLive,
  register,
  seek,
  useOnline,
  watchGame,
  watchLink,
} from './online';
import { toast, useKingdom } from './store';
import { shareResult } from './share';

const tcLabel = (tc: OnlineTc) => (tc === 'untimed' ? 'No clock' : `${tc.replace('+', ' min + ')} s`);
const tcShort = (tc: OnlineTc) => (tc === 'untimed' ? '∞' : tc);
const catLabel: Record<RatingCategory, string> = { blitz: 'Blitz', rapid: 'Rapid' };

export const seatName = (p: SeatInfo | null | undefined) => (p ? `${p.name}${p.rating !== null ? ` (${p.rating}${p.provisional ? '?' : ''})` : ''}` : '…');

function useTicker(ms: number) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---------------------------------------------------------------- screens

export function OnlineScreen() {
  const view = useOnline((s) => s.view);
  const token = useOnline((s) => s.token);
  useEffect(() => {
    if (token) openSocket();
  }, [token]);
  return (
    <div className="k-scrim">
      <section className="k-setup k-online panel" aria-label="Play online">
        <header className="k-setup-head">
          <button
            className="btn icon"
            aria-label="Back"
            onClick={() => {
              if (view === 'invite' || view === 'seeking') cancelWaiting();
              useOnline.setState({ view: 'lobby', code: null, error: null });
              useKingdom.setState({ screen: 'home' });
            }}
          >
            ←
          </button>
          <h2>Play online</h2>
          <LinkDot />
        </header>
        {view === 'join' ? <JoinPrompt /> : !token ? <SignIn /> : view === 'invite' ? <InviteWaiting /> : view === 'seeking' ? <Seeking /> : <Lobby />}
      </section>
    </div>
  );
}

function LinkDot() {
  const link = useOnline((s) => s.link);
  if (link === 'off') return null;
  const label = link === 'open' ? 'Connected' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return <span className={`k-link k-link-${link}`} role="status">{label}</span>;
}

function ErrorLine() {
  const error = useOnline((s) => s.error);
  return error ? <p className="k-error" role="alert">{error}</p> : null;
}

export function SignIn({ after }: { after?: () => void }) {
  const busy = useOnline((s) => s.busy);
  const [mode, setMode] = useState<'guest' | 'login' | 'register'>('guest');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const go = async () => {
    const ok = mode === 'guest' ? await playAsGuest() : mode === 'login' ? await login(name, pw) : await register(name, pw);
    if (ok) after?.();
  };
  const nameOk = NAME_RULE.test(name);
  const pwOk = pw.length >= (mode === 'register' ? PASSWORD_MIN : 1);
  return (
    <div className="k-signin">
      <p className="k-lede">Play people anywhere by invite link or quick pairing. Make an account to keep a rating; guests can play casual games straight away.</p>
      <div className="seg k-tabs" role="tablist">
        {(['guest', 'login', 'register'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`btn${mode === m ? ' on' : ''}`} onClick={() => { setMode(m); useOnline.setState({ error: null }); }}>
            {m === 'guest' ? 'Guest' : m === 'login' ? 'Sign in' : 'New account'}
          </button>
        ))}
      </div>
      <form
        className="k-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        {mode !== 'guest' && (
          <>
            <label>
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" maxLength={20} autoCapitalize="off" spellCheck={false} required />
            </label>
            {mode === 'register' && name && !nameOk && <small className="k-hint">3 to 20 letters, numbers, _ or -.</small>}
            <label>
              <span>Password</span>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required />
            </label>
            {mode === 'register' && pw && !pwOk && <small className="k-hint">At least {PASSWORD_MIN} characters.</small>}
          </>
        )}
        {mode === 'guest' && <p className="menu-sub">You get a name like Guest-48211. Casual games only; you can make an account later and keep your games.</p>}
        <ErrorLine />
        <button className="btn btn-primary" type="submit" disabled={busy || (mode !== 'guest' && (!pwOk || (mode === 'register' && !nameOk)))}>
          {busy ? 'One moment…' : mode === 'guest' ? 'Play as a guest' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

function JoinPrompt() {
  const token = useOnline((s) => s.token);
  const code = useOnline((s) => s.code);
  const link = useOnline((s) => s.link);
  const needAccount = useOnline((s) => s.needAccount);
  if (!code) return <Lobby />;
  if (needAccount)
    return (
      <>
        <p className="k-callout">This is a rated game, so it needs a free account. Make one now (your guest games are kept), then you join straight away.</p>
        <Upgrade
          onDone={() => {
            useOnline.setState({ needAccount: false, error: null });
            joinGame(code);
          }}
        />
        <button className="btn k-cancel" onClick={() => useOnline.setState({ view: 'lobby', code: null, needAccount: false, error: null })}>Not now</button>
      </>
    );
  if (!token)
    return (
      <>
        <p className="k-callout">You've been invited to a battle. Choose how to join.</p>
        <SignIn after={() => joinGame(code)} />
      </>
    );
  return (
    <div className="k-wait">
      <div className="k-spinner" aria-hidden="true" />
      <p>{link === 'open' ? 'Joining the battle…' : 'Connecting to the server…'}</p>
      <ErrorLine />
      <button className="btn" onClick={() => useOnline.setState({ view: 'lobby', code: null })}>Back to the lobby</button>
    </div>
  );
}

function Lobby() {
  const s = useOnline();
  const u = s.user;
  const guest = !u || u.guest;
  const canRate = !guest && s.tc !== 'untimed';
  const [tab, setTab] = useState<'play' | 'watch' | 'ranks' | 'rivals'>('play');
  const [upgrade, setUpgrade] = useState(false);
  return (
    <div className="k-lobby">
      <div className="k-me">
        <div>
          <b>{u?.name ?? '…'}</b>
          {u && !u.guest && (
            <small>
              {(['blitz', 'rapid'] as const).map((c) => `${catLabel[c]} ${u.ratings[c].rating}${u.ratings[c].rd >= 110 ? '?' : ''}`).join(' · ')}
            </small>
          )}
          {u?.guest && <small>Guest · casual games</small>}
          {u?.record && u.record.games > 0 && (
            <small className="k-me-record">
              {u.record.wins}W {u.record.losses}L {u.record.draws}D{u.record.streak > 1 ? ` · 🔥 ${u.record.streak} wins in a row` : ''}
              {u.record.bestStreak > 1 ? ` · best streak ${u.record.bestStreak}` : ''}
            </small>
          )}
        </div>
        <div className="k-me-actions">
          {u && !u.guest && u.record && u.record.games > 0 && <button className="btn" onClick={() => shareProfile(u)}>Share</button>}
          {u?.guest && <button className="btn" onClick={() => setUpgrade((x) => !x)}>Make an account</button>}
          <button className="btn" onClick={() => void logout()}>Sign out</button>
        </div>
      </div>
      {upgrade && u?.guest && <Upgrade onDone={() => setUpgrade(false)} />}
      <div className="seg k-tabs" role="tablist">
        {(['play', 'watch', 'ranks', 'rivals'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'play' ? 'Play' : t === 'watch' ? 'Watch' : t === 'ranks' ? 'Leaders' : 'Rivals'}
          </button>
        ))}
      </div>
      {tab === 'play' && (
        <>
          <fieldset className="k-choices row">
            <legend>Clock</legend>
            {ONLINE_TIME_CONTROLS.map((k) => (
              <button key={k} type="button" className={`btn k-pill${s.tc === k ? ' on' : ''}`} aria-pressed={s.tc === k} onClick={() => useOnline.setState({ tc: k })}>
                {tcLabel(k)}
              </button>
            ))}
          </fieldset>
          <fieldset className="k-choices row">
            <legend>Game</legend>
            <button type="button" className={`btn k-pill${s.rated && canRate ? ' on' : ''}`} aria-pressed={s.rated && canRate} disabled={!canRate} onClick={() => useOnline.setState({ rated: true })}>
              Rated
            </button>
            <button type="button" className={`btn k-pill${!(s.rated && canRate) ? ' on' : ''}`} aria-pressed={!(s.rated && canRate)} onClick={() => useOnline.setState({ rated: false })}>
              Casual
            </button>
            {!canRate && <small className="k-hint">{guest ? 'Rated games need an account.' : 'Games with no clock are casual.'}</small>}
          </fieldset>
          <ErrorLine />
          <div className="k-modes">
            <button className="k-mode" onClick={seek} disabled={s.link !== 'open'}>
              <span className="k-mode-glyph">⚔</span>
              <span><b>Find an opponent</b><small>Paired with someone near your rating, {tcLabel(s.tc).toLowerCase()}</small></span>
            </button>
          </div>
          <fieldset className="k-choices row">
            <legend>Invite a friend · your army</legend>
            {(['w', 'b', 'random'] as const).map((c) => (
              <button key={c} type="button" className={`btn k-pill${s.colour === c ? ' on' : ''}`} aria-pressed={s.colour === c} onClick={() => useOnline.setState({ colour: c })}>
                {c === 'w' ? '☀ Sun' : c === 'b' ? '☾ Moon' : 'Random'}
              </button>
            ))}
          </fieldset>
          <div className="k-modes">
            <button className="k-mode" onClick={createInvite} disabled={s.link !== 'open'}>
              <span className="k-mode-glyph">✉</span>
              <span><b>Invite a friend</b><small>Get a link to send on WhatsApp or anywhere</small></span>
            </button>
          </div>
        </>
      )}
      {tab === 'watch' && <LiveList />}
      {tab === 'ranks' && <Leaderboard />}
      {tab === 'rivals' && u && <Rivals name={u.name} />}
    </div>
  );
}

function Upgrade({ onDone }: { onDone: () => void }) {
  const busy = useOnline((s) => s.busy);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  return (
    <form
      className="k-form k-upgrade"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await register(name, pw)) {
          toast(`Welcome, ${name}. Your games are kept.`, 'good');
          onDone();
        }
      }}
    >
      <p className="menu-sub">Choose a name and password. Your guest games stay with you, and you can play rated games.</p>
      <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" maxLength={20} autoCapitalize="off" required /></label>
      <label><span>Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required /></label>
      <ErrorLine />
      <button className="btn btn-primary" type="submit" disabled={busy || !NAME_RULE.test(name) || pw.length < PASSWORD_MIN}>Create account</button>
    </form>
  );
}

function LiveList() {
  const live = useOnline((s) => s.live);
  useEffect(() => {
    void refreshLive();
    const id = setInterval(refreshLive, 8000);
    return () => clearInterval(id);
  }, []);
  if (!live.length) return <p className="log-empty k-empty">No battles in progress right now. Start one, and others can watch it here.</p>;
  return (
    <ul className="k-list">
      {live.map((g) => (
        <li key={g.code}>
          <button className="k-row" onClick={() => watchGame(g.code)}>
            <span className="k-row-main">
              <span className="side-w-text">☀ {seatName(g.white)}</span>
              <span className="side-b-text">☾ {seatName(g.black)}</span>
            </span>
            <span className="k-row-meta">
              {tcShort(g.tc)} · {g.rated ? 'rated' : 'casual'} · move {Math.ceil(g.moves / 2) || 1}
              {g.watchers > 0 ? ` · ${g.watchers} watching` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Leaderboard() {
  const [cat, setCat] = useState<RatingCategory>('blitz');
  const [rows, setRows] = useState<{ name: string; rating: number; games: number; provisional: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api<{ players: { name: string; rating: number; games: number; provisional: boolean }[] }>(`/api/leaderboard?cat=${cat}`)
      .then((r) => setRows(r.players))
      .catch((e: Error) => setErr(e.message));
  }, [cat]);
  return (
    <div>
      <div className="seg k-tabs small">
        {(['blitz', 'rapid'] as const).map((c) => (
          <button key={c} className={`btn${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{catLabel[c]}</button>
        ))}
      </div>
      {err && <p className="k-error">{err}</p>}
      {!rows && !err && <p className="log-empty">Loading…</p>}
      {rows && rows.length === 0 && <p className="log-empty k-empty">No rated {catLabel[cat].toLowerCase()} games yet. Be the first on the board.</p>}
      {rows && rows.length > 0 && (
        <ol className="k-board">
          {rows.map((r, i) => (
            <li key={r.name}>
              <span className="k-rank">{i + 1}</span>
              <span className="k-board-name">{r.name}</span>
              <span className="k-board-rating">{r.rating}{r.provisional ? '?' : ''}</span>
              <small>{r.games} game{r.games === 1 ? '' : 's'}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function InviteWaiting() {
  const code = useOnline((s) => s.code)!;
  const tc = useOnline((s) => s.tc);
  const link = inviteLink(code);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy the link from the box.', 'warn');
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'ChessFront', text: `Battle me on ChessFront (${tcLabel(tc)})`, url: link });
    } catch {
      /* closed */
    }
  };
  const wa = `https://wa.me/?text=${encodeURIComponent(`Battle me on ChessFront, the living chess game: ${link}`)}`;
  return (
    <div className="k-wait">
      <div className="k-spinner" aria-hidden="true" />
      <p><b>Waiting for your friend.</b> Send them this link; the battle starts when they open it.</p>
      <input className="k-linkbox" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
      <div className="menu-actions">
        <button className="btn btn-primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        {typeof navigator !== 'undefined' && 'share' in navigator && <button className="btn" onClick={share}>Share…</button>}
        <a className="btn" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>
      </div>
      <button className="btn k-cancel" onClick={cancelWaiting}>Cancel the invite</button>
    </div>
  );
}

function Seeking() {
  const seeking = useOnline((s) => s.seeking);
  return (
    <div className="k-wait">
      <div className="k-spinner" aria-hidden="true" />
      <p>
        <b>Looking for an opponent…</b>
        <br />
        {seeking ? `${tcLabel(seeking.tc)}, ${seeking.rated ? 'rated' : 'casual'}.` : ''} The battle starts as soon as someone is found.
      </p>
      <button className="btn k-cancel" onClick={cancelWaiting}>Stop looking</button>
    </div>
  );
}

// ---------------------------------------------------------------- in game

/** Draw offers, an opponent who left, the connection, and spectators. */
export function OnlineBanner() {
  useTicker(500);
  const g = useOnline((s) => s.game);
  const link = useOnline((s) => s.link);
  if (!g || kc.opponent !== 'online') return null;
  const opp: Colour | null = g.you ? (g.you === 'w' ? 'b' : 'w') : null;
  const claim = claimIn();
  const items: ReactElement[] = [];
  if (link !== 'open' && g.status === 'playing') items.push(<div key="link" className="k-banner warn" role="status">Connection lost. Reconnecting… your moves are safe on the server.</div>);
  if (g.status === 'playing' && opp && g.drawOffer === opp)
    items.push(
      <div key="draw" className="k-banner" role="alert">
        Your opponent offers a draw.
        <button className="btn btn-primary" onClick={onlineDraw}>Accept</button>
        <button className="btn" onClick={onlineDecline}>Decline</button>
      </div>,
    );
  if (g.status === 'playing' && opp && claim !== null)
    items.push(
      <div key="away" className="k-banner warn" role="status">
        {claim > 0 ? `Your opponent left. You can claim the win in ${Math.ceil(claim / 1000)} s if they don't return.` : 'Your opponent has not come back.'}
        {claim === 0 && <button className="btn btn-primary" onClick={onlineClaim}>{kc.game.history.length < 2 ? 'Call the game off' : 'Claim the win'}</button>}
      </div>,
    );
  if (!g.you)
    items.push(
      <div key="watch" className="k-banner subtle" role="status">
        👁 Watching live{g.presence.watchers > 1 ? ` with ${g.presence.watchers - 1} other${g.presence.watchers > 2 ? 's' : ''}` : ''}
      </div>,
    );
  else if (g.presence.watchers > 0 && g.status === 'playing') items.push(<div key="spec" className="k-banner subtle">👁 {g.presence.watchers} watching</div>);
  if (!items.length) return null;
  return <div className="k-banners">{items}</div>;
}

/** The report at the end of an online game. */
export function OnlineResult() {
  const g = useOnline((s) => s.game);
  const s = useKingdom();
  if (!g || !s.result || !s.showResult) return null;
  const r = s.result;
  const names: Record<Colour, string> = { w: g.white?.name ?? 'Sun', b: g.black?.name ?? 'Moon' };
  const you = g.you;
  const won = you && r.winner === you;
  const lost = you && r.winner && r.winner !== you;
  const aborted = g.status === 'aborted';
  const kicker = aborted ? 'Called off' : r.winner === null ? 'Draw' : !you ? `${names[r.winner]} wins` : won ? 'Victory' : 'Defeat';
  const rc = g.ratingChange;
  const opp: Colour | null = you ? (you === 'w' ? 'b' : 'w') : null;
  const backToLobby = () => {
    leaveOnlineGame();
    useKingdom.setState({ showResult: false });
    enterOnline();
  };
  return (
    <div className="k-scrim">
      <section className={`menu panel summary ${won ? 'won' : lost ? 'lost' : ''}`} role="dialog" aria-modal="true" aria-label="Battle report">
        <div className="summary-kicker">{kicker}</div>
        <h2>{onlineResultText(r.reason, r.winner, names, g.status)}</h2>
        <p className="menu-sub">
          ☀ {names.w} vs ☾ {names.b} · {tcLabel(g.tc)} · {g.rated ? 'rated' : 'casual'} · {Math.ceil(kc.game.history.length / 2)} moves
        </p>
        {rc && (
          <ul className="k-rating-change">
            {(['w', 'b'] as const).map((c) => {
              const d = rc[c].after - rc[c].before;
              return (
                <li key={c} className={c === you ? 'you' : ''}>
                  <span>{names[c]}</span>
                  <span>{rc[c].before} → <b>{rc[c].after}</b></span>
                  <span className={d >= 0 ? 'up' : 'down'}>{d >= 0 ? `+${d}` : d}</span>
                </li>
              );
            })}
          </ul>
        )}
        {you && opp && g.h2h && (
          <p className="k-h2h">
            {(() => {
              const mine = you === 'w' ? g.h2h : { wins: g.h2h.losses, losses: g.h2h.wins, draws: g.h2h.draws };
              return (
                <>
                  You {mine.wins} – {mine.losses} {names[opp]}
                  {mine.draws ? ` (${mine.draws} drawn)` : ''}
                </>
              );
            })()}
            {g.streaks && g.streaks[you] > 1 && <span className="k-streak">🔥 {g.streaks[you]} wins in a row</span>}
          </p>
        )}
        {you && opp && g.rematchOffer === opp && <p className="k-callout">Your opponent wants a rematch.</p>}
        <div className="menu-actions">
          {won && opp && (
            <button className="btn" onClick={() => shareWin(g, you!, opp, names)}>Share the win</button>
          )}
          {you && !g.rematchNext && (
            <button className="btn btn-primary" onClick={onlineRematch} disabled={g.rematchOffer === you} autoFocus>
              {g.rematchOffer === you ? 'Rematch offered…' : g.rematchOffer === opp ? 'Accept the rematch' : 'Rematch'}
            </button>
          )}
          <button className="btn" onClick={() => useKingdom.setState({ showResult: false, showMoves: true })}>Review the moves</button>
          <button className="btn" onClick={() => copyText(you ? watchLink(g.code) : location.href)}>Copy game link</button>
          <button className="btn" onClick={backToLobby}>Back to the lobby</button>
        </div>
      </section>
    </div>
  );
}

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Link copied.', 'good');
  } catch {
    toast(t);
  }
}

/** Shown on the game menu for online games. */
export function OnlineMenuExtras({ close }: { close: () => void }) {
  const g = useOnline((s) => s.game);
  if (!g) return null;
  return (
    <>
      {g.status === 'playing' && <button className="btn" onClick={() => { copyText(watchLink(g.code)); close(); }}>👁 Copy a link for spectators</button>}
      <button
        className="btn"
        onClick={() => {
          leaveOnlineGame();
          close();
          enterOnline();
        }}
      >
        ⇦ Back to the online lobby{g.status === 'playing' && g.you ? ' (your clock keeps running)' : ''}
      </button>
    </>
  );
}


export const SignInPanel = SignIn;

function shareWin(g: NonNullable<ReturnType<typeof useOnline.getState>['game']>, you: Colour, opp: Colour, names: Record<Colour, string>) {
  const lines: string[] = [];
  const rc = g.ratingChange;
  if (rc) lines.push(`Rating ${rc[you].after} (+${rc[you].after - rc[you].before})`);
  if (g.h2h) {
    const mine = you === 'w' ? g.h2h : { wins: g.h2h.losses, losses: g.h2h.wins, draws: g.h2h.draws };
    lines.push(`Head to head: ${mine.wins}–${mine.losses}${mine.draws ? ` (${mine.draws} drawn)` : ''} against ${names[opp]}`);
  }
  const streak = g.streaks?.[you] ?? 0;
  void shareResult({
    kicker: 'Victory',
    title: `${names[you]} beat ${names[opp]}`,
    lines: lines.length ? lines : [`${tcLabel(g.tc)} · ${Math.ceil(kc.game.history.length / 2)} moves`],
    ...(streak > 1 ? { badge: { value: String(streak), label: 'win streak' } } : {}),
    url: location.origin + location.pathname,
  });
}

function shareProfile(u: NonNullable<ReturnType<typeof useOnline.getState>['user']>) {
  const r = u.record!;
  void shareResult({
    kicker: 'My ChessFront record',
    title: u.name,
    lines: [
      `Blitz ${u.ratings.blitz.rating} · Rapid ${u.ratings.rapid.rating}`,
      `${r.wins} wins, ${r.losses} losses, ${r.draws} draws`,
      ...(r.bestStreak > 1 ? [`Best win streak: ${r.bestStreak}`] : []),
    ],
    ...(r.streak > 1 ? { badge: { value: String(r.streak), label: 'win streak' } } : {}),
    url: location.origin + location.pathname,
  });
}

/** Everyone you've played, and the score against each. */
function Rivals({ name }: { name: string }) {
  const [rows, setRows] = useState<{ name: string; wins: number; losses: number; draws: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ rivals: { name: string; wins: number; losses: number; draws: number }[] }>(`/api/users/${encodeURIComponent(name)}`)
      .then((r) => setRows(r.rivals))
      .catch((e: Error) => setErr(e.message));
  }, [name]);
  if (err) return <p className="k-error">{err}</p>;
  if (!rows) return <p className="log-empty">Loading…</p>;
  if (!rows.length) return <p className="log-empty k-empty">Your head-to-head scores appear here once you've finished a game.</p>;
  return (
    <ol className="k-board">
      {rows.map((r) => (
        <li key={r.name}>
          <span className="k-rank">{r.wins > r.losses ? '▲' : r.wins < r.losses ? '▼' : '='}</span>
          <span className="k-board-name">{r.name}</span>
          <span className="k-board-rating">{r.wins}–{r.losses}</span>
          <small>{r.draws ? `${r.draws} drawn` : ''}</small>
        </li>
      ))}
    </ol>
  );
}
