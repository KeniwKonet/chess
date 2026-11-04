/**
 * Clusters and Clash of Clusters in the browser: the cluster screens' data
 * (through the API) and a clash on the battlefield (through the socket).
 *
 * In a clash the board shows the true position; a member's move becomes a
 * proposal to their cluster, and the move appears when the King (or the turn
 * timer) decides.
 */
import { create } from 'zustand';
import {
  KingdomGame,
  rolePieceId,
  type ClashServerMsg,
  type ClashView,
  type ClusterDetail,
  type ClusterRole,
  type ClusterSummary,
  type Colour,
  type KingdomResult,
} from '@cr/chess-core';
import { kc } from './controller';
import { director } from './director';
import { api, send, useOnline } from './online';
import { sfx } from './sound';
import { toast, useKingdom } from './store';

export interface ClusterState {
  mine: ClusterDetail | null;
  requests: string[];
  list: ClusterSummary[];
  viewing: ClusterDetail | null;
  loading: boolean;
  error: string | null;
  open: { code: string; from: string; fromRating: number; turnSecs: number; target: string | null }[];
  live: { code: string; white: string; black: string; moves: number }[];
  /** The challenge we made and are waiting on. */
  waiting: string | null;
  clash: ClashView | null;
  skew: number;
}

export const useClusters = create<ClusterState>(() => ({
  mine: null,
  requests: [],
  list: [],
  viewing: null,
  loading: false,
  error: null,
  open: [],
  live: [],
  waiting: null,
  clash: null,
  skew: 0,
}));

const fail = (e: unknown) => {
  useClusters.setState({ error: (e as Error).message, loading: false });
  return null;
};

export async function loadMine() {
  useClusters.setState({ loading: true, error: null });
  try {
    const r = await api<{ cluster: ClusterDetail | null; requests: string[] }>('/api/clusters/mine');
    useClusters.setState({ mine: r.cluster, requests: r.requests, loading: false });
    send({ t: 'clash-list' });
    return r.cluster;
  } catch (e) {
    return fail(e);
  }
}

export async function searchClusters(q = '') {
  try {
    const r = await api<{ clusters: ClusterSummary[] }>(`/api/clusters${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    useClusters.setState({ list: r.clusters });
  } catch (e) {
    fail(e);
  }
}

export async function viewCluster(name: string | null) {
  if (!name) return useClusters.setState({ viewing: null });
  try {
    const r = await api<{ cluster: ClusterDetail }>(`/api/clusters/${encodeURIComponent(name)}`);
    useClusters.setState({ viewing: r.cluster });
  } catch (e) {
    fail(e);
  }
}

/** A King's (or member's) action on a cluster; refreshes your cluster afterwards. */
async function act(name: string, action: string, body: Record<string, unknown>, ok?: string) {
  useClusters.setState({ error: null, loading: true });
  try {
    await api(`/api/clusters/${encodeURIComponent(name)}/${action}`, body);
    if (ok) toast(ok, 'good');
    await loadMine();
    const v = useClusters.getState().viewing;
    if (v) await viewCluster(v.name);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function createCluster(name: string, motto: string) {
  useClusters.setState({ error: null, loading: true });
  try {
    await api('/api/clusters/new', { name, motto });
    toast(`${name} is founded. You are its King.`, 'good');
    await loadMine();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export const askToJoin = (name: string) => act(name, 'join', {}, `Request sent to ${name}. Their King decides.`);
export const decide = (name: string, user: number, as: 'member' | 'sub' | 'spectator' | 'reject') =>
  act(name, 'decide', { user, as }, as === 'reject' ? 'Request turned down.' : undefined);
export const setRole = (name: string, user: number, role: ClusterRole) => act(name, 'role', { user, role });
export const substitute = (name: string, out: number, inn: number) => act(name, 'sub', { out, in: inn }, 'Substitution made.');
export const removeMember = (name: string, user: number) => act(name, 'remove', { user });
export const setMotto = (name: string, motto: string) => act(name, 'motto', { motto });
export async function leaveCluster(name: string) {
  const ok = await act(name, 'leave', {}, `You left ${name}.`);
  if (ok) useClusters.setState({ mine: null });
}

/* ---------------------------------------------------------------- clashes */

export function challenge(turnSecs: number, target?: string) {
  useClusters.setState({ error: null });
  send({ t: 'clash-create', turnSecs, ...(target ? { target } : {}) });
}
export const acceptClash = (code: string) => send({ t: 'clash-accept', code });
export const openClash = (code: string) => send({ t: 'clash-open', code });
export const cancelClash = (code: string) => {
  send({ t: 'clash-cancel', code });
  useClusters.setState({ waiting: null });
};

const code = () => useClusters.getState().clash?.code;
export const backProposal = (id: number) => {
  const c = code();
  if (c) send({ t: 'clash-back', code: c, id });
};
export const playProposal = (id: number) => {
  const c = code();
  if (c) send({ t: 'clash-play', code: c, id });
};
export const assignSoldier = (role: ClusterRole, to: number) => {
  const c = code();
  if (c) send({ t: 'clash-assign', code: c, role, to });
};
export const clashResign = () => {
  const c = code();
  if (c) send({ t: 'clash-resign', code: c });
};
export const clashDraw = () => {
  const c = code();
  if (c) send({ t: 'clash-draw', code: c });
};

export const clashLink = (c: string) => {
  const u = new URL(location.origin + location.pathname);
  for (const [k, v] of new URLSearchParams(location.search)) if (k === 'online') u.searchParams.set(k, v);
  u.searchParams.set('clash', c);
  return u.toString();
};

/** Who commands the soldier on a square (user id), in the current clash. */
export function ownerOf(sq: string): number | null {
  const c = useClusters.getState().clash;
  const id = kc.game.tracker.at.get(sq as never);
  if (!c || !id) return null;
  return c.owners[id] ?? null;
}

export function handleClash(m: ClashServerMsg) {
  if (m.t === 'clash-created') {
    useClusters.setState({ waiting: m.code });
    return;
  }
  if (m.t === 'clash-challenges') {
    useClusters.setState({ open: m.open, live: m.live });
    return;
  }
  loadClash(m.clash);
}

function loadClash(v: ClashView) {
  const prev = useClusters.getState().clash;
  useClusters.setState({ clash: v, skew: v.serverNow - Date.now() });
  if (v.status === 'waiting') {
    useClusters.setState({ waiting: v.code });
    return;
  }
  if (v.status === 'aborted') {
    if (useClusters.getState().waiting === v.code) useClusters.setState({ waiting: null });
    return;
  }
  const me = useOnline.getState().user?.id;
  const onBoard = kc.opponent === 'clash' && prev?.code === v.code && useKingdom.getState().screen === 'playing';
  const have = kc.game.history.map((x) => x.san);
  const matches = onBoard && have.length <= v.moves.length && have.every((x, i) => x === v.moves[i]);
  if (!matches) {
    const g = new KingdomGame();
    v.moves.forEach((san, i) => g.move(g.turn, san, i));
    kc.game = g;
    kc.ai = null;
    director.sync(g.tracker);
  } else {
    for (const san of v.moves.slice(have.length)) {
      const r = kc.game.move(kc.game.turn, san, Date.now());
      if (!r.ok) break;
      void director.play(r.move, kc.game.tracker).then(() => useKingdom.setState((k) => ({ rev: k.rev + 1 })));
      if (r.move.check && !r.move.mate && v.you && r.move.colour !== v.you) toast('Check! Your King is under attack.', 'warn');
    }
    if (v.moves.length > have.length && v.lastNote) toast(v.lastNote, v.moves.length % 2 === (v.you === 'w' ? 1 : 0) ? 'good' : 'info');
  }
  kc.opponent = 'clash';
  kc.you = v.you;
  kc.send = null;
  kc.mayMove = (sq) => {
    const c = useClusters.getState().clash;
    if (!c || c.status !== 'playing' || !c.you || kc.game.turn !== c.you) return false;
    const piece = kc.game.tracker.on(sq);
    if (!piece || piece.colour !== c.you) return false;
    return c.youKing || ownerOf(sq) === me;
  };
  kc.propose = (mv) => send({ t: 'clash-propose', code: v.code, ply: kc.game.history.length, move: mv });
  const over = v.status === 'over';
  if (over && v.result) kc.game.result = { winner: v.result.winner, reason: v.result.reason } as KingdomResult;
  const wasOver = prev?.code === v.code && prev.status === 'over';
  if (over && !wasOver && onBoard) {
    director.celebrate(v.result!.winner, kc.game.tracker, v.result!.reason as KingdomResult['reason']);
    sfx(v.you && v.result!.winner === v.you ? 'victory' : 'check');
  }
  // Your cluster's turn begins.
  if (!over && onBoard && v.you && kc.game.turn === v.you && prev && prev.moves.length !== v.moves.length) sfx('select');
  useKingdom.setState((k) => ({
    screen: 'playing',
    opponent: 'clash',
    result: over ? kc.game.result : null,
    showResult: over && (!onBoard || !wasOver) ? true : k.showResult && over,
    thinking: false,
    viewFrom: onBoard ? k.viewFrom : (v.you ?? 'w'),
    rev: k.rev + 1,
    ...(onBoard ? {} : { selected: null, targets: [], card: null, showMenu: false }),
  }));
  setUrl(v.code);
  if (!onBoard && v.status === 'playing') {
    if (!v.you) toast('Watching a Clash of Clusters live.');
    else toast(`Clash of Clusters! ${v.youKing ? 'You are King: your moves are final.' : 'Propose moves with your soldiers; your King decides.'}`, 'good');
  }
}

function setUrl(c: string | null) {
  try {
    const u = new URL(location.href);
    for (const k of ['play', 'watch', 'clash']) u.searchParams.delete(k);
    if (c) u.searchParams.set('clash', c);
    history.replaceState(null, '', u);
  } catch {
    /* ignore */
  }
}

export function leaveClash() {
  useClusters.setState({ clash: null });
  kc.mayMove = null;
  kc.propose = null;
  setUrl(null);
}

/** Soldiers this person commands in the current clash. */
export function mySoldiers(): ClusterRole[] {
  const c = useClusters.getState().clash;
  const me = useOnline.getState().user?.id;
  if (!c || !c.you || !me) return [];
  const roles: ClusterRole[] = ['k', 'q', 'r1', 'r2', 'b1', 'b2', 'n1', 'n2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  return roles.filter((r) => c.owners[rolePieceId(r, c.you as Colour)] === me && [...kc.game.tracker.at.values()].includes(rolePieceId(r, c.you as Colour)));
}

/** Seconds left in the current turn. */
export function turnLeft(): number | null {
  const c = useClusters.getState().clash;
  if (!c || c.status !== 'playing' || c.turnEndsAt === null) return null;
  return Math.max(0, (c.turnEndsAt - (Date.now() + useClusters.getState().skew)) / 1000);
}
