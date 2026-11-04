/** The admin dashboard: figures, reports, fair-play flags, players, announcements and the audit log. Only admins can open it. */
import { useEffect, useState } from 'react';
import { useOnline } from './online';
import { adminDo, adminGet, openProfile, useSocial } from './social';
import { useKingdom } from './store';

type Stats = Record<string, number>;
interface Report { id: number; reason: string; details: string; game: string | null; target: string; targetId: number; reporter: string | null; timesReported: string; at: string }
interface Flag { id: number; kind: string; details: string; name: string; userId: number; at: string }
interface AdminUser { id: number; name: string; guest: boolean; email: string | null; bannedUntil: number | null; banReason: string | null; reported: number; ratings: { blitz: { rating: number }; rapid: { rating: number } }; record?: { games: number } }
interface Audit { id: number; admin: string; action: string; details: string; at: string }

const STAT_LABELS: [string, string][] = [
  ['online', 'Online now'], ['games', 'Games in play'], ['clashes', 'Clashes in play'], ['players', 'Players'], ['newToday', 'New today'],
  ['gamesToday', 'Games today'], ['gamesTotal', 'Games ever'], ['clusters', 'Clusters'], ['tournaments', 'Tournaments open/running'],
  ['openReports', 'Open reports'], ['openFlags', 'Fair-play flags'], ['suspended', 'Suspended'], ['guests', 'Guest accounts'],
];

function ErrorLine() {
  const e = useSocial((s) => s.error);
  return e ? <p className="k-error" role="alert">{e}</p> : null;
}

export function AdminScreen() {
  const user = useOnline((s) => s.user);
  const [tab, setTab] = useState<'overview' | 'reports' | 'flags' | 'players' | 'audit'>('overview');
  if (!user?.admin)
    return (
      <div className="k-scrim">
        <section className="k-setup panel"><p>Admins only.</p><button className="btn" onClick={() => useKingdom.setState({ screen: 'home' })}>Back</button></section>
      </div>
    );
  return (
    <div className="k-scrim">
      <section className="k-setup k-online k-admin panel" aria-label="Admin">
        <header className="k-setup-head">
          <button className="btn icon" aria-label="Back" onClick={() => useKingdom.setState({ screen: 'online' })}>←</button>
          <h2>Admin</h2>
        </header>
        <div className="seg k-tabs" role="tablist">
          {(['overview', 'reports', 'flags', 'players', 'audit'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`btn${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <ErrorLine />
        {tab === 'overview' && <Overview />}
        {tab === 'reports' && <Reports />}
        {tab === 'flags' && <Flags />}
        {tab === 'players' && <Players />}
        {tab === 'audit' && <AuditLog />}
      </section>
    </div>
  );
}

function useLoad<T>(path: string, pick: (r: any) => T, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    adminGet<any>(path)
      .then((r) => setData(pick(r)))
      .catch((e: Error) => useSocial.setState({ error: e.message }));
  }, [path, n, ...deps]);
  return [data, () => setN((x) => x + 1)] as const;
}

function Overview() {
  const [stats, reload] = useLoad<Stats>('stats', (r) => r.stats);
  const [text, setText] = useState('');
  useEffect(() => {
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div>
      <div className="k-admin-stats">
        {STAT_LABELS.map(([k, label]) => (
          <div key={k} className={(k === 'openReports' || k === 'openFlags') && stats?.[k] ? 'alert' : ''}>
            <b>{stats ? (stats[k] ?? 0).toLocaleString() : '…'}</b>
            <small>{label}</small>
          </div>
        ))}
      </div>
      <form
        className="k-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await adminDo('announce', { text }, 'Announcement sent to everyone online.')) setText('');
        }}
      >
        <h3 className="k-sub">Announcement to everyone online</h3>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="e.g. The Okeigbo Tech Fest Open starts at 8 pm!" />
        <button className="btn btn-primary" type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}

function BanForm({ userId, name, done }: { userId: number; name: string; done: () => void }) {
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');
  return (
    <form
      className="k-ban"
      onSubmit={async (e) => {
        e.preventDefault();
        if (window.confirm(`Suspend ${name} for ${days >= 36500 ? 'good' : `${days} days`}?`) && (await adminDo('ban', { user: userId, days, reason }, `${name} suspended.`) !== null)) done();
      }}
    >
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How long">
        {[1, 3, 7, 30, 90, 36500].map((d) => <option key={d} value={d}>{d >= 36500 ? 'Permanently' : `${d} day${d > 1 ? 's' : ''}`}</option>)}
      </select>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (the player sees it)" maxLength={200} />
      <button className="btn k-btn-danger" type="submit">Suspend</button>
    </form>
  );
}

function Reports() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [reports, reload] = useLoad<Report[]>(`reports?status=${status}`, (r) => r.reports, [status]);
  const [banning, setBanning] = useState<number | null>(null);
  return (
    <div>
      <div className="seg k-tabs small">
        <button className={`btn${status === 'open' ? ' on' : ''}`} onClick={() => setStatus('open')}>Open</button>
        <button className={`btn${status === 'resolved' ? ' on' : ''}`} onClick={() => setStatus('resolved')}>Resolved</button>
      </div>
      {reports && reports.length === 0 && <p className="log-empty k-empty">No {status} reports.</p>}
      <ul className="k-list">
        {reports?.map((r) => (
          <li key={r.id} className="k-admin-item">
            <div>
              <b><button className="k-link-btn" onClick={() => void openProfile(r.target)}>{r.target}</button></b> · {r.reason}
              <small> · by {r.reporter ?? 'deleted player'} · reported {r.timesReported}× in all · {new Date(r.at).toLocaleString()}</small>
            </div>
            {r.details && <p className="menu-sub">“{r.details}”</p>}
            {r.game && <p className="menu-sub">Game: {r.game}</p>}
            {status === 'open' && (
              <div className="k-cl-req-actions">
                <button className="btn" onClick={() => void adminDo('resolve', { id: r.id, resolution: 'No action needed' }).then(reload)}>No action</button>
                <button className="btn" onClick={() => void adminDo('resolve', { id: r.id, resolution: 'Warned' }).then(reload)}>Warned</button>
                <button className="btn k-btn-danger" onClick={() => setBanning(banning === r.id ? null : r.id)}>Suspend…</button>
              </div>
            )}
            {banning === r.id && (
              <BanForm
                userId={r.targetId}
                name={r.target}
                done={() => {
                  setBanning(null);
                  void adminDo('resolve', { id: r.id, resolution: 'Suspended' }).then(reload);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Flags() {
  const [flags, reload] = useLoad<Flag[]>('flags', (r) => r.flags);
  const label: Record<string, string> = { 'win-trading': 'Possible win trading', 'leaving-games': 'Leaves games', 'rating-climb': 'Sudden rating climb' };
  return (
    <div>
      <p className="menu-sub">Patterns found automatically after games. Nothing is punished on its own; look at the games and decide.</p>
      {flags && flags.length === 0 && <p className="log-empty k-empty">No flags to review.</p>}
      <ul className="k-list">
        {flags?.map((f) => (
          <li key={f.id} className="k-admin-item">
            <div>
              <b><button className="k-link-btn" onClick={() => void openProfile(f.name)}>{f.name}</button></b> · {label[f.kind] ?? f.kind}
              <small> · {new Date(f.at).toLocaleString()}</small>
            </div>
            <p className="menu-sub">{f.details}</p>
            <button className="btn" onClick={() => void adminDo('review-flag', { id: f.id }).then(reload)}>Reviewed</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Players() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [users, reload] = useLoad<AdminUser[]>(`users${search ? `?q=${encodeURIComponent(search)}` : ''}`, (r) => r.users, [search]);
  const [open, setOpen] = useState<number | null>(null);
  const [rename, setRename] = useState('');
  return (
    <div>
      <form className="k-search" onSubmit={(e) => (e.preventDefault(), setSearch(q.trim()))}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" aria-label="Search players" />
        <button className="btn" type="submit">Search</button>
      </form>
      <ul className="k-list">
        {users?.map((u) => (
          <li key={u.id} className="k-admin-item">
            <button className="k-row" onClick={() => setOpen(open === u.id ? null : u.id)}>
              <span className="k-row-main">
                <span>{u.name}{u.guest ? ' (guest)' : ''}{u.bannedUntil && u.bannedUntil > Date.now() ? ' · suspended' : ''}</span>
                <span className="k-board-rating">{Math.max(u.ratings.blitz.rating, u.ratings.rapid.rating)}</span>
              </span>
              <span className="k-row-meta">{u.email ?? 'no email'} · {u.record?.games ?? 0} games · reported {u.reported}×</span>
            </button>
            {open === u.id && (
              <div className="k-admin-actions">
                {u.bannedUntil && u.bannedUntil > Date.now() ? (
                  <>
                    <p className="menu-sub">Suspended until {new Date(u.bannedUntil).toLocaleString()}{u.banReason ? `: ${u.banReason}` : ''}.</p>
                    <button className="btn" onClick={() => void adminDo('unban', { user: u.id }, 'Suspension lifted.').then(reload)}>Lift the suspension</button>
                  </>
                ) : (
                  <BanForm userId={u.id} name={u.name} done={reload} />
                )}
                <form className="k-ban" onSubmit={(e) => (e.preventDefault(), void adminDo('rename', { user: u.id, name: rename }, 'Renamed.').then(reload))}>
                  <input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="New name" maxLength={20} />
                  <button className="btn" type="submit" disabled={!rename}>Rename</button>
                </form>
                <button className="btn" onClick={() => void adminDo('clear-profile', { user: u.id }, 'Picture and bio removed.')}>Remove picture and bio</button>
                <button className="btn" onClick={() => void openProfile(u.name)}>Open profile</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuditLog() {
  const [audit] = useLoad<Audit[]>('audit', (r) => r.audit);
  return (
    <ul className="k-bench">
      {audit?.map((a) => (
        <li key={a.id} className="k-bench-row">
          <span><b>{a.admin ?? '?'}</b> {a.action} <small>{a.details}</small></span>
          <small>{new Date(a.at).toLocaleString()}</small>
        </li>
      ))}
      {audit && audit.length === 0 && <p className="log-empty">Nothing yet.</p>}
    </ul>
  );
}
