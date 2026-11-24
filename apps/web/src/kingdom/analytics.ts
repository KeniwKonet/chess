/**
 * Anonymous usage counts for the admin dashboard: a visit, and games against
 * the computer or pass-and-play (which never reach the server otherwise).
 * Each browser gets a random visitor id; nothing personal is sent.
 * Server side: apps/server/src/online/analytics.ts.
 */
import { onlineBase } from './online';

type Mode = 'ai' | 'local';
interface Ev {
  kind: 'visit' | 'game-start' | 'game-end';
  mode?: Mode;
  level?: string;
  result?: string;
  moves?: number;
  seconds?: number;
  device?: string;
  referrer?: string;
  game?: string;
}

const rand = () => {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

const visitor = (() => {
  try {
    let v = localStorage.getItem('cf-visitor');
    if (!v || !/^[a-f0-9]{24}$/.test(v)) localStorage.setItem('cf-visitor', (v = rand()));
    return v;
  } catch {
    return rand();
  }
})();

const queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const off = () => typeof location === 'undefined' || /^(localhost|127\.)/.test(location.hostname) || navigator.webdriver === true;

function flush() {
  timer = null;
  if (!queue.length) return;
  const body = JSON.stringify({ visitor, events: queue.splice(0, 20) });
  const url = `${onlineBase()}/api/track`;
  try {
    // Survives the tab closing; plain text so no CORS preflight is needed.
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
  } catch {
    /* fall through */
  }
  void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
}

function track(e: Ev) {
  if (off() && !(window as { __cfTrack?: boolean }).__cfTrack) return;
  queue.push(e);
  if (!timer) timer = setTimeout(flush, 3000);
}

if (typeof window !== 'undefined') addEventListener('pagehide', flush);

export function trackVisit() {
  const w = Math.min(screen.width, screen.height);
  const device = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? (w >= 600 ? 'tablet' : 'phone') : /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : 'desktop';
  let referrer: string | undefined;
  try {
    const r = document.referrer ? new URL(document.referrer).hostname : '';
    if (r && r !== location.hostname) referrer = r;
  } catch {
    /* no referrer */
  }
  const utm = new URLSearchParams(location.search).get('utm_source');
  if (utm && /^[a-z0-9.-]{1,40}$/i.test(utm)) referrer = utm.toLowerCase();
  track({ kind: 'visit', device, ...(referrer ? { referrer } : {}) });
}

let current: { id: string; mode: Mode; level?: string; at: number } | null = null;

export function trackGameStart(mode: Mode, level?: string) {
  current = { id: rand(), mode, ...(level ? { level } : {}), at: Date.now() };
  track({ kind: 'game-start', mode, ...(level ? { level } : {}), game: current.id });
}

/** `result` from the player's side: win, loss, draw, resigned; or `both` for pass-and-play with a winner. */
export function trackGameEnd(result: string, plies: number) {
  if (!current) return;
  const c = current;
  current = null;
  track({ kind: 'game-end', mode: c.mode, ...(c.level ? { level: c.level } : {}), game: c.id, result, moves: Math.ceil(plies / 2), seconds: Math.round((Date.now() - c.at) / 1000) });
}
