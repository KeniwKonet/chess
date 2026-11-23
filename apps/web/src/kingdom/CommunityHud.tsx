/** The Community tab in Play online: chat, shared cards, and who's on top. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CHAT_MAX, type ChatCard, type ChatMessage, type ChatShare } from '@cr/chess-core';
import { closeCommunity, openCommunity, removeMessage, say, shareCard, useCommunity } from './community';
import { useOnline } from './online';
import { avatarUrl, openProfile, openReport } from './social';

const TC: Record<string, string> = { '3+2': '3 min + 2 s', '5+3': '5 min + 3 s', '10+5': '10 min + 5 s', '15+10': '15 min + 10 s', untimed: 'no clock' };
const HOW: Record<string, string> = {
  checkmate: 'by checkmate',
  resignation: 'by resignation',
  timeout: 'on time',
  abandoned: 'after the other player left',
};

function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Community() {
  const c = useCommunity();
  const me = useOnline((s) => s.user);
  const canPost = !!me && !me.guest;
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now());
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    openCommunity();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      closeCommunity();
    };
  }, []);

  // Keep the newest message in view unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [c.messages.length, c.loaded]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    say(t);
    setText('');
    stick.current = true;
  };
  const share = (what: ChatShare) => {
    shareCard(what, text.trim());
    setText('');
    stick.current = true;
  };

  return (
    <div className="k-community">
      <Leaders />
      <div className="k-chat-head">
        <span className="k-chat-title">Community chat</span>
        <span className="k-chat-here"><span className="k-chat-dot" aria-hidden="true" />{c.online} here now</span>
      </div>
      <ol
        className="k-chat"
        ref={list}
        aria-live="polite"
        aria-label="Community messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!c.loaded && <li className="log-empty">Loading the community…</li>}
        {c.loaded && c.messages.length === 0 && <li className="log-empty k-empty">No messages yet. Say hello and start the conversation.</li>}
        {c.messages.map((m) => (
          <Message key={m.id} m={m} now={now} mine={m.user.id === me?.id} admin={!!me?.admin} canReport={canPost} />
        ))}
      </ol>
      {canPost ? (
        <>
          <form className="k-chat-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="k-chat-input">Message</label>
            <input
              id="k-chat-input"
              value={text}
              maxLength={CHAT_MAX}
              placeholder="Say something to everyone…"
              autoComplete="off"
              enterKeyHint="send"
              onChange={(e) => setText(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={!text.trim()}>Send</button>
          </form>
          <div className="k-chat-share" role="group" aria-label="Share with the community">
            <button className="btn" onClick={() => share('streak')}>🔥 My win streak</button>
            <button className="btn" onClick={() => share('win')}>🏆 My last win</button>
            <button className="btn" onClick={() => share('rating')}>📈 My rating</button>
          </div>
        </>
      ) : (
        <p className="k-chat-note">{me ? 'Make a free account (above) to chat and share your wins. Guests can read along.' : 'Sign in to chat with the community.'}</p>
      )}
    </div>
  );
}

function Leaders() {
  const b = useCommunity((s) => s.board);
  if (!b) return null;
  const col = (title: string, rows: { name: string; value: string }[], empty: string) => (
    <section className="k-lead">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ol>
          {rows.map((r, i) => (
            <li key={r.name}>
              <span className="k-rank">{i + 1}</span>
              <button className="k-link-btn" onClick={() => void openProfile(r.name)}>{r.name}</button>
              <b>{r.value}</b>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
  return (
    <div className="k-leads">
      {col('🔥 Hot streaks', b.streaks.map((s) => ({ name: s.name, value: `${s.streak}` })), 'Win two in a row to get on here.')}
      {col('Top Blitz', b.blitz.map((r) => ({ name: r.name, value: `${r.rating}${r.provisional ? '?' : ''}` })), 'No rated blitz games yet.')}
      {col('Top Rapid', b.rapid.map((r) => ({ name: r.name, value: `${r.rating}${r.provisional ? '?' : ''}` })), 'No rated rapid games yet.')}
    </div>
  );
}

function Message({ m, now, mine, admin, canReport }: { m: ChatMessage; now: number; mine: boolean; admin: boolean; canReport: boolean }) {
  const pic = avatarUrl(m.user.avatar);
  if (m.card?.kind === 'milestone') {
    return (
      <li className="k-msg k-msg-shout">
        <span className="k-shout-icon" aria-hidden="true">🏆</span>
        <span>
          <button className="k-link-btn" onClick={() => void openProfile(m.user.name)}>{m.user.name}</button> just won <b>{m.card.streak} games in a row</b>! Can anyone stop them?
        </span>
        <time className="k-msg-time">{ago(m.at, now)}</time>
        {admin && <button className="k-msg-act" onClick={() => removeMessage(m.id)}>Remove</button>}
      </li>
    );
  }
  return (
    <li className={`k-msg${mine ? ' mine' : ''}`}>
      <span className="k-msg-pic" aria-hidden="true">{pic ? <img src={pic} alt="" /> : m.user.name.slice(0, 1).toUpperCase()}</span>
      <div className="k-msg-body">
        <div className="k-msg-meta">
          <button className="k-msg-name k-link-btn" onClick={() => void openProfile(m.user.name)}>{m.user.name}</button>
          {m.user.admin && <span className="k-msg-badge">Admin</span>}
          {m.user.rating != null && <span className="k-msg-rating">{m.user.rating}</span>}
          <time className="k-msg-time" dateTime={new Date(m.at).toISOString()}>{ago(m.at, now)}</time>
          {(mine || admin) && <button className="k-msg-act" onClick={() => removeMessage(m.id)}>Remove</button>}
          {!mine && canReport && <button className="k-msg-act" onClick={() => openReport(m.user.name)}>Report</button>}
        </div>
        {m.card && <Card card={m.card} />}
        {m.text && <p className="k-msg-text">{m.text}</p>}
      </div>
    </li>
  );
}

function Card({ card }: { card: ChatCard }) {
  if (card.kind === 'streak')
    return (
      <div className="k-chatcard">
        <span className="k-chatcard-big">🔥 {card.streak}</span>
        <span>
          <b>{card.streak === 1 ? 'win and counting' : 'wins in a row'}</b>
          <small>Best streak: {card.best}</small>
        </span>
      </div>
    );
  if (card.kind === 'win')
    return (
      <div className="k-chatcard">
        <span className="k-chatcard-big">🏆</span>
        <span>
          <b>
            Beat {card.opponent}
            {card.opponentRating != null ? ` (${card.opponentRating})` : ''}
          </b>
          <small>
            {HOW[card.reason] ?? ''}
            {card.moves ? ` in ${card.moves} move${card.moves === 1 ? '' : 's'}` : ''} · {TC[card.tc] ?? card.tc} · {card.rated ? 'rated' : 'casual'}
          </small>
        </span>
      </div>
    );
  if (card.kind === 'rating')
    return (
      <div className="k-chatcard">
        <span className="k-chatcard-big">📈 {card.rating}{card.provisional ? '?' : ''}</span>
        <span>
          <b>{card.category === 'blitz' ? 'Blitz' : 'Rapid'} rating</b>
          <small>{card.rank ? `#${card.rank} on the leaderboard` : 'Still settling in (a few more rated games)'}</small>
        </span>
      </div>
    );
  return null;
}
