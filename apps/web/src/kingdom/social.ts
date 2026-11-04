/**
 * The browser side of accounts, friends, notifications, player profiles,
 * reports, tournaments and the admin tools (all through the server's API).
 */
import { create } from 'zustand';
import type { FriendInfo, GameRecord, HeadToHead, Notification, OnlineTc, PublicUser, TournamentDetail, TournamentSummary } from '@cr/chess-core';
import { ONLINE_BASE, api, joinGame, send, useOnline } from './online';
import { toast, useKingdom } from './store';

export type Panel = null | 'notifications' | 'account' | 'friends' | 'profile' | 'report' | 'forgot';

export interface SocialState {
  panel: Panel;
  notes: Notification[];
  unread: number;
  friends: FriendInfo[];
  /** The player whose profile is open. */
  profile: null | { user: PublicUser; games: GameRecord[]; rivals: { name: string; wins: number; losses: number; draws: number }[]; vsYou?: HeadToHead; friend?: boolean; cluster: string | null };
  reportName: string | null;
  reportGame: string | null;
  tournaments: TournamentSummary[];
  tournament: TournamentDetail | null;
  busy: boolean;
  error: string | null;
}

export const useSocial = create<SocialState>(() => ({
  panel: null,
  notes: [],
  unread: 0,
  friends: [],
  profile: null,
  reportName: null,
  reportGame: null,
  tournaments: [],
  tournament: null,
  busy: false,
  error: null,
}));

export const openPanel = (panel: Panel) => useSocial.setState({ panel, error: null });

/** Runs an API call with the busy flag and error message handled. */
async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  useSocial.setState({ busy: true, error: null });
  try {
    const out = await fn();
    useSocial.setState({ busy: false });
    if (ok) toast(ok, 'good');
    return out;
  } catch (e) {
    useSocial.setState({ busy: false, error: (e as Error).message });
    return null;
  }
}

export const avatarUrl = (path: string | null | undefined) => (path ? ONLINE_BASE + path : null);

/* ---------------------------------------------------------------- notifications */

export async function loadNotes() {
  const r = await api<{ notes: Notification[]; unread: number }>('/api/notifications').catch(() => null);
  if (r) useSocial.setState({ notes: r.notes, unread: r.unread });
}

export async function readAll() {
  useSocial.setState((s) => ({ unread: 0, notes: s.notes.map((n) => ({ ...n, read: true })) }));
  await api('/api/notifications/read', {}).catch(() => {});
}

/** A notification arrived on the socket. */
export function onNote(n: Notification) {
  if (n.kind !== 'announcement') useSocial.setState((s) => ({ notes: [n, ...s.notes].slice(0, 50), unread: s.unread + 1 }));
  toast(n.kind === 'announcement' ? `📣 ${n.text}` : n.text, n.kind === 'challenge' || n.kind === 'tournament' ? 'good' : 'info');
  if (n.kind === 'friend' || n.kind === 'friend-request') void loadFriends();
}

/** What tapping a notification does. */
export function openNote(n: Notification) {
  const d = n.data as { code?: string; tournament?: string; cluster?: string; name?: string };
  openPanel(null);
  if (d.code && (n.kind === 'challenge' || n.kind === 'tournament')) {
    useKingdom.setState({ screen: 'online' });
    useOnline.setState({ view: 'join', code: d.code });
    return joinGame(d.code);
  }
  if (d.tournament) return openTournament(d.tournament);
  if (n.kind === 'cluster') return useKingdom.setState({ screen: 'clusters' });
  if (n.kind === 'friend-request' || n.kind === 'friend') return openPanel('friends');
}

/* ---------------------------------------------------------------- friends and profiles */

export async function loadFriends() {
  const r = await api<{ friends: FriendInfo[] }>('/api/friends').catch(() => null);
  if (r) useSocial.setState({ friends: r.friends });
}
export const addFriend = (name: string) =>
  run(async () => {
    const r = await api<{ status: 'sent' | 'friend' }>('/api/friends/add', { name });
    await loadFriends();
    toast(r.status === 'friend' ? `You and ${name} are friends.` : `Friend request sent to ${name}.`, 'good');
    return r;
  });
export const removeFriend = (name: string) => run(async () => (await api('/api/friends/remove', { name }), loadFriends()));
export function challengeFriend(name: string, tc: OnlineTc, rated: boolean) {
  send({ t: 'challenge', to: name, tc, colour: 'random', rated });
  openPanel(null);
  useKingdom.setState({ screen: 'online' });
  toast(`Challenge sent to ${name}.`, 'good');
}

export async function openProfile(name: string) {
  const r = await run(() => api<NonNullable<SocialState['profile']>>(`/api/users/${encodeURIComponent(name)}`));
  if (r) useSocial.setState({ profile: r, panel: 'profile' });
}

export function openReport(name: string, game: string | null = null) {
  useSocial.setState({ reportName: name, reportGame: game, panel: 'report', error: null });
}
export const sendReport = (reason: string, details: string) => {
  const s = useSocial.getState();
  return run(() => api('/api/report', { name: s.reportName, reason, details, ...(s.reportGame ? { game: s.reportGame } : {}) }), 'Thank you. An admin will look at it.');
};

/* ---------------------------------------------------------------- your account */

async function refreshMe() {
  const r = await api<{ user: PublicUser }>('/api/me');
  useOnline.setState({ user: r.user });
}
export const saveProfile = (bio: string, country: string) => run(() => api('/api/account/profile', { bio, country }).then(refreshMe), 'Profile saved.');
export const saveEmail = (email: string, password: string) => run(() => api('/api/account/email', { email, password }).then(refreshMe), email ? 'Email saved.' : 'Email removed.');
export const changePassword = (current: string, password: string) => run(() => api('/api/account/password', { current, password }), 'Password changed. Other devices are signed out.');
export const removePicture = () => run(() => api('/api/account/avatar', { remove: true }).then(refreshMe), 'Picture removed.');
export const signOutEverywhere = () =>
  run(async () => {
    await api('/api/account/logout-all', {});
    localStorage.removeItem('cf-token');
    location.reload();
  });
export const deleteAccount = (password: string) =>
  run(async () => {
    await api('/api/account/delete', { password });
    localStorage.removeItem('cf-token');
    location.reload();
  });

/** Shrinks a picture to 256×256 (cropped square) and uploads it. */
export async function uploadPicture(file: File) {
  return run(async () => {
    const bmp = await createImageBitmap(file);
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d')!;
    const s = Math.min(bmp.width, bmp.height);
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    let q = 0.86;
    let data = cv.toDataURL('image/jpeg', q);
    while (data.length > 80_000 && q > 0.4) data = cv.toDataURL('image/jpeg', (q -= 0.1));
    await api('/api/account/avatar', { data });
    await refreshMe();
  }, 'Picture updated.');
}

export const requestReset = (name: string) => run(() => api<{ message: string }>('/api/account/reset-request', { name }));
export async function resetPassword(name: string, code: string, password: string) {
  const r = await run(() => api<{ token: string; user: PublicUser }>('/api/account/reset', { name, code, password }));
  if (!r) return false;
  localStorage.setItem('cf-token', r.token);
  location.reload();
  return true;
}

/* ---------------------------------------------------------------- tournaments */

export async function loadTournaments() {
  const r = await api<{ tournaments: TournamentSummary[] }>('/api/tournaments').catch((e: Error) => (useSocial.setState({ error: e.message }), null));
  if (r) useSocial.setState({ tournaments: r.tournaments });
}

export async function openTournament(slug: string) {
  useKingdom.setState({ screen: 'tournaments' });
  const r = await run(() => api<{ tournament: TournamentDetail }>(`/api/tournaments/${slug}`));
  if (r) useSocial.setState({ tournament: r.tournament });
  try {
    const u = new URL(location.href);
    u.searchParams.set('t', slug);
    history.replaceState(null, '', u);
  } catch {
    /* ignore */
  }
}

export async function refreshTournament() {
  const t = useSocial.getState().tournament;
  if (!t) return;
  const r = await api<{ tournament: TournamentDetail }>(`/api/tournaments/${t.slug}`).catch(() => null);
  if (r) useSocial.setState({ tournament: r.tournament });
}

export async function createTournament(body: Record<string, unknown>) {
  const r = await run(() => api<{ tournament: TournamentDetail }>('/api/tournaments/new', body), 'Tournament created. Share its link so players can enter.');
  if (r) {
    useSocial.setState({ tournament: r.tournament });
    void loadTournaments();
  }
  return !!r;
}

export async function tournamentAction(action: 'join' | 'leave' | 'start' | 'cancel' | 'feature') {
  const t = useSocial.getState().tournament;
  if (!t) return;
  const msg = { join: 'You’re in. Your games start when the tournament does.', leave: 'You left the tournament.', start: 'The tournament has started.', cancel: 'Tournament cancelled.', feature: 'Featured.' }[action];
  const r = await run(() => api<{ tournament: TournamentDetail }>(`/api/tournaments/${t.slug}/${action}`, {}), msg);
  if (r) useSocial.setState({ tournament: r.tournament });
}

export const tournamentLink = (slug: string) => {
  const u = new URL(location.origin + location.pathname);
  for (const [k, v] of new URLSearchParams(location.search)) if (k === 'online') u.searchParams.set(k, v);
  u.searchParams.set('t', slug);
  return u.toString();
};

/* ---------------------------------------------------------------- admin */

export const adminGet = <T>(path: string) => api<T>(`/api/admin/${path}`);
export const adminDo = (action: string, body: Record<string, unknown>, ok?: string) => run(() => api(`/api/admin/${action}`, body), ok);
