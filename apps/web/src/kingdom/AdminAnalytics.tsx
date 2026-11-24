/** The admin dashboard's Analytics tab: visitors, games of every kind, players, community and events. */
import { useEffect, useState } from 'react';
import { adminGet, openProfile, useSocial } from './social';

type Row<K extends string> = Record<K, string> & { n: number };
interface BrowserGames {
  started: number; finished: number; startedToday: number; startedWeek: number; startedRange: number; finishedRange: number;
  players: number; playersRange: number; avgMoves: number; avgMinutes: number;
}
interface Report {
  days: number;
  trackingSince: number | null;
  visitors: { today: number; week: number; month: number; range: number; ever: number; visits: number; returning: number; devices: Row<'device'>[]; referrers: Row<'referrer'>[] };
  computer: BrowserGames & { results: Row<'result'>[]; levels: { level: string; started: number; finished: number; wins: number; losses: number; draws: number }[] };
  local: BrowserGames;
  online: {
    ever: number; today: number; week: number; range: number; rated: number; casual: number; tournament: number; aborted: number; players: number; avgMoves: number; avgMinutes: number;
    timeControls: Row<'tc'>[]; endings: Row<'reason'>[]; winners: Row<'winner'>[]; busiestHours: { hour: number; n: number }[]; mostActive: Row<'name'>[];
  };
  players: {
    accounts: number; guests: number; withEmail: number; newToday: number; newWeek: number; newRange: number; guestsRange: number; activeToday: number; activeWeek: number;
    rated: number; suspended: number; deleted: number; countries: Row<'country'>[]; bestStreaks: Row<'name'>[];
  };
  social: { messages: number; messagesRange: number; chatters: number; shared: number; friendships: number; reports: number; openReports: number };
  events: { tournaments: number; tournamentsFinished: number; tournamentsLive: number; tournamentEntries: number; clusters: number; clusterMembers: number; clashes: number };
  peaks: { onlineToday: number; onlineRange: number; onlineEver: number; gamesEver: number };
  daily: { day: string; visitors: number; computer: number; local: number; online: number; signups: number }[];
}

const RANGES = [7, 30, 90, 365] as const;
const LEVEL: Record<string, string> = { squire: 'Squire (easiest)', knight: 'Knight', lord: 'Lord', warlord: 'Warlord (hardest)' };
const LEVEL_ORDER = ['squire', 'knight', 'lord', 'warlord'];
const RESULT: Record<string, string> = { win: 'Player won', loss: 'Computer won', resigned: 'Player resigned', draw: 'Draw' };
const ENDING: Record<string, string> = {
  checkmate: 'Checkmate', resignation: 'Resignation', timeout: 'Ran out of time', abandoned: 'Left the game', stalemate: 'Stalemate',
  agreement: 'Agreed draw', repetition: 'Repetition', 'fifty-move': 'Fifty-move rule', material: 'Not enough pieces', insufficient: 'Not enough pieces',
};
const TC: Record<string, string> = { '3+2': '3 min + 2 s', '5+3': '5 min + 3 s', '10+5': '10 min + 5 s', '15+10': '15 min + 10 s', untimed: 'No clock' };
const WIN: Record<string, string> = { w: 'Sun (white) won', b: 'Moon (black) won', draw: 'Draw' };
const DEVICE: Record<string, string> = { phone: 'Phone', tablet: 'Tablet', desktop: 'Computer', unknown: 'Unknown' };

const f = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function Analytics() {
  const [days, setDays] = useState<number>(30);
  const [r, setR] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    adminGet<{ analytics: Report }>(`analytics?days=${days}`)
      .then((x) => {
        setR(x.analytics);
        useSocial.setState({ error: null });
      })
      .catch((e: Error) => useSocial.setState({ error: e.message }))
      .finally(() => setBusy(false));
  };
  useEffect(load, [days]);
  const span = days === 7 ? 'last 7 days' : days === 365 ? 'last 12 months' : `last ${days} days`;

  return (
    <div className="k-ana" aria-busy={busy}>
      <div className="k-ana-bar">
        <div className="seg" role="group" aria-label="Period">
          {RANGES.map((d) => (
            <button key={d} className={`btn${days === d ? ' on' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d === 365 ? '12 months' : `${d} days`}
            </button>
          ))}
        </div>
        <button className="btn" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
        {r && <button className="btn" onClick={() => downloadCsv(r)}>Download daily CSV</button>}
      </div>
      {!r ? (
        <p className="log-empty">Loading analytics…</p>
      ) : (
        <>
          <p className="k-ana-note">
            Games against the computer, pass-and-play games and visitors are counted from{' '}
            {r.trackingSince ? <b>{new Date(r.trackingSince).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</b> : <b>now on</b>}
            {' '}(they happen in the player’s browser, so earlier ones weren’t recorded). Online games, players and everything else go back to the start.
          </p>

          <Section title="Visitors" sub={`Unique browsers, ${span} unless marked`}>
            <Tiles items={[
              ['Today', r.visitors.today], ['This week', r.visitors.week], ['This month', r.visitors.month], [`In the ${span}`, r.visitors.range],
              ['All time', r.visitors.ever], ['Visits (page opens)', r.visitors.visits], ['Came back on another day', r.visitors.returning, pct(r.visitors.returning, r.visitors.range)],
            ]} />
            <div className="k-ana-cols">
              <Breakdown title="Devices" rows={r.visitors.devices.map((x) => [DEVICE[x.device] ?? x.device, x.n])} />
              <Breakdown title="Where visitors came from" rows={r.visitors.referrers.map((x) => [x.referrer, x.n])} empty="No referrers yet (direct visits and shared links that hide where they came from)." />
            </div>
          </Section>

          <Section title="Games against the computer" sub={`Started games, ${span} unless marked`}>
            <Tiles items={[
              ['All time', r.computer.started], ['Today', r.computer.startedToday], ['This week', r.computer.startedWeek], [`In the ${span}`, r.computer.startedRange],
              ['Finished (all time)', r.computer.finished, pct(r.computer.finished, r.computer.started)], ['Players (all time)', r.computer.players], [`Players, ${span}`, r.computer.playersRange],
              ['Average length', r.computer.avgMoves, 'moves'], ['Average time', r.computer.avgMinutes, 'minutes'],
            ]} />
            <div className="k-ana-cols">
              <Breakdown title={`How they ended (${span})`} rows={r.computer.results.map((x) => [RESULT[x.result] ?? x.result, x.n])} empty="No finished games yet." />
              <LevelTable levels={r.computer.levels} />
            </div>
          </Section>

          <Section title="Pass-and-play (two people, one device)" sub={`Started games, ${span} unless marked`}>
            <Tiles items={[
              ['All time', r.local.started], ['Today', r.local.startedToday], ['This week', r.local.startedWeek], [`In the ${span}`, r.local.startedRange],
              ['Finished (all time)', r.local.finished, pct(r.local.finished, r.local.started)], ['Devices used (all time)', r.local.players],
              ['Average length', r.local.avgMoves, 'moves'], ['Average time', r.local.avgMinutes, 'minutes'],
            ]} />
          </Section>

          <Section title="Online games" sub={`Finished games, ${span} unless marked`}>
            <Tiles items={[
              ['All time', r.online.ever], ['Today', r.online.today], ['This week', r.online.week], [`In the ${span}`, r.online.range],
              ['Rated', r.online.rated, pct(r.online.rated, r.online.range)], ['Casual', r.online.casual, pct(r.online.casual, r.online.range)], ['In tournaments', r.online.tournament],
              ['Called off before a move', r.online.aborted], ['Different players', r.online.players], ['Average length', r.online.avgMoves, 'moves'], ['Average time', r.online.avgMinutes, 'minutes'],
            ]} />
            <div className="k-ana-cols">
              <Breakdown title="Clocks chosen" rows={r.online.timeControls.map((x) => [TC[x.tc] ?? x.tc, x.n])} empty="No online games yet." />
              <Breakdown title="How games ended" rows={r.online.endings.map((x) => [ENDING[x.reason] ?? x.reason, x.n])} empty="No online games yet." />
              <Breakdown title="Who won" rows={r.online.winners.map((x) => [WIN[x.winner] ?? x.winner, x.n])} empty="No online games yet." />
              <Ranked title="Most games played" rows={r.online.mostActive} unit="games" />
            </div>
            <Hours rows={r.online.busiestHours} />
          </Section>

          <Section title="Players" sub="Accounts, all time unless marked">
            <Tiles items={[
              ['Accounts', r.players.accounts], ['Guest players', r.players.guests], ['With an email', r.players.withEmail, pct(r.players.withEmail, r.players.accounts)],
              ['New today', r.players.newToday], ['New this week', r.players.newWeek], [`New, ${span}`, r.players.newRange], [`Guests, ${span}`, r.players.guestsRange],
              ['Signed in today', r.players.activeToday], ['Signed in this week', r.players.activeWeek], ['Have a rating', r.players.rated],
              ['Suspended now', r.players.suspended], ['Deleted accounts', r.players.deleted],
            ]} />
            <div className="k-ana-cols">
              <Breakdown title="Countries" rows={r.players.countries.map((x) => [x.country, x.n])} empty="No player has set a country yet." />
              <Ranked title="Best win streaks ever" rows={r.players.bestStreaks} unit="wins" />
            </div>
          </Section>

          <Section title="Busiest moments" sub="Checked every 5 minutes">
            <Tiles items={[
              ['Most online today', r.peaks.onlineToday], [`Most online, ${span}`, r.peaks.onlineRange], ['Most online ever', r.peaks.onlineEver], ['Most games at once, ever', r.peaks.gamesEver],
            ]} />
          </Section>

          <Section title="Community, tournaments and clusters">
            <Tiles items={[
              ['Chat messages (all time)', r.social.messages], [`Messages, ${span}`, r.social.messagesRange], [`People who chatted, ${span}`, r.social.chatters], [`Cards shared, ${span}`, r.social.shared],
              ['Friendships', r.social.friendships], [`Reports, ${span}`, r.social.reports], ['Open reports', r.social.openReports],
              ['Tournaments (all)', r.events.tournaments], ['Tournaments finished', r.events.tournamentsFinished], ['Open or running', r.events.tournamentsLive], ['Tournament entries', r.events.tournamentEntries],
              ['Clusters', r.events.clusters], ['Cluster members', r.events.clusterMembers], ['Clashes played', r.events.clashes],
            ]} />
          </Section>

          <Section title="Day by day" sub={`${span}, Lagos time. Hover or tap a bar for the figure.`}>
            <div className="k-ana-charts">
              <Bars title="Visitors" data={r.daily.map((d) => [d.day, d.visitors])} />
              <Bars title="Games against the computer" data={r.daily.map((d) => [d.day, d.computer])} />
              <Bars title="Online games" data={r.daily.map((d) => [d.day, d.online])} />
              <Bars title="Pass-and-play games" data={r.daily.map((d) => [d.day, d.local])} />
              <Bars title="New accounts" data={r.daily.map((d) => [d.day, d.signups])} />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="k-ana-sec">
      <h3>{title}</h3>
      {sub && <p className="k-ana-sub">{sub}</p>}
      {children}
    </section>
  );
}

function Tiles({ items }: { items: [string, number, string?][] }) {
  return (
    <div className="k-admin-stats k-ana-tiles">
      {items.map(([label, n, extra]) => (
        <div key={label}>
          <b>
            {f(n)}
            {extra && <em> {extra}</em>}
          </b>
          <small>{label}</small>
        </div>
      ))}
    </div>
  );
}

/** Labelled horizontal bars, one hue: the label and figure carry the meaning. */
function Breakdown({ title, rows, empty = 'Nothing yet.' }: { title: string; rows: [string, number][]; empty?: string }) {
  const total = rows.reduce((a, [, n]) => a + n, 0);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="k-ana-box">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="k-ana-empty">{empty}</p>
      ) : (
        <ul className="k-ana-hbars">
          {rows.map(([label, n]) => (
            <li key={label}>
              <span className="k-ana-hlabel">{label}</span>
              <span className="k-ana-hval">{f(n)} <small>{pct(n, total)}</small></span>
              <span className="k-ana-htrack" aria-hidden="true"><span style={{ width: `${(n / max) * 100}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Ranked({ title, rows, unit }: { title: string; rows: Row<'name'>[]; unit: string }) {
  return (
    <div className="k-ana-box">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="k-ana-empty">Nobody yet.</p>
      ) : (
        <ol className="k-ana-ranked">
          {rows.map((x, i) => (
            <li key={x.name}>
              <span className="k-rank">{i + 1}</span>
              <button className="k-link-btn" onClick={() => void openProfile(x.name)}>{x.name}</button>
              <span>{f(x.n)} {x.n === 1 ? unit.replace(/s$/, '') : unit}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LevelTable({ levels }: { levels: Report['computer']['levels'] }) {
  const rows = LEVEL_ORDER.map((l) => levels.find((x) => x.level === l) ?? { level: l, started: 0, finished: 0, wins: 0, losses: 0, draws: 0 });
  return (
    <div className="k-ana-box k-ana-wide">
      <h4>By difficulty</h4>
      <div className="k-ana-table">
        <table>
          <thead>
            <tr><th scope="col">Level</th><th scope="col">Started</th><th scope="col">Finished</th><th scope="col">Player won</th><th scope="col">Computer won</th><th scope="col">Draws</th><th scope="col">Player win rate</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.level}>
                <th scope="row">{LEVEL[x.level] ?? x.level}</th>
                <td>{f(x.started)}</td><td>{f(x.finished)}</td><td>{f(x.wins)}</td><td>{f(x.losses)}</td><td>{f(x.draws)}</td><td>{pct(x.wins, x.finished)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A single-series bar chart of daily figures. */
function Bars({ title, data, fmt, per = 'in a day' }: { title: string; data: [string, number][]; fmt?: (k: string) => string; per?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map(([, n]) => n));
  const total = data.reduce((a, [, n]) => a + n, 0);
  const W = 600, H = 120, gap = data.length > 60 ? 1 : 2;
  const bw = W / data.length;
  const shown = hover == null ? null : data[hover]!;
  const nice = fmt ?? ((d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  return (
    <figure className="k-ana-chart">
      <figcaption>
        <span>{title}</span>
        <span className="k-ana-chart-val">{shown ? <>{nice(shown[0])}: <b>{f(shown[1])}</b></> : <>Total <b>{f(total)}</b> · most {per} <b>{f(total === 0 ? 0 : max)}</b></>}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`${title}, ${data.length} days, total ${total}`} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H} y2={H} className="k-ana-axis" />
        {data.map(([d, n], i) => {
          const h = n ? Math.max(2, (n / max) * (H - 6)) : 0;
          const x = i * bw + gap / 2;
          const w = Math.max(1, bw - gap);
          const r = Math.min(4, w / 2, h);
          return (
            <g key={d} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={i * bw} y="0" width={bw} height={H} fill="transparent" />
              {h > 0 && (
                <path
                  className={hover === i ? 'on' : ''}
                  d={`M${x},${H} V${H - h + r} Q${x},${H - h} ${x + r},${H - h} H${x + w - r} Q${x + w},${H - h} ${x + w},${H - h + r} V${H} Z`}
                />
              )}
              <title>{`${nice(d)}: ${n}`}</title>
            </g>
          );
        })}
        <text x="0" y={H + 14} className="k-ana-tick">{nice(data[0]![0])}</text>
        <text x={W} y={H + 14} textAnchor="end" className="k-ana-tick">{nice(data.at(-1)![0])}</text>
      </svg>
    </figure>
  );
}

function Hours({ rows }: { rows: { hour: number; n: number }[] }) {
  const all = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.hour === h)?.n ?? 0);
  if (!all.some(Boolean)) return null;
  const label = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return (
    <div className="k-ana-hours">
      <Bars title="Online games by hour of day (Lagos time)" data={all.map((n, h) => [String(h), n])} fmt={(k) => label(Number(k))} per="in one hour" />
      <p className="k-ana-sub">Busiest hour: <b>{label(all.indexOf(Math.max(...all)))}</b></p>
    </div>
  );
}

function downloadCsv(r: Report) {
  const lines = ['day,visitors,computer_games,pass_and_play_games,online_games,new_accounts', ...r.daily.map((d) => [d.day, d.visitors, d.computer, d.local, d.online, d.signups].join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `chessfront-daily-${r.days}d.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
