/** Tournaments: the list, making one, and a tournament's page (standings, rounds or bracket, entering, your game). */
import { useEffect, useState } from 'react';
import { ONLINE_TIME_CONTROLS, type OnlineTc, type TournamentDetail, type TournamentGame } from '@cr/chess-core';
import { joinGame, openSocket, useOnline, watchGame } from './online';
import { SignInPanel } from './OnlineHud';
import { SocialBar } from './AccountHud';
import { createTournament, loadTournaments, openProfile, openTournament, refreshTournament, tournamentAction, tournamentLink, useSocial } from './social';
import { toast, useKingdom } from './store';

const tcLabel = (tc: OnlineTc) => `${tc.replace('+', ' min + ')} s`;
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'when its organiser starts it');

function ErrorLine() {
  const e = useSocial((s) => s.error);
  return e ? <p className="k-error" role="alert">{e}</p> : null;
}

export function TournamentsScreen() {
  const token = useOnline((s) => s.token);
  const t = useSocial((s) => s.tournament);
  const [making, setMaking] = useState(false);
  useEffect(() => {
    if (token) openSocket();
    void loadTournaments();
  }, [token]);
  return (
    <div className="k-scrim">
      <section className="k-setup k-online k-tourneys panel" aria-label="Tournaments">
        <header className="k-setup-head">
          <button
            className="btn icon"
            aria-label="Back"
            onClick={() => {
              if (t) {
                useSocial.setState({ tournament: null });
                void loadTournaments();
                const u = new URL(location.href);
                u.searchParams.delete('t');
                history.replaceState(null, '', u);
              } else if (making) setMaking(false);
              else useKingdom.setState({ screen: 'home' });
            }}
          >
            ←
          </button>
          <h2>{t ? t.name : making ? 'New tournament' : 'Tournaments'}</h2>
          <SocialBar />
        </header>
        {t ? <TournamentPage t={t} /> : making ? <NewTournament done={() => setMaking(false)} /> : <TournamentList make={() => setMaking(true)} />}
      </section>
    </div>
  );
}

function TournamentList({ make }: { make: () => void }) {
  const list = useSocial((s) => s.tournaments);
  const user = useOnline((s) => s.user);
  const token = useOnline((s) => s.token);
  useEffect(() => {
    const id = setInterval(loadTournaments, 15_000);
    return () => clearInterval(id);
  }, []);
  const groups: [string, typeof list][] = [
    ['In play', list.filter((x) => x.status === 'running')],
    ['Open for entries', list.filter((x) => x.status === 'open')],
    ['Recently finished', list.filter((x) => x.status === 'finished')],
  ];
  return (
    <div className="k-lobby">
      <p className="k-lede">Swiss tournaments (everyone plays every round) and knockouts (lose and you're out). Every game is refereed online with real clocks.</p>
      {!token ? (
        <SignInPanel />
      ) : (
        <div className="menu-actions">
          <button className="btn btn-primary" onClick={make} disabled={!user || user.guest} title={user?.guest ? 'Make a free account to organise tournaments' : undefined}>
            🏆 Organise a tournament
          </button>
        </div>
      )}
      <ErrorLine />
      {list.length === 0 && <p className="log-empty k-empty">No tournaments yet. Organise the first.</p>}
      {groups.map(([title, items]) =>
        items.length ? (
          <div key={title}>
            <h3 className="k-sub">{title}</h3>
            <ul className="k-list">
              {items.map((x) => (
                <li key={x.slug}>
                  <button className={`k-row${x.featured ? ' k-featured' : ''}`} onClick={() => void openTournament(x.slug)}>
                    <span className="k-row-main">
                      <span>{x.featured ? '⭐ ' : ''}{x.name}</span>
                      <span className="k-board-rating">{x.kind === 'swiss' ? 'Swiss' : 'Knockout'}</span>
                    </span>
                    <span className="k-row-meta">
                      {x.tc} · {x.rated ? 'rated' : 'casual'} · {x.players}/{x.maxPlayers} players ·{' '}
                      {x.status === 'open' ? `starts ${when(x.startsAt)}` : x.status === 'running' ? `round ${x.currentRound} of ${x.rounds}` : `won by ${x.winner}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}

function NewTournament({ done }: { done: () => void }) {
  const busy = useSocial((s) => s.busy);
  const admin = useOnline((s) => s.user?.admin);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'swiss' | 'knockout'>('swiss');
  const [tc, setTc] = useState<OnlineTc>('5+3');
  const [rounds, setRounds] = useState(5);
  const [max, setMax] = useState(32);
  const [rated, setRated] = useState(true);
  const [start, setStart] = useState('');
  const [desc, setDesc] = useState('');
  const [featured, setFeatured] = useState(false);
  return (
    <form
      className="k-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await createTournament({ name, kind, tc, rounds, maxPlayers: max, rated, description: desc, featured, ...(start ? { startsAt: new Date(start).toISOString() } : {}) });
        if (ok) done();
      }}
    >
      <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Okeigbo Tech Fest Open" /></label>
      <fieldset className="k-choices row">
        <legend>Format</legend>
        <button type="button" className={`btn k-pill${kind === 'swiss' ? ' on' : ''}`} onClick={() => setKind('swiss')}>Swiss</button>
        <button type="button" className={`btn k-pill${kind === 'knockout' ? ' on' : ''}`} onClick={() => setKind('knockout')}>Knockout</button>
      </fieldset>
      <p className="k-hint">{kind === 'swiss' ? 'Everyone plays every round against someone on a similar score. Best for big groups.' : 'Lose and you’re out. Draws are replayed with colours reversed.'}</p>
      <fieldset className="k-choices row">
        <legend>Clock</legend>
        {ONLINE_TIME_CONTROLS.filter((k) => k !== 'untimed').map((k) => (
          <button key={k} type="button" className={`btn k-pill${tc === k ? ' on' : ''}`} onClick={() => setTc(k)}>{tcLabel(k)}</button>
        ))}
      </fieldset>
      <div className="k-form-row">
        {kind === 'swiss' && (
          <label><span>Rounds</span><input type="number" min={1} max={11} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} /></label>
        )}
        <label><span>Most players</span><input type="number" min={2} max={256} value={max} onChange={(e) => setMax(Number(e.target.value))} /></label>
      </div>
      <label><span>Starts (optional)</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
      <p className="k-hint">Leave it empty to start it yourself when everyone is in.</p>
      <label className="setting"><span>Rated (accounts only)</span><input type="checkbox" checked={rated} onChange={(e) => setRated(e.target.checked)} /></label>
      {admin && <label className="setting"><span>Feature it at the top (admin)</span><input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} /></label>}
      <label><span>About (optional)</span><input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} placeholder="Prizes, rules, who can enter…" /></label>
      <ErrorLine />
      <button className="btn btn-primary" type="submit" disabled={busy || name.trim().length < 3}>Create the tournament</button>
    </form>
  );
}

function TournamentPage({ t }: { t: TournamentDetail }) {
  const user = useOnline((s) => s.user);
  const busy = useSocial((s) => s.busy);
  const [tab, setTab] = useState<'standings' | 'rounds'>(t.status === 'open' ? 'standings' : 'rounds');
  useEffect(() => {
    if (t.status === 'finished' || t.status === 'cancelled') return;
    const id = setInterval(refreshTournament, 5000);
    return () => clearInterval(id);
  }, [t.slug, t.status]);
  const you = t.you;
  const link = tournamentLink(t.slug);
  return (
    <div className="k-lobby">
      <div className="k-cl-stats">
        <div><b>{t.kind === 'swiss' ? 'Swiss' : 'Knockout'}</b><small>{t.rated ? 'rated' : 'casual'}</small></div>
        <div><b>{t.tc}</b><small>clock</small></div>
        <div><b>{t.players}/{t.maxPlayers}</b><small>players</small></div>
        <div>
          <b>{t.status === 'open' ? 'Open' : t.status === 'running' ? `${t.currentRound}/${t.rounds}` : t.status === 'finished' ? '🏆' : 'Off'}</b>
          <small>{t.status === 'open' ? `starts ${when(t.startsAt)}` : t.status === 'running' ? 'round' : t.status === 'finished' ? t.winner : 'cancelled'}</small>
        </div>
      </div>
      {t.description && <p className="menu-sub">{t.description}</p>}
      {t.status === 'finished' && t.winner && <p className="k-callout">🏆 {t.winner} won {t.name}.</p>}
      {you?.game && (
        <button className="btn btn-primary k-big" onClick={() => (useKingdom.setState({ screen: 'online' }), useOnline.setState({ view: 'join', code: you.game }), joinGame(you.game!))}>
          ♞ Go to your game
        </button>
      )}
      <ErrorLine />
      <div className="menu-actions">
        {!user && <p className="menu-sub">Sign in from Play online to enter.</p>}
        {user && t.status === 'open' && !you?.joined && <button className="btn btn-primary" disabled={busy} onClick={() => void tournamentAction('join')}>Enter the tournament</button>}
        {user && you?.joined && (t.status === 'open' || t.status === 'running') && (
          <button className="btn" disabled={busy} onClick={() => window.confirm(t.status === 'running' ? 'Withdraw? You won’t be paired again.' : 'Leave the tournament?') && void tournamentAction('leave')}>
            {t.status === 'running' ? 'Withdraw' : 'Leave'}
          </button>
        )}
        {(you?.creator || you?.admin) && t.status === 'open' && <button className="btn btn-primary" disabled={busy} onClick={() => void tournamentAction('start')}>Start now</button>}
        {(you?.creator || you?.admin) && (t.status === 'open' || t.status === 'running') && (
          <button className="btn" disabled={busy} onClick={() => window.confirm('Cancel the tournament for everyone?') && void tournamentAction('cancel')}>Cancel</button>
        )}
        <button className="btn" onClick={() => copy(link)}>Copy link</button>
        <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(`Join ${t.name} on ChessFront (${t.tc}, ${t.kind}): ${link}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
      </div>
      <div className="seg k-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'standings'} className={`btn${tab === 'standings' ? ' on' : ''}`} onClick={() => setTab('standings')}>{t.status === 'open' ? 'Players' : 'Standings'}</button>
        <button role="tab" aria-selected={tab === 'rounds'} className={`btn${tab === 'rounds' ? ' on' : ''}`} onClick={() => setTab('rounds')} disabled={!t.schedule.length}>{t.kind === 'knockout' ? 'Bracket' : 'Rounds'}</button>
      </div>
      {tab === 'standings' ? <Standings t={t} /> : t.kind === 'knockout' ? <Bracket t={t} /> : <Rounds t={t} />}
    </div>
  );
}

function Standings({ t }: { t: TournamentDetail }) {
  const me = useOnline((s) => s.user?.id);
  if (!t.standings.length) return <p className="log-empty k-empty">Nobody has entered yet. Share the link.</p>;
  return (
    <div className="k-table-wrap">
      <table className="k-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Rating</th>
            {t.kind === 'swiss' ? <><th>Points</th><th title="Buchholz: the total of your opponents' points">Bh</th></> : <th>Status</th>}
          </tr>
        </thead>
        <tbody>
          {t.standings.map((s) => (
            <tr key={s.id} className={s.id === me ? 'you' : s.withdrawn || s.eliminated ? 'out' : ''}>
              <td>{t.status === 'open' ? '' : s.rank}</td>
              <td><button className="k-link-btn" onClick={() => void openProfile(s.name)}>{s.name}</button>{s.withdrawn ? ' (withdrew)' : ''}</td>
              <td>{s.rating}</td>
              {t.kind === 'swiss' ? <><td><b>{s.score}</b></td><td>{s.buchholz}</td></> : <td>{t.status === 'finished' && s.rank === 1 ? '🏆 Champion' : s.eliminated ? 'Out' : t.status === 'open' ? '' : 'Still in'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GameLine({ g }: { g: TournamentGame }) {
  const res = g.result === 'bye' ? 'bye' : g.result ?? 'playing';
  const watch = () => {
    if (!g.code) return;
    useKingdom.setState({ screen: 'online' });
    const me = useOnline.getState().user?.id;
    if (me && (g.white?.id === me || g.black?.id === me)) {
      useOnline.setState({ view: 'join', code: g.code });
      joinGame(g.code);
    } else watchGame(g.code);
  };
  return (
    <li className="k-bench-row">
      <span>
        <span className="side-w-text">☀ {g.white?.name ?? '–'}</span>
        {g.result !== 'bye' && <> <span className="k-vs">v</span> <span className="side-b-text">☾ {g.black?.name ?? '–'}</span></>}
        {g.replay ? <small> (replay)</small> : null}
      </span>
      <span className="k-cl-req-actions">
        <b className={`k-res${g.result ? '' : ' live'}`}>{res}</b>
        {g.reason === 'forfeit' && <small>forfeit</small>}
        {g.code && !g.result && <button className="btn" onClick={watch}>Watch</button>}
      </span>
    </li>
  );
}

function Rounds({ t }: { t: TournamentDetail }) {
  return (
    <div>
      {[...t.schedule].reverse().map((r) => (
        <div key={r.round}>
          <h3 className="k-sub">Round {r.round}</h3>
          <ul className="k-bench">{r.games.map((g) => <GameLine key={`${g.board}-${g.replay}`} g={g} />)}</ul>
        </div>
      ))}
    </div>
  );
}

function Bracket({ t }: { t: TournamentDetail }) {
  const name = (r: number) => (r === t.rounds ? 'Final' : r === t.rounds - 1 ? 'Semi-finals' : r === t.rounds - 2 ? 'Quarter-finals' : `Round ${r}`);
  return (
    <div className="k-bracket">
      {t.schedule.map((r) => (
        <div key={r.round} className="k-bracket-col">
          <h3 className="k-sub">{name(r.round)}</h3>
          <ul className="k-bench">{r.games.map((g) => <GameLine key={`${g.board}-${g.replay}`} g={g} />)}</ul>
        </div>
      ))}
    </div>
  );
}

async function copy(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Link copied.', 'good');
  } catch {
    toast(t);
  }
}
