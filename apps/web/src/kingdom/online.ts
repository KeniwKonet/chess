/**
 * Online play in the browser: sign-in (token kept on this device), the
 * connection to the ChessFront server (reconnects by itself), and keeping
 * the board, clocks and players in step with the server, which referees
 * every game.
 *
 * The server address: https://api.chessfront.app, or localhost:8787 when the
 * game itself runs on localhost; `?online=https://…` overrides it for testing.
 */
import { create } from 'zustand';
import {
  KingdomGame,
  ONLINE_TIMING,
  TIME_CONTROLS,
  type ClientMsg,
  type Colour,
  type GameView,
  type KingdomResult,
  type LiveGame,
  type OnlineTc,
  type Presence,
  type PublicUser,
  type ServerMsg,
} from '@cr/chess-core';
import { director } from './director';
import { kc } from './controller';
import { sfx } from './sound';
import { toast, useKingdom } from './store';
import { handleClash, openClash, useClusters } from './clash';
import { loadFriends, loadNotes, onNote, openTournament, useSocial } from './social';

export const ONLINE_BASE = (() => {
  if (typeof location === 'undefined') return 'http://localhost:8787';
  const q = new URLSearchParams(location.search).get('online');
  if (q && /^https?:\/\//.test(q)) return q.replace(/\/$/, '');
  // During development the game (Vite) and the server run on different ports.
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) && location.port !== '8787') return `http://${location.hostname}:8787`;
  // When the server itself serves the game (api.chessfront.app, or a Render/Railway/Fly address), it is the same site.
  if (/^api\./.test(location.hostname) || /\.(onrender\.com|up\.railway\.app|fly\.dev)$/.test(location.hostname)) return location.origin;
  // The game on its static host (chessfront.app, previews) reaches the server at api.chessfront.app.
  return 'https://api.chessfront.app';
})();
const WS_URL = `${ONLINE_BASE.replace(/^http/, 'ws')}/online`;
const TOKEN_KEY = 'cf-token';

export type OnlineView = 'lobby' | 'invite' | 'seeking' | 'join';

export interface OnlineGameMeta {
  code: string;
  tc: OnlineTc;
  rated: boolean;
  status: GameView['status'];
  white: GameView['white'];
  black: GameView['black'];
  you: Colour | null;
  presence: Presence;
  drawOffer: Colour | null;
  rematchOffer: Colour | null;
  rematchNext: string | null;
  ratingChange: GameView['ratingChange'] | null;
  /** Win streaks after the game, and the all-time score between the two (White's side). */
  streaks: Record<Colour, number> | null;
  h2h: { wins: number; losses: number; draws: number } | null;
  /** Server clock minus this device's clock (ms). */
  skew: number;
}

export interface OnlineState {
  /** Connection to the server. */
  link: 'off' | 'connecting' | 'open' | 'down';
  token: string | null;
  user: PublicUser | null;
  view: OnlineView;
  /** Code of the invite we are waiting on, or the game being joined. */
  code: string | null;
  seeking: { tc: OnlineTc; rated: boolean; waiting: number } | null;
  game: OnlineGameMeta | null;
  live: LiveGame[];
  busy: boolean;
  error: string | null;
  /** A guest opened a rated invite: they need an account to join. */
  needAccount: boolean;
  /** Choices in the lobby (remembered). */
  tc: OnlineTc;
  colour: Colour | 'random';
  rated: boolean;
}

const savedToken = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();
const savedPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('cf-online') ?? '{}') as Partial<OnlineState>;
  } catch {
    return {};
  }
})();

export const useOnline = create<OnlineState>(() => ({
  link: 'off',
  token: savedToken,
  user: null,
  view: 'lobby',
  code: null,
  seeking: null,
  game: null,
  live: [],
  busy: false,
  error: null,
  needAccount: false,
  tc: savedPrefs.tc ?? '5+3',
  colour: savedPrefs.colour ?? 'random',
  rated: savedPrefs.rated ?? true,
}));
useOnline.subscribe((s) => {
  try {
    localStorage.setItem('cf-online', JSON.stringify({ tc: s.tc, colour: s.colour, rated: s.rated }));
  } catch {
    /* not kept */
  }
});

function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* not kept */
  }
  useOnline.setState({ token });
}

/* ---------------------------------------------------------------- HTTP */

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const token = useOnline.getState().token;
  let r: Response;
  try {
    r = await fetch(ONLINE_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("Can't reach the ChessFront server. Check your connection and try again.");
  }
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `The server said no (${r.status}).`);
  return data;
}

async function signIn(path: string, body: unknown) {
  useOnline.setState({ busy: true, error: null });
  try {
    const r = await api<{ token: string; user: PublicUser }>(path, body);
    setToken(r.token);
    useOnline.setState({ user: r.user, busy: false });
    reconnect();
    return true;
  } catch (e) {
    useOnline.setState({ busy: false, error: (e as Error).message });
    return false;
  }
}

export const playAsGuest = () => signIn('/api/guest', {});
export const login = (name: string, password: string) => signIn('/api/login', { name, password });
/** Creates an account; a guest keeps their games. */
export const register = (name: string, password: string, email?: string) => signIn('/api/register', { name, password, ...(email ? { email } : {}) });

export async function logout() {
  await api('/api/logout', {}).catch(() => {});
  setToken(null);
  useOnline.setState({ user: null, view: 'lobby', seeking: null, code: null });
  closeSocket();
}

export async function refreshLive() {
  try {
    const r = await api<{ games: LiveGame[] }>('/api/live');
    useOnline.setState({ live: r.games });
  } catch {
    /* lobby shows the connection state */
  }
}

/* ---------------------------------------------------------------- socket */

let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let authed = false;
const outbox: ClientMsg[] = [];
let wantOpen = false;

export function openSocket() {
  wantOpen = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  useOnline.setState({ link: 'connecting' });
  authed = false;
  const sock = new WebSocket(WS_URL);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    useOnline.setState({ link: 'open', error: null });
    const token = useOnline.getState().token;
    if (token) sock.send(JSON.stringify({ t: 'auth', token } satisfies ClientMsg));
    else flushWatch();
    ping();
  };
  sock.onmessage = (e) => {
    let m: ServerMsg;
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    handle(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    authed = false;
    if (!wantOpen) return useOnline.setState({ link: 'off' });
    useOnline.setState({ link: 'down' });
    const wait = Math.min(10_000, 800 * 2 ** retry++);
    retryTimer = setTimeout(openSocket, wait);
  };
}

function closeSocket() {
  wantOpen = false;
  if (retryTimer) clearTimeout(retryTimer);
  const s = ws;
  ws = null;
  s?.close();
  useOnline.setState({ link: 'off' });
}

function reconnect() {
  closeSocket();
  openSocket();
}

/** Watching needs no account: those messages may go before sign-in. */
function flushWatch() {
  for (let i = 0; i < outbox.length; i++) {
    if (outbox[i]!.t === 'watch' || outbox[i]!.t === 'clash-open') {
      ws!.send(JSON.stringify(outbox[i]));
      outbox.splice(i--, 1);
    }
  }
}

export function send(m: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN && (authed || m.t === 'watch' || m.t === 'clash-open' || m.t === 'ping')) ws.send(JSON.stringify(m));
  else {
    outbox.push(m);
    openSocket();
  }
}

let pingTimer: ReturnType<typeof setInterval> | null = null;
function ping() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', at: Date.now() } satisfies ClientMsg));
  }, 20_000);
}

/* ---------------------------------------------------------------- messages */

function handle(m: ServerMsg) {
  const s = useOnline.getState();
  switch (m.t) {
    case 'ready': {
      authed = true;
      useOnline.setState({ user: m.user });
      useSocial.setState({ unread: m.unread ?? 0 });
      void loadNotes();
      void loadFriends();
      // Back in a game after a dropped connection: ask for it again.
      const g = s.game;
      if (g && g.status === 'playing') outbox.unshift({ t: g.you ? 'join' : 'watch', code: g.code });
      const cl = useClusters.getState().clash;
      if (cl && (cl.status === 'playing' || cl.status === 'waiting')) outbox.unshift({ t: 'clash-open', code: cl.code });
      while (outbox.length) ws!.send(JSON.stringify(outbox.shift()));
      return;
    }
    case 'invited':
      useOnline.setState({ view: 'invite', code: m.code, seeking: null });
      setUrl('play', m.code);
      return;
    case 'seeking':
      useOnline.setState({ view: 'seeking', seeking: { tc: m.tc, rated: m.rated, waiting: m.waiting } });
      return;
    case 'cancelled':
      useOnline.setState({ view: 'lobby', seeking: null, code: null });
      setUrl(null);
      return;
    case 'game':
      return loadGame(m.game);
    case 'move':
      return onMove(m);
    case 'end':
      return onEnd(m.code, m.result, m.status, m.ratingChange, m.streaks, m.h2h);
    case 'offer': {
      const g = s.game;
      if (!g || g.code !== m.code) return;
      useOnline.setState({ game: { ...g, drawOffer: m.drawOffer } });
      if (m.drawOffer && m.drawOffer !== g.you && g.you) {
        sfx('check');
        toast('Your opponent offers a draw.', 'good');
      } else if (!m.drawOffer && g.drawOffer === g.you && g.you) toast('Draw declined. Fight on!', 'warn');
      return;
    }
    case 'presence': {
      const g = s.game;
      if (!g || g.code !== m.code) return;
      const opp = g.you ? (g.you === 'w' ? 'b' : 'w') : null;
      if (opp && g.status === 'playing' && g.presence[opp] && !m.presence[opp]) toast('Your opponent lost connection. Their clock keeps running.', 'warn');
      if (opp && g.status === 'playing' && !g.presence[opp] && m.presence[opp]) toast('Your opponent is back.', 'good');
      useOnline.setState({ game: { ...g, presence: m.presence } });
      return;
    }
    case 'rematch': {
      const g = s.game;
      if (!g || g.code !== m.code) return;
      if (m.next) {
        useOnline.setState({ game: { ...g, rematchNext: m.next, rematchOffer: null } });
        send({ t: 'join', code: m.next });
        return;
      }
      useOnline.setState({ game: { ...g, rematchOffer: m.by } });
      if (m.by && m.by !== g.you) toast('Your opponent wants a rematch.', 'good');
      return;
    }
    case 'error':
      if (m.code === 'auth') {
        setToken(null);
        useOnline.setState({ user: null });
      }
      if (m.code === 'rated-guest') {
        useOnline.setState({ view: 'join', needAccount: true, error: m.message });
        if (useKingdom.getState().screen !== 'online') useKingdom.setState({ screen: 'online' });
        return;
      }
      if (m.code === 'missing') {
        useOnline.setState({ view: 'lobby', code: null, error: m.message });
        setUrl(null);
        if (useKingdom.getState().screen !== 'online') useKingdom.setState({ screen: 'online' });
        return;
      }
      toast(m.message, 'warn');
      return;
    case 'pong':
      return;
    case 'notify':
      return onNote(m.note);
    case 'tournament-game':
      // The game itself arrives as a 'game' message and opens the board.
      toast('Your tournament game has started. Good luck!', 'good');
      return;
    case 'clash':
    case 'clash-created':
    case 'clash-challenges':
      return handleClash(m);
  }
}

function setUrl(kind: 'play' | 'watch' | null, code?: string) {
  try {
    const u = new URL(location.href);
    u.searchParams.delete('play');
    u.searchParams.delete('watch');
    if (kind && code) u.searchParams.set(kind, code);
    history.replaceState(null, '', u);
  } catch {
    /* ignore */
  }
}

export const inviteLink = (code: string) => {
  const u = new URL(location.origin + location.pathname);
  for (const [k, v] of new URLSearchParams(location.search)) if (k === 'online') u.searchParams.set(k, v);
  u.searchParams.set('play', code);
  return u.toString();
};
export const watchLink = (code: string) => inviteLink(code).replace('play=', 'watch=');

/** Set both clocks from the server's numbers. */
function setClocks(clocks: Record<Colour, number> | null, running: Colour | null) {
  const g = kc.game;
  if (!clocks || !g.timeControl) return;
  g.clock.w = clocks.w;
  g.clock.b = clocks.b;
  g.turnStartedAt = running ? kc.clockNow() : null;
}

function loadGame(v: GameView) {
  const s = useOnline.getState();
  const meta: OnlineGameMeta = {
    code: v.code,
    tc: v.tc,
    rated: v.rated,
    status: v.status,
    white: v.white,
    black: v.black,
    you: v.you,
    presence: v.presence,
    drawOffer: v.drawOffer,
    rematchOffer: v.rematchOffer ?? null,
    rematchNext: v.rematchOf ?? null,
    ratingChange: v.ratingChange ?? null,
    streaks: s.game?.code === v.code ? s.game.streaks : null,
    h2h: s.game?.code === v.code ? s.game.h2h : null,
    skew: v.serverNow - Date.now(),
  };
  if (v.status === 'waiting') {
    // Our own invite (or a link to it).
    const mine = s.user && v.creator?.id === s.user.id;
    useOnline.setState({ view: mine ? 'invite' : 'join', code: v.code, game: null });
    if (useKingdom.getState().screen !== 'online') useKingdom.setState({ screen: 'online' });
    return;
  }
  const same = s.game?.code === v.code && kc.opponent === 'online' && useKingdom.getState().screen === 'playing';
  useOnline.setState({ game: meta, view: 'lobby', seeking: null, code: null });
  setUrl(v.you ? 'play' : 'watch', v.code);

  // Rebuild the board from the moves unless it already matches.
  const have = kc.game.history.map((m) => m.san);
  const matches = same && have.length <= v.moves.length && have.every((x, i) => x === v.moves[i]);
  if (!matches) {
    const g = new KingdomGame({ timeControl: TIME_CONTROLS[v.tc] ?? null });
    v.moves.forEach((san, i) => g.move(g.turn, san, i));
    kc.game = g;
    kc.ai = null;
    director.sync(g.tracker);
  } else {
    // Catch up on moves we missed while away.
    for (const san of v.moves.slice(have.length)) {
      const r = kc.game.move(kc.game.turn, san, kc.clockNow());
      if (r.ok) void director.play(r.move, kc.game.tracker);
    }
  }
  kc.opponent = 'online';
  kc.you = v.you;
  kc.send = (mv) => {
    const g = useOnline.getState().game;
    if (g && typeof mv !== 'string') send({ t: 'move', code: g.code, ply: kc.game.history.length - 1, move: mv });
  };
  setClocks(v.clocks, v.running);
  const over = v.status === 'over' || v.status === 'aborted';
  if (over && v.result) kc.game.result = { winner: v.result.winner, reason: v.result.reason } as KingdomResult;
  useKingdom.setState((k) => ({
    screen: 'playing',
    opponent: 'online',
    selected: null,
    targets: [],
    promotion: null,
    result: over ? kc.game.result : null,
    showResult: over && !same,
    thinking: false,
    showMenu: false,
    card: null,
    viewFrom: v.you ?? 'w',
    rev: k.rev + 1,
  }));
  if (!same && v.status === 'playing') {
    if (!v.you) toast('You are watching this battle live.');
    else if (v.moves.length === 0) toast(v.you === 'w' ? 'You command the Sun. Make your first move within 30 seconds.' : 'You command the Moon. The Sun moves first.', 'good');
    else toast('Back in the battle.', 'good');
  }
}

function onMove(m: Extract<ServerMsg, { t: 'move' }>) {
  const g = useOnline.getState().game;
  if (!g || g.code !== m.code) return;
  const game = kc.game;
  if (m.ply <= game.history.length) {
    // Our own move coming back (already on the board): just take the server's clocks.
    if (game.history[m.ply - 1]?.san !== m.san) return send({ t: g.you ? 'join' : 'watch', code: g.code });
  } else if (m.ply === game.history.length + 1) {
    const r = game.move(game.turn, m.san, kc.clockNow());
    if (!r.ok) return send({ t: g.you ? 'join' : 'watch', code: g.code });
    useKingdom.setState({ selected: null, targets: [], card: null });
    void director.play(r.move, game.tracker).then(() => useKingdom.setState((k) => ({ rev: k.rev + 1 })));
    if (r.move.check && !r.move.mate && g.you && r.move.colour !== g.you) toast('Check! Your King is under attack.', 'warn');
  } else return send({ t: g.you ? 'join' : 'watch', code: g.code });
  setClocks(m.clocks, m.running);
  useOnline.setState({ game: { ...g, drawOffer: null, skew: m.serverNow - Date.now() } });
  useKingdom.setState((k) => ({ rev: k.rev + 1 }));
}

function onEnd(
  code: string,
  result: { winner: Colour | null; reason: string },
  status: GameView['status'],
  ratingChange?: GameView['ratingChange'],
  streaks?: Record<Colour, number>,
  h2h?: { wins: number; losses: number; draws: number },
) {
  const g = useOnline.getState().game;
  if (!g || g.code !== code) {
    // An invite we were waiting on was closed.
    if (useOnline.getState().code === code) useOnline.setState({ view: 'lobby', code: null });
    return;
  }
  useOnline.setState({ game: { ...g, status, ratingChange: ratingChange ?? null, drawOffer: null, streaks: streaks ?? null, h2h: h2h ?? null } });
  // Keep the lobby's record up to date.
  void api<{ user: PublicUser }>('/api/me').then((r) => useOnline.setState({ user: r.user })).catch(() => {});
  kc.game.result = { winner: result.winner, reason: result.reason } as KingdomResult;
  if (kc.game.timeControl) {
    // Freeze the clocks where they are.
    for (const c of ['w', 'b'] as const) kc.game.clock[c] = kc.game.timeLeft(c, kc.clockNow());
    kc.game.turnStartedAt = null;
  }
  useKingdom.setState({ result: kc.game.result, thinking: false });
  director.celebrate(result.winner, kc.game.tracker, result.reason as KingdomResult['reason']);
  void director.queue.then(() => setTimeout(() => useKingdom.setState({ showResult: true }), director.speed ? 1400 : 200));
  useKingdom.setState((k) => ({ rev: k.rev + 1 }));
}

/* ---------------------------------------------------------------- actions */

export function createInvite() {
  const s = useOnline.getState();
  useOnline.setState({ error: null });
  send({ t: 'invite', tc: s.tc, colour: s.colour, rated: s.rated && !!s.user && !s.user.guest && s.tc !== 'untimed' });
}

export function seek() {
  const s = useOnline.getState();
  useOnline.setState({ error: null });
  send({ t: 'seek', tc: s.tc, rated: s.rated && !!s.user && !s.user.guest && s.tc !== 'untimed' });
}

export function cancelWaiting() {
  send({ t: 'cancel' });
  useOnline.setState({ view: 'lobby', seeking: null, code: null });
  setUrl(null);
}

export const joinGame = (code: string) => send({ t: 'join', code });
export const watchGame = (code: string) => send({ t: 'watch', code });

const gameCode = () => useOnline.getState().game?.code;
export const onlineResign = () => {
  const c = gameCode();
  if (c) send({ t: kc.game.history.length < 2 ? 'abort' : 'resign', code: c });
};
export const onlineDraw = () => {
  const c = gameCode();
  if (c) send({ t: 'draw', code: c });
};
export const onlineDecline = () => {
  const c = gameCode();
  if (c) send({ t: 'decline', code: c });
};
export const onlineClaim = () => {
  const c = gameCode();
  if (c) send({ t: 'claim', code: c });
};
export const onlineRematch = () => {
  const c = gameCode();
  if (c) send({ t: 'rematch', code: c });
};

/** Leave the game screen (the game itself goes on if it is still in play). */
export function leaveOnlineGame() {
  const c = gameCode();
  if (c) send({ t: 'leave', code: c });
  useOnline.setState({ game: null, view: 'lobby' });
  setUrl(null);
}

/** Time until an away opponent can be claimed against (ms), or null. */
export function claimIn(now = Date.now()): number | null {
  const g = useOnline.getState().game;
  if (!g || !g.you || g.status !== 'playing') return null;
  const opp: Colour = g.you === 'w' ? 'b' : 'w';
  const since = g.presence.awaySince[opp];
  if (g.presence[opp] || since === undefined) return null;
  return Math.max(0, since + ONLINE_TIMING.abandon - (now + g.skew));
}

/** On page load: an invite or watch link opens straight into online play. */
export function openFromUrl(): boolean {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  const play = q.get('play');
  const watch = q.get('watch');
  const clash = q.get('clash');
  const tour = q.get('t');
  if (tour) {
    if (useOnline.getState().token) openSocket();
    void openTournament(tour);
    return true;
  }
  if (clash) {
    useKingdom.setState({ screen: 'clusters' });
    openClash(clash);
    return true;
  }
  if (!play && !watch) return false;
  useKingdom.setState({ screen: 'online' });
  if (watch) {
    watchGame(watch);
    return true;
  }
  useOnline.setState({ view: 'join', code: play });
  if (useOnline.getState().token) joinGame(play!);
  return true;
}

/** Start talking to the server when the online screen opens. */
export function enterOnline() {
  useKingdom.setState({ screen: 'online' });
  if (useOnline.getState().token) openSocket();
  void refreshLive();
}
