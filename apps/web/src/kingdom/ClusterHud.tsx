/** Clusters (your army of players) and Clash of Clusters: the cluster screen, and the panels during a clash. */
import { useEffect, useReducer, useState } from 'react';
import {
  CLASH_TURN_SECS,
  CLUSTER_ROLES,
  ROLE_TITLE,
  onlineResultText,
  rolePieceId,
  type ClusterDetail,
  type ClusterMember,
  type ClusterRole,
  type Colour,
} from '@cr/chess-core';
import { GLYPH } from './board';
import {
  acceptClash,
  askToJoin,
  assignSoldier,
  backProposal,
  cancelClash,
  challenge,
  clashDraw,
  clashLink,
  clashResign,
  createCluster,
  decide,
  leaveClash,
  leaveCluster,
  loadMine,
  mySoldiers,
  openClash,
  playProposal,
  removeMember,
  searchClusters,
  setRole,
  substitute,
  turnLeft,
  useClusters,
  viewCluster,
} from './clash';
import { kc } from './controller';
import { openSocket, useOnline } from './online';
import { SignInPanel } from './OnlineHud';
import { shareResult } from './share';
import { toast, useKingdom } from './store';

const ROLE_GLYPH = (r: ClusterRole) => GLYPH[r[0] as 'k' | 'q' | 'r' | 'b' | 'n' | 'p'];
const BACK_RANK: ClusterRole[] = ['r1', 'n1', 'b1', 'q', 'k', 'b2', 'n2', 'r2'];
const FRONT_RANK: ClusterRole[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

function useTicker(ms: number) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
}

function ErrorLine() {
  const error = useClusters((s) => s.error);
  return error ? <p className="k-error" role="alert">{error}</p> : null;
}

// ---------------------------------------------------------------- the cluster screen

export function ClustersScreen() {
  const token = useOnline((s) => s.token);
  const user = useOnline((s) => s.user);
  const mine = useClusters((s) => s.mine);
  const viewing = useClusters((s) => s.viewing);
  useEffect(() => {
    if (!token) return;
    openSocket();
    void loadMine();
    void searchClusters();
  }, [token]);
  return (
    <div className="k-scrim">
      <section className="k-setup k-online k-clusters panel" aria-label="Clash of Clusters">
        <header className="k-setup-head">
          <button
            className="btn icon"
            aria-label="Back"
            onClick={() => {
              if (viewing) return void viewCluster(null);
              useKingdom.setState({ screen: 'home' });
            }}
          >
            ←
          </button>
          <h2>{viewing ? viewing.name : mine && token && !user?.guest ? mine.name : 'Clash of Clusters'}</h2>
        </header>
        {!token ? (
          <>
            <p className="k-lede">A cluster is a team that fights as one army. Every member holds a chess role and commands that soldier when your cluster clashes with another. Sign in to create or join one.</p>
            <SignInPanel />
          </>
        ) : user?.guest ? (
          <>
            <p className="k-callout">Clusters need a free account so your King can find you again. Make one from the online lobby (your games are kept).</p>
            <button className="btn btn-primary" onClick={() => useKingdom.setState({ screen: 'online' })}>Go to the online lobby</button>
          </>
        ) : viewing ? (
          <ClusterView c={viewing} />
        ) : mine ? (
          <MyCluster c={mine} />
        ) : (
          <NoCluster />
        )}
      </section>
    </div>
  );
}

function NoCluster() {
  const list = useClusters((s) => s.list);
  const requests = useClusters((s) => s.requests);
  const loading = useClusters((s) => s.loading);
  const [name, setName] = useState('');
  const [motto, setMottoText] = useState('');
  const [q, setQ] = useState('');
  return (
    <div className="k-lobby">
      <p className="k-lede">
        Gather up to sixteen players, one for every soldier in a chess army. As founder you are the King: you give each member a role, bring substitutes on, and decide your cluster's moves in a clash.
      </p>
      <form
        className="k-form k-upgrade"
        onSubmit={async (e) => {
          e.preventDefault();
          await createCluster(name, motto);
        }}
      >
        <b>Found a cluster</b>
        <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required placeholder="e.g. Okeigbo Lions" /></label>
        <label><span>Motto (optional)</span><input value={motto} onChange={(e) => setMottoText(e.target.value)} maxLength={80} placeholder="One army, one King" /></label>
        <ErrorLine />
        <button className="btn btn-primary" type="submit" disabled={loading || name.trim().length < 3}>Found it and become King</button>
      </form>
      <h3 className="k-sub">Or join one</h3>
      {requests.length > 0 && <p className="k-callout">Waiting for an answer from: {requests.join(', ')}.</p>}
      <form
        className="k-search"
        onSubmit={(e) => {
          e.preventDefault();
          void searchClusters(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clusters" aria-label="Search clusters" />
        <button className="btn" type="submit">Search</button>
      </form>
      <ClusterList list={list} />
    </div>
  );
}

function ClusterList({ list }: { list: ReturnType<typeof useClusters.getState>['list'] }) {
  if (!list.length) return <p className="log-empty k-empty">No clusters yet. Found the first one.</p>;
  return (
    <ul className="k-list">
      {list.map((c) => (
        <li key={c.id}>
          <button className="k-row" onClick={() => void viewCluster(c.name)}>
            <span className="k-row-main">
              <span>{c.name}</span>
              <span className="k-board-rating">{c.rating}{c.provisional ? '?' : ''}</span>
            </span>
            <span className="k-row-meta">
              King {c.king} · {c.members}/16 soldiers · power {c.power.toLocaleString()} · {c.record.wins}W {c.record.losses}L {c.record.draws}D
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Stats({ c }: { c: ClusterDetail }) {
  return (
    <div className="k-cl-stats">
      <div><b>{c.rating}{c.provisional ? '?' : ''}</b><small>Clash rating</small></div>
      <div><b>{c.power.toLocaleString()}</b><small>Joint power</small></div>
      <div><b>{c.members}/16</b><small>Soldiers</small></div>
      <div><b>{c.record.wins}–{c.record.losses}–{c.record.draws}</b><small>Won–lost–drawn</small></div>
    </div>
  );
}

/** Someone else's cluster. */
function ClusterView({ c }: { c: ClusterDetail }) {
  const mine = useClusters((s) => s.mine);
  return (
    <div className="k-lobby">
      {c.motto && <p className="k-motto">“{c.motto}”</p>}
      <Stats c={c} />
      <Army c={c} king={false} />
      <ErrorLine />
      <div className="menu-actions">
        {!mine && !c.you && <button className="btn btn-primary" onClick={() => void askToJoin(c.name)}>Ask to join</button>}
        {c.you?.status === 'pending' && <p className="k-callout">Your request is with King {c.king}.</p>}
        {mine && mine.you?.king && mine.id !== c.id && (
          <button className="btn btn-primary" onClick={() => challenge(60, c.name)}>⚔ Challenge {c.name}</button>
        )}
      </div>
      <Recent c={c} />
    </div>
  );
}

function MyCluster({ c }: { c: ClusterDetail }) {
  const king = !!c.you?.king;
  const [tab, setTab] = useState<'army' | 'clash' | 'find'>('army');
  const list = useClusters((s) => s.list);
  const pending = c.roster.filter((m) => m.status === 'pending');
  return (
    <div className="k-lobby">
      {c.motto && <p className="k-motto">“{c.motto}”</p>}
      <p className="menu-sub">
        {king ? 'You are the King of this cluster.' : `You serve King ${c.king} as ${c.you?.role ? ROLE_TITLE[c.you.role] : c.you?.status === 'sub' ? 'a substitute' : 'a spectator'}.`}
      </p>
      <Stats c={c} />
      <div className="seg k-tabs" role="tablist">
        {(['army', 'clash', 'find'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'army' ? `Army${king && pending.length ? ` (${pending.length})` : ''}` : t === 'clash' ? 'Clash' : 'Other clusters'}
          </button>
        ))}
      </div>
      <ErrorLine />
      {tab === 'army' && (
        <>
          {king && pending.length > 0 && <Requests c={c} pending={pending} />}
          <Army c={c} king={king} />
          <Bench c={c} king={king} />
          <div className="menu-actions">
            <button
              className="btn"
              onClick={() => {
                if (confirmLeave(king)) void leaveCluster(c.name);
              }}
            >
              Leave the cluster
            </button>
          </div>
        </>
      )}
      {tab === 'clash' && <ClashLobby c={c} king={king} />}
      {tab === 'find' && <ClusterList list={list.filter((x) => x.id !== c.id)} />}
    </div>
  );
}

function confirmLeave(king: boolean) {
  // A plain browser confirm keeps this simple and works everywhere.
  return window.confirm(king ? 'Leave your cluster? The crown passes to your longest-serving member.' : 'Leave this cluster?');
}

function Requests({ c, pending }: { c: ClusterDetail; pending: ClusterMember[] }) {
  return (
    <div className="k-cl-requests">
      <h3 className="k-sub">Asking to join</h3>
      {pending.map((m) => (
        <div key={m.id} className="k-cl-req">
          <span><b>{m.name}</b> <small>{m.rating}</small></span>
          <div className="k-cl-req-actions">
            <button className="btn btn-primary" onClick={() => void decide(c.name, m.id, 'member')}>Member</button>
            <button className="btn" onClick={() => void decide(c.name, m.id, 'sub')}>Substitute</button>
            <button className="btn" onClick={() => void decide(c.name, m.id, 'spectator')}>Spectator</button>
            <button className="btn" onClick={() => void decide(c.name, m.id, 'reject')} aria-label={`Turn down ${m.name}`}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The sixteen roles laid out like an army: back rank, then the Footmen. */
function Army({ c, king }: { c: ClusterDetail; king: boolean }) {
  const [pick, setPick] = useState<ClusterRole | null>(null);
  const holder = (r: ClusterRole) => c.roster.find((m) => m.role === r && m.status === 'member');
  const kingName = c.king;
  const slot = (r: ClusterRole) => {
    const h = holder(r);
    return (
      <button
        key={r}
        className={`k-slot${h ? '' : ' open'}${pick === r ? ' on' : ''}${r === 'k' ? ' king' : ''}`}
        onClick={() => (king ? setPick(pick === r ? null : r) : undefined)}
        aria-label={`${ROLE_TITLE[r]}: ${h ? h.name : `open, commanded by King ${kingName}`}`}
        disabled={!king}
      >
        <span className="k-slot-glyph">{ROLE_GLYPH(r)}</span>
        <span className="k-slot-name">{h ? h.name : 'open'}</span>
        {h?.online && <span className="k-dot" aria-label="online" />}
      </button>
    );
  };
  // The King stays King; only the King's own slot can pass the crown.
  const candidates = c.roster.filter((m) => (m.status === 'member' || m.status === 'sub') && (pick === 'k' || m.role !== 'k'));
  return (
    <div className="k-army">
      <div className="k-rank">{BACK_RANK.map(slot)}</div>
      <div className="k-rank">{FRONT_RANK.map(slot)}</div>
      <p className="k-hint">{king ? 'Tap a role to give it to someone. Open roles are yours to command in a clash.' : `Open roles are commanded by King ${kingName} in a clash.`}</p>
      {king && pick && (
        <div className="k-pick">
          <b>{ROLE_TITLE[pick]}</b>
          <div className="k-pick-list">
            {candidates.map((m) => (
              <button
                key={m.id}
                className={`btn${m.role === pick ? ' on' : ''}`}
                onClick={async () => {
                  if (pick === 'k' && m.id !== c.roster.find((x) => x.role === 'k')?.id && !window.confirm(`Pass the crown to ${m.name}? They become King and you take their role.`)) return;
                  await setRole(c.name, m.id, pick);
                  setPick(null);
                }}
              >
                {m.name}
                {m.role && m.role !== pick ? ` (now ${ROLE_TITLE[m.role]})` : m.status === 'sub' ? ' (sub)' : ''}
              </button>
            ))}
          </div>
          {pick !== 'k' && holder(pick) && (
            <button className="btn" onClick={() => void substituteMenu(c, holder(pick)!)}>Substitute {holder(pick)!.name}…</button>
          )}
        </div>
      )}
    </div>
  );
}

async function substituteMenu(c: ClusterDetail, out: ClusterMember) {
  const subs = c.roster.filter((m) => m.status === 'sub');
  if (!subs.length) return toast('No substitutes on the bench. Take a request in as a substitute first.', 'warn');
  const choice = window.prompt(`Who comes on for ${out.name}?\n${subs.map((s, i) => `${i + 1}. ${s.name}`).join('\n')}`, '1');
  const n = Number(choice);
  if (!choice || !subs[n - 1]) return;
  await substitute(c.name, out.id, subs[n - 1]!.id);
}

function Bench({ c, king }: { c: ClusterDetail; king: boolean }) {
  const subs = c.roster.filter((m) => m.status === 'sub');
  const specs = c.roster.filter((m) => m.status === 'spectator');
  const row = (m: ClusterMember, label: string) => (
    <li key={m.id} className="k-bench-row">
      <span>{m.name} <small>{m.rating}</small>{m.online && <span className="k-dot" aria-label="online" />}</span>
      {king && (
        <span className="k-cl-req-actions">
          {m.status === 'spectator' && <button className="btn" onClick={() => void decide(c.name, m.id, 'sub')}>Make substitute</button>}
          {m.status === 'sub' && <button className="btn" onClick={() => void decide(c.name, m.id, 'member')}>Give a role</button>}
          <button className="btn" onClick={() => void removeMember(c.name, m.id)} aria-label={`Remove ${m.name}`}>✕</button>
        </span>
      )}
      <small className="k-tag">{label}</small>
    </li>
  );
  if (!subs.length && !specs.length) return null;
  return (
    <div>
      {subs.length > 0 && <><h3 className="k-sub">Substitutes</h3><ul className="k-bench">{subs.map((m) => row(m, 'sub'))}</ul></>}
      {specs.length > 0 && <><h3 className="k-sub">Spectators</h3><ul className="k-bench">{specs.map((m) => row(m, 'watches'))}</ul></>}
    </div>
  );
}

function ClashLobby({ c, king }: { c: ClusterDetail; king: boolean }) {
  const open = useClusters((s) => s.open);
  const live = useClusters((s) => s.live);
  const waiting = useClusters((s) => s.waiting);
  const [secs, setSecs] = useState<number>(60);
  const [target, setTarget] = useState('');
  useEffect(() => {
    void loadMine();
    const id = setInterval(() => void loadMine(), 10_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div>
      <p className="menu-sub">
        Your cluster plays as one army. On your turn, members propose moves with their own soldiers and back the ones they like; the King plays one. When the turn timer runs out, the most-backed move plays.
      </p>
      {king ? (
        waiting ? (
          <div className="k-wait">
            <div className="k-spinner" aria-hidden="true" />
            <p><b>Challenge sent.</b> Send this link to the other cluster’s King.</p>
            <input className="k-linkbox" readOnly value={clashLink(waiting)} onFocus={(e) => e.currentTarget.select()} aria-label="Clash link" />
            <div className="menu-actions">
              <button className="btn btn-primary" onClick={() => void copy(clashLink(waiting))}>Copy link</button>
              <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(`${c.name} challenges your cluster to a Clash of Clusters on ChessFront: ${clashLink(waiting)}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
              <button className="btn" onClick={() => cancelClash(waiting)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="k-choices row">
              <legend>Time for each turn</legend>
              {CLASH_TURN_SECS.map((s) => (
                <button key={s} type="button" className={`btn k-pill${secs === s ? ' on' : ''}`} aria-pressed={secs === s} onClick={() => setSecs(s)}>
                  {s < 60 ? `${s} s` : `${s / 60} min`}
                </button>
              ))}
            </fieldset>
            <form
              className="k-search"
              onSubmit={(e) => {
                e.preventDefault();
                challenge(secs, target.trim() || undefined);
              }}
            >
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Cluster name (optional)" aria-label="Cluster to challenge" />
              <button className="btn btn-primary" type="submit">⚔ Challenge</button>
            </form>
            <p className="k-hint">Name a cluster to challenge it directly, or leave it empty to get a link any cluster’s King can accept.</p>
          </>
        )
      ) : (
        <p className="k-callout">Your King starts and accepts clashes. When one begins, you are called to the battlefield.</p>
      )}
      {open.length > 0 && (
        <>
          <h3 className="k-sub">Challenges for your cluster</h3>
          <ul className="k-list">
            {open.map((o) => (
              <li key={o.code} className="k-cl-req">
                <span><b>{o.from}</b> <small>{o.fromRating} · {o.turnSecs < 60 ? `${o.turnSecs} s` : `${o.turnSecs / 60} min`} turns{o.target ? '' : ' · open challenge'}</small></span>
                {king && <button className="btn btn-primary" onClick={() => acceptClash(o.code)}>Accept</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {live.length > 0 && (
        <>
          <h3 className="k-sub">Clashes in progress</h3>
          <ul className="k-list">
            {live.map((l) => (
              <li key={l.code}>
                <button className="k-row" onClick={() => openClash(l.code)}>
                  <span className="k-row-main"><span className="side-w-text">☀ {l.white}</span><span className="side-b-text">☾ {l.black}</span></span>
                  <span className="k-row-meta">move {Math.ceil(l.moves / 2) || 1} · tap to join or watch</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Recent c={c} />
    </div>
  );
}

function Recent({ c }: { c: ClusterDetail }) {
  if (!c.recent.length) return null;
  return (
    <>
      <h3 className="k-sub">Recent clashes</h3>
      <ul className="k-bench">
        {c.recent.map((r) => {
          const side: Colour | null = r.white === c.name ? 'w' : r.black === c.name ? 'b' : null;
          const res = r.winner === 'draw' ? 'Drew' : r.winner === side ? 'Beat' : 'Lost to';
          return (
            <li key={r.code} className="k-bench-row">
              <span>{res} <b>{side === 'w' ? r.black : r.white}</b></span>
              <small>{r.moves} moves</small>
            </li>
          );
        })}
      </ul>
    </>
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

// ---------------------------------------------------------------- during a clash

/** Turn timer, your soldiers, your cluster's proposals, and the King's controls. */
export function ClashPanel() {
  useTicker(250);
  const c = useClusters((s) => s.clash);
  const me = useOnline((s) => s.user?.id);
  const [assign, setAssign] = useState(false);
  if (!c || kc.opponent !== 'clash' || c.status !== 'playing') return null;
  const turn = kc.game.turn;
  const ours = c.you && turn === c.you;
  const left = turnLeft();
  const side = c.you ? (c.you === 'w' ? c.white : c.black) : null;
  const soldiers = mySoldiers();
  return (
    <aside className="k-clash panel" aria-label="Clash of Clusters">
      <div className="k-clash-head">
        <span className={`k-turn side-${turn}`}>{ours ? 'Your cluster’s turn' : `${(turn === 'w' ? c.white : c.black)?.name ?? ''} to move`}</span>
        {left !== null && <span className={`k-clock running${left < 10 ? ' low' : ''}`}>{Math.ceil(left)}</span>}
      </div>
      {c.you && (
        <p className="k-clash-you">
          {c.youKing ? 'You are King: tap any of your soldiers and your move is final.' : soldiers.length ? <>You command: {soldiers.map((r) => <span key={r} className="k-chip-role">{ROLE_GLYPH(r)} {ROLE_TITLE[r]}</span>)}</> : 'You command no soldier right now. Back your teammates’ proposals.'}
        </p>
      )}
      {!c.you && <p className="k-clash-you">👁 Watching{c.watchers > 1 ? ` with ${c.watchers - 1} others` : ''}</p>}
      {ours && (
        <div className="k-props">
          {c.proposals.length === 0 && <p className="log-empty">No proposals yet. {c.youKing ? 'Wait for your members or move yourself.' : 'Move one of your soldiers to propose it.'}</p>}
          {[...c.proposals]
            .sort((a, b) => b.backers.length - a.backers.length || a.id - b.id)
            .map((p, i) => (
              <div key={p.id} className={`k-prop${i === 0 ? ' lead' : ''}`}>
                <span className="k-prop-san">{p.san}</span>
                <span className="k-prop-by">{p.byName}</span>
                <span className="k-prop-n" aria-label={`${p.backers.length} backing`}>👍 {p.backers.length}</span>
                {me && p.by !== me && (
                  <button className={`btn${p.backers.includes(me) ? ' on' : ''}`} onClick={() => backProposal(p.id)} aria-pressed={p.backers.includes(me)}>Back</button>
                )}
                {c.youKing && <button className="btn btn-primary" onClick={() => playProposal(p.id)}>Play</button>}
              </div>
            ))}
        </div>
      )}
      {c.youKing && side && (
        <div className="k-clash-king">
          <button className="btn" onClick={() => setAssign((x) => !x)} aria-expanded={assign}>Hand out soldiers</button>
          <button className="btn" onClick={() => clashDraw()}>{c.drawOffer && c.drawOffer !== c.you ? 'Accept the draw' : '½ Offer a draw'}</button>
          <button className="btn" onClick={() => window.confirm('Surrender the clash for your whole cluster?') && clashResign()}>⚑ Surrender</button>
        </div>
      )}
      {c.youKing && assign && side && <AssignSoldiers />}
      {c.drawOffer && c.you && c.drawOffer !== c.you && !c.youKing && <p className="k-callout">The other cluster offers a draw. Your King decides.</p>}
    </aside>
  );
}

function AssignSoldiers() {
  const c = useClusters((s) => s.clash)!;
  const you = c.you as Colour;
  const side = you === 'w' ? c.white! : c.black!;
  const people = side.members.filter((m) => m.status === 'member' || m.status === 'sub');
  const alive = new Set(kc.game.tracker.at.values());
  return (
    <div className="k-assign">
      {CLUSTER_ROLES.filter((r) => alive.has(rolePieceId(r, you))).map((r) => {
        const owner = c.owners[rolePieceId(r, you)];
        return (
          <label key={r} className="k-assign-row">
            <span>{ROLE_GLYPH(r)} {ROLE_TITLE[r]}</span>
            <select value={owner} onChange={(e) => assignSoldier(r, Number(e.target.value))}>
              {people.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.id === side.kingId ? ' (King)' : m.status === 'sub' ? ' (sub)' : ''}{m.online ? ' ●' : ''}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

/** The report at the end of a clash. */
export function ClashResult() {
  const c = useClusters((s) => s.clash);
  const s = useKingdom();
  if (!c || !s.result || !s.showResult || c.status !== 'over') return null;
  const r = s.result;
  const names: Record<Colour, string> = { w: c.white?.name ?? 'Sun', b: c.black?.name ?? 'Moon' };
  const won = c.you && r.winner === c.you;
  const lost = c.you && r.winner && r.winner !== c.you;
  const rc = c.ratingChange;
  return (
    <div className="k-scrim">
      <section className={`menu panel summary ${won ? 'won' : lost ? 'lost' : ''}`} role="dialog" aria-modal="true" aria-label="Clash report">
        <div className="summary-kicker">{r.winner === null ? 'Draw' : !c.you ? `${names[r.winner]} wins` : won ? 'Your cluster wins' : 'Your cluster lost'}</div>
        <h2>{onlineResultText(r.reason, r.winner, names)}</h2>
        <p className="menu-sub">☀ {names.w} vs ☾ {names.b} · {Math.ceil(kc.game.history.length / 2)} moves</p>
        {rc && (
          <ul className="k-rating-change">
            {(['w', 'b'] as const).map((col) => {
              const d = rc[col].after - rc[col].before;
              return (
                <li key={col} className={col === c.you ? 'you' : ''}>
                  <span>{names[col]}</span>
                  <span>{rc[col].before} → <b>{rc[col].after}</b></span>
                  <span className={d >= 0 ? 'up' : 'down'}>{d >= 0 ? `+${d}` : d}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="menu-actions">
          {won && rc && c.you && (
            <button
              className="btn btn-primary"
              onClick={() =>
                void shareResult({
                  kicker: 'Clash of Clusters',
                  title: `${names[c.you as Colour]} defeated ${names[c.you === 'w' ? 'b' : 'w']}`,
                  lines: [`Cluster rating ${rc[c.you as Colour].after} (+${rc[c.you as Colour].after - rc[c.you as Colour].before})`, `${Math.ceil(kc.game.history.length / 2)} moves, every soldier commanded by a member`],
                  url: clashLink(c.code),
                })
              }
            >
              Share the victory
            </button>
          )}
          <button className="btn" onClick={() => useKingdom.setState({ showResult: false, showMoves: true })}>Review the moves</button>
          <button
            className="btn"
            onClick={() => {
              leaveClash();
              useKingdom.setState({ showResult: false, screen: 'clusters' });
            }}
          >
            Back to the cluster
          </button>
        </div>
      </section>
    </div>
  );
}

/** Menu entries during a clash. */
export function ClashMenuExtras({ close }: { close: () => void }) {
  const c = useClusters((s) => s.clash);
  if (!c) return null;
  return (
    <>
      <button className="btn" onClick={() => { void copy(clashLink(c.code)); close(); }}>👁 Copy a link to watch</button>
      <button
        className="btn"
        onClick={() => {
          leaveClash();
          close();
          useKingdom.setState({ screen: 'clusters' });
        }}
      >
        ⇦ Back to the cluster{c.status === 'playing' && c.you ? ' (the clash goes on)' : ''}
      </button>
    </>
  );
}
