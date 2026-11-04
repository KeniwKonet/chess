/** Notifications, friends, your account settings, player profiles, reporting, and the forgotten-password flow. */
import { useEffect, useRef, useState } from 'react';
import { NAME_RULE, ONLINE_TIME_CONTROLS, PASSWORD_MIN, type OnlineTc, type PublicUser } from '@cr/chess-core';
import { api, useOnline } from './online';
import {
  addFriend,
  avatarUrl,
  challengeFriend,
  changePassword,
  deleteAccount,
  loadFriends,
  openNote,
  openPanel,
  openProfile,
  openReport,
  readAll,
  removeFriend,
  removePicture,
  requestReset,
  resetPassword,
  saveEmail,
  saveProfile,
  sendReport,
  signOutEverywhere,
  uploadPicture,
  useSocial,
} from './social';

const COUNTRIES: [string, string][] = [
  ['', 'Not shown'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['CM', 'Cameroon'], ['CI', "Côte d'Ivoire"],
  ['SN', 'Senegal'], ['UG', 'Uganda'], ['TZ', 'Tanzania'], ['RW', 'Rwanda'], ['ET', 'Ethiopia'], ['MA', 'Morocco'], ['DZ', 'Algeria'], ['TN', 'Tunisia'],
  ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'], ['BJ', 'Benin'], ['TG', 'Togo'], ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'], ['IN', 'India'],
  ['FR', 'France'], ['DE', 'Germany'], ['NL', 'Netherlands'], ['ES', 'Spain'], ['IT', 'Italy'], ['BR', 'Brazil'], ['AE', 'United Arab Emirates'], ['CN', 'China'],
];
/** A country's flag emoji from its two-letter code. */
export const flag = (c?: string) => (c && /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '');

export function Avatar({ user, size = 40 }: { user: { name: string; avatar?: string | null }; size?: number }) {
  const src = avatarUrl(user.avatar);
  return src ? (
    <img className="k-av" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="k-av k-av-letter" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ErrorLine() {
  const e = useSocial((s) => s.error);
  return e ? <p className="k-error" role="alert">{e}</p> : null;
}

/** Bell, friends and account buttons for screen headers. */
export function SocialBar() {
  const token = useOnline((s) => s.token);
  const unread = useSocial((s) => s.unread);
  const user = useOnline((s) => s.user);
  if (!token) return null;
  return (
    <div className="k-socialbar">
      <button className="btn icon k-bell" aria-label={`Notifications${unread ? `, ${unread} new` : ''}`} onClick={() => openPanel('notifications')}>
        🔔{unread > 0 && <span className="k-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {user && !user.guest && <button className="btn icon" aria-label="Friends" onClick={() => openPanel('friends')}>👥</button>}
      {user && (
        <button className="btn icon k-me-btn" aria-label="Your account" onClick={() => openPanel('account')}>
          <Avatar user={user} size={26} />
        </button>
      )}
    </div>
  );
}

/** Whichever panel is open, over everything else. */
export function SocialPanels() {
  const panel = useSocial((s) => s.panel);
  if (!panel) return null;
  const close = () => openPanel(null);
  return (
    <div className="k-scrim k-top" onClick={close}>
      <section className="menu panel k-social" role="dialog" aria-modal="true" aria-label={panel} onClick={(e) => e.stopPropagation()}>
        {panel === 'notifications' && <Notes close={close} />}
        {panel === 'friends' && <FriendsPanel close={close} />}
        {panel === 'account' && <AccountPanel close={close} />}
        {panel === 'profile' && <ProfilePanel close={close} />}
        {panel === 'report' && <ReportPanel close={close} />}
        {panel === 'forgot' && <ForgotPanel close={close} />}
      </section>
    </div>
  );
}

function Head({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="menu-head">
      <h2>{title}</h2>
      <button className="btn icon" aria-label="Close" onClick={close}>×</button>
    </div>
  );
}

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

function Notes({ close }: { close: () => void }) {
  const notes = useSocial((s) => s.notes);
  useEffect(() => {
    void readAll();
  }, []);
  const icon = { 'friend-request': '👥', friend: '🤝', challenge: '⚔', cluster: '♜', tournament: '🏆', announcement: '📣', account: '⚙' } as const;
  return (
    <>
      <Head title="Notifications" close={close} />
      {notes.length === 0 ? (
        <p className="log-empty k-empty">Nothing yet. Challenges, friend requests and tournament games show up here.</p>
      ) : (
        <ul className="k-list">
          {notes.map((n) => (
            <li key={n.id}>
              <button className={`k-row k-note${n.read ? '' : ' unread'}`} onClick={() => openNote(n)}>
                <span className="k-row-main"><span>{icon[n.kind]} {n.text}</span></span>
                <span className="k-row-meta">{ago(n.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FriendsPanel({ close }: { close: () => void }) {
  const friends = useSocial((s) => s.friends);
  const busy = useSocial((s) => s.busy);
  const [name, setName] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [tc, setTc] = useState<OnlineTc>('5+3');
  useEffect(() => {
    void loadFriends();
  }, []);
  const received = friends.filter((f) => f.status === 'received');
  const mine = friends.filter((f) => f.status === 'friend');
  const sent = friends.filter((f) => f.status === 'sent');
  return (
    <>
      <Head title="Friends" close={close} />
      <form
        className="k-search"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await addFriend(name.trim())) setName('');
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a friend by name" aria-label="Friend's name" autoCapitalize="off" />
        <button className="btn btn-primary" type="submit" disabled={busy || !NAME_RULE.test(name.trim())}>Add</button>
      </form>
      <ErrorLine />
      {received.length > 0 && (
        <>
          <h3 className="k-sub">Want to be your friend</h3>
          {received.map((f) => (
            <div key={f.id} className="k-cl-req">
              <span className="k-friend-name"><Avatar user={f} size={28} /> <b>{f.name}</b> <small>{f.rating}</small></span>
              <span className="k-cl-req-actions">
                <button className="btn btn-primary" onClick={() => void addFriend(f.name)}>Accept</button>
                <button className="btn" onClick={() => void removeFriend(f.name)} aria-label={`Decline ${f.name}`}>✕</button>
              </span>
            </div>
          ))}
        </>
      )}
      <h3 className="k-sub">Your friends</h3>
      {mine.length === 0 && <p className="log-empty">Add people you play with, then challenge them straight from here.</p>}
      {mine.map((f) => (
        <div key={f.id} className="k-cl-req">
          <button className="k-friend-name k-link-btn" onClick={() => void openProfile(f.name)}>
            <Avatar user={f} size={28} />
            <b>{f.name}</b>
            {f.online && <span className="k-dot" aria-label="online" />}
            <small>{f.rating} · you {f.h2h.wins}–{f.h2h.losses}</small>
          </button>
          <span className="k-cl-req-actions">
            <button className="btn btn-primary" onClick={() => setChallenge(challenge === f.name ? null : f.name)}>⚔ Challenge</button>
          </span>
          {challenge === f.name && (
            <div className="k-challenge">
              {ONLINE_TIME_CONTROLS.map((k) => (
                <button key={k} className={`btn k-pill${tc === k ? ' on' : ''}`} onClick={() => setTc(k)}>{k === 'untimed' ? 'No clock' : k}</button>
              ))}
              <button className="btn btn-primary" onClick={() => challengeFriend(f.name, tc, tc !== 'untimed')}>Send</button>
            </div>
          )}
        </div>
      ))}
      {sent.length > 0 && <p className="k-hint">Waiting for: {sent.map((f) => f.name).join(', ')}</p>}
    </>
  );
}

function AccountPanel({ close }: { close: () => void }) {
  const user = useOnline((s) => s.user) as (PublicUser & { email?: string | null }) | null;
  const busy = useSocial((s) => s.busy);
  const [bio, setBio] = useState(user?.bio ?? '');
  const [country, setCountry] = useState(user?.country ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [pwForEmail, setPwForEmail] = useState('');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [del, setDel] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The full account (with your email) comes from /api/me.
    api<{ user: PublicUser }>('/api/me')
      .then((r) => {
        useOnline.setState({ user: r.user });
        setEmail(r.user.email ?? '');
      })
      .catch(() => {});
  }, []);
  if (!user) return null;
  if (user.guest)
    return (
      <>
        <Head title="Your account" close={close} />
        <p className="k-callout">You're playing as {user.name}. Make a free account in the online lobby to keep a profile, friends and a rating; your games come with you.</p>
      </>
    );
  return (
    <>
      <Head title="Your account" close={close} />
      <div className="k-acct-top">
        <Avatar user={user} size={72} />
        <div>
          <b className="k-acct-name">{flag(user.country)} {user.name}</b>
          <div className="k-acct-pic">
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void uploadPicture(e.target.files[0])} />
            <button className="btn" onClick={() => file.current?.click()} disabled={busy}>Change picture</button>
            {user.avatar && <button className="btn" onClick={() => void removePicture()} disabled={busy}>Remove</button>}
          </div>
        </div>
      </div>
      <ErrorLine />
      <form className="k-form" onSubmit={(e) => (e.preventDefault(), void saveProfile(bio, country))}>
        <label><span>About you</span><input value={bio} maxLength={160} onChange={(e) => setBio(e.target.value)} placeholder="Okeigbo chess club · loves the Sicilian" /></label>
        <label>
          <span>Country</span>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{flag(c)} {n}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>Save profile</button>
      </form>
      <form className="k-form" onSubmit={(e) => (e.preventDefault(), void saveEmail(email.trim(), pwForEmail).then(() => setPwForEmail('')))}>
        <h3 className="k-sub">Email (for password resets)</h3>
        <label><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" /></label>
        <label><span>Your password</span><input type="password" value={pwForEmail} onChange={(e) => setPwForEmail(e.target.value)} autoComplete="current-password" /></label>
        <button className="btn" type="submit" disabled={busy || !pwForEmail}>Save email</button>
      </form>
      <form className="k-form" onSubmit={(e) => (e.preventDefault(), void changePassword(cur, next).then((ok) => ok && (setCur(''), setNext(''))))}>
        <h3 className="k-sub">Change password</h3>
        <label><span>Current password</span><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>
        <label><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
        <button className="btn" type="submit" disabled={busy || !cur || next.length < PASSWORD_MIN}>Change password</button>
      </form>
      <h3 className="k-sub">Sessions</h3>
      <button className="btn" onClick={() => void signOutEverywhere()}>Sign out on every device</button>
      <details className="k-danger">
        <summary>Delete my account</summary>
        <p className="menu-sub">Your name, password, email, picture, friends and notifications are deleted. Finished games stay in your opponents' history as "deleted player". This can't be undone.</p>
        <label className="k-form"><span>Your password</span><input type="password" value={del} onChange={(e) => setDel(e.target.value)} autoComplete="current-password" /></label>
        <button className="btn k-btn-danger" disabled={busy || !del} onClick={() => window.confirm('Delete your ChessFront account for good?') && void deleteAccount(del)}>Delete my account</button>
      </details>
    </>
  );
}

function ProfilePanel({ close }: { close: () => void }) {
  const p = useSocial((s) => s.profile);
  const me = useOnline((s) => s.user);
  if (!p) return null;
  const u = p.user;
  const r = u.record;
  const self = me?.id === u.id;
  return (
    <>
      <Head title={u.name} close={close} />
      <div className="k-acct-top">
        <Avatar user={u} size={72} />
        <div>
          <b className="k-acct-name">{flag(u.country)} {u.name}</b>
          {u.bio && <p className="menu-sub">{u.bio}</p>}
          {p.cluster && <p className="menu-sub">♜ {p.cluster}</p>}
        </div>
      </div>
      <div className="k-cl-stats">
        <div><b>{u.ratings.blitz.rating}{u.ratings.blitz.rd >= 110 ? '?' : ''}</b><small>Blitz</small></div>
        <div><b>{u.ratings.rapid.rating}{u.ratings.rapid.rd >= 110 ? '?' : ''}</b><small>Rapid</small></div>
        <div><b>{r ? `${r.wins}–${r.losses}–${r.draws}` : '–'}</b><small>Won–lost–drawn</small></div>
        <div><b>{r?.bestStreak ?? 0}</b><small>Best streak</small></div>
      </div>
      {p.vsYou && <p className="k-h2h">You {p.vsYou.wins} – {p.vsYou.losses} {u.name}{p.vsYou.draws ? ` (${p.vsYou.draws} drawn)` : ''}</p>}
      {p.games.length > 0 && (
        <>
          <h3 className="k-sub">Recent games</h3>
          <ul className="k-bench">
            {p.games.slice(0, 8).map((g) => {
              const side = g.white?.id === u.id ? 'w' : 'b';
              const opp = side === 'w' ? g.black : g.white;
              const res = !g.result?.winner ? 'Drew' : g.result.winner === side ? 'Beat' : 'Lost to';
              return (
                <li key={g.code} className="k-bench-row">
                  <span>{res} <b>{opp?.name ?? '?'}</b></span>
                  <small>{g.tc} · {g.moves.length} plies</small>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {me && !me.guest && !self && (
        <div className="menu-actions">
          {!p.friend && <button className="btn btn-primary" onClick={() => void addFriend(u.name)}>Add friend</button>}
          {p.friend && <button className="btn btn-primary" onClick={() => challengeFriend(u.name, '5+3', true)}>⚔ Challenge (5+3)</button>}
          <button className="btn" onClick={() => openReport(u.name)}>Report</button>
        </div>
      )}
    </>
  );
}

function ReportPanel({ close }: { close: () => void }) {
  const name = useSocial((s) => s.reportName);
  const busy = useSocial((s) => s.busy);
  const [reason, setReason] = useState('cheating');
  const [details, setDetails] = useState('');
  const reasons: [string, string][] = [
    ['cheating', 'Cheating (using an engine or help)'],
    ['abuse', 'Rude or abusive'],
    ['name', 'Offensive name or picture'],
    ['stalling', 'Stalling or leaving games'],
    ['other', 'Something else'],
  ];
  return (
    <>
      <Head title={`Report ${name}`} close={close} />
      <form
        className="k-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await sendReport(reason, details)) close();
        }}
      >
        <fieldset className="k-choices">
          {reasons.map(([k, label]) => (
            <label key={k} className={`diff${reason === k ? ' on' : ''}`}>
              <input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} />
              <span className="diff-name">{label}</span>
            </label>
          ))}
        </fieldset>
        <label><span>What happened (optional)</span><input value={details} onChange={(e) => setDetails(e.target.value)} maxLength={500} /></label>
        <ErrorLine />
        <button className="btn btn-primary" type="submit" disabled={busy}>Send the report</button>
      </form>
    </>
  );
}

function ForgotPanel({ close }: { close: () => void }) {
  const busy = useSocial((s) => s.busy);
  const [name, setName] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  return (
    <>
      <Head title="Forgot your password?" close={close} />
      {!sent ? (
        <form
          className="k-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await requestReset(name.trim())) setSent(true);
          }}
        >
          <p className="menu-sub">Enter your name or email. If your account has an email address, we send a 6-digit code to it.</p>
          <label><span>Name or email</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="off" /></label>
          <ErrorLine />
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>Send me a code</button>
          <p className="k-hint">No email on your account? Ask an admin to help you back in.</p>
        </form>
      ) : (
        <form
          className="k-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await resetPassword(name.trim(), code.trim(), pw);
          }}
        >
          <p className="menu-sub">If that account has an email, the code is on its way. It works for 15 minutes.</p>
          <label><span>Code</span><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoComplete="one-time-code" /></label>
          <label><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
          <ErrorLine />
          <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length !== 6 || pw.length < PASSWORD_MIN}>Set the new password</button>
        </form>
      )}
    </>
  );
}
