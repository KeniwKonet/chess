/**
 * Table talk in online games: emoji reactions, and voice chat between the two
 * players.
 *
 * The voice goes straight from one browser to the other (WebRTC); the
 * ChessFront server only passes the call set-up along and never hears it.
 * Nobody is heard until they switch voice on themselves, both players must
 * have done so before a call starts, and spectators never get the audio.
 *
 * White always makes the call once both are on, so the two browsers never
 * dial each other at the same moment. Each side gathers all its network
 * routes before sending its description, so one offer and one answer do it.
 */
import { create } from 'zustand';
import type { Colour, Reaction, ServerMsg, VoiceSignal } from '@cr/chess-core';
import { api, send, useOnline } from './online';
import { toast } from './store';

export type VoiceState = 'off' | 'asking' | 'waiting' | 'connecting' | 'live' | 'failed';

export interface Float {
  id: number;
  by: Colour;
  emoji: Reaction;
}

interface TalkState {
  /** The game this belongs to. */
  code: string | null;
  /** My side of the call. */
  voice: VoiceState;
  /** I muted my microphone. */
  muted: boolean;
  /** The other player's voice switch, as they last told us. */
  peer: { on: boolean; muted: boolean };
  /** I turned the other player's sound off. */
  peerSilenced: boolean;
  /** Reactions on screen. */
  floats: Float[];
}

export const useTalk = create<TalkState>(() => ({ code: null, voice: 'off', muted: false, peer: { on: false, muted: false }, peerSilenced: false, floats: [] }));

const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/** How long to collect network routes before sending a description anyway. */
const GATHER_MS = 2500;
/** A call that hasn't connected by then is given up on (the player can try again). Generous: slow phones take a while to answer. */
const CONNECT_MS = 30_000;
const FLOAT_MS = 2600;
const REACT_GAP_MS = 700;

let stream: MediaStream | null = null;
let pc: RTCPeerConnection | null = null;
let audio: HTMLAudioElement | null = null;
let iceCache: RTCIceServer[] | null = null;
let giveUp: ReturnType<typeof setTimeout> | null = null;
let floatId = 0;
let lastReact = 0;

const game = () => useOnline.getState().game;
const opponentName = () => {
  const g = game();
  if (!g?.you) return 'Your opponent';
  return (g.you === 'w' ? g.black?.name : g.white?.name) ?? 'Your opponent';
};

export const voiceSupported = () => typeof RTCPeerConnection !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

function signal(s: VoiceSignal) {
  const code = useTalk.getState().code;
  if (code) send({ t: 'voice', code, signal: s });
}

/* ---------------------------------------------------------------- reactions */

export function react(emoji: Reaction) {
  const g = game();
  if (!g?.you || Date.now() - lastReact < REACT_GAP_MS) return;
  lastReact = Date.now();
  // It shows when the server sends it back, the same moment everyone else sees it.
  send({ t: 'react', code: g.code, emoji });
}

function showFloat(by: Colour, emoji: Reaction) {
  const f: Float = { id: ++floatId, by, emoji };
  useTalk.setState((s) => ({ floats: [...s.floats.slice(-5), f] }));
  setTimeout(() => useTalk.setState((s) => ({ floats: s.floats.filter((x) => x.id !== f.id) })), FLOAT_MS);
}

/* ---------------------------------------------------------------- voice: my side */

/** Switch voice on: ask for the microphone, then tell the other player. */
export async function joinVoice() {
  const g = game();
  if (!g?.you) return;
  if (!voiceSupported()) return toast("This browser can't do voice chat. Try Chrome, Safari or Firefox.", 'warn');
  if (useTalk.getState().code !== g.code) resetFor(g.code);
  useTalk.setState({ voice: 'asking' });
  // Made during the tap, so phones let it play the other player's voice later.
  ensureAudio();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    useTalk.setState({ voice: 'off' });
    const name = (e as DOMException)?.name;
    toast(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone blocked. Allow it for this site in your browser settings to talk.' : 'No microphone found on this device.', 'warn');
    return;
  }
  // Left the game (or switched voice off) while the browser was asking.
  if (useTalk.getState().voice !== 'asking' || game()?.code !== g.code) return stopMic();
  useTalk.setState({ voice: 'waiting', muted: false });
  void loadIce();
  signal({ kind: 'on', on: true, muted: false });
  void call();
}

/** Switch voice off. `tell` is false when the server already knows (the game was left). */
export function leaveVoice(tell = true) {
  if (useTalk.getState().voice === 'off') return;
  if (tell) signal({ kind: 'on', on: false });
  hangUp();
  stopMic();
  useTalk.setState({ voice: 'off', muted: false });
}

export function toggleMute() {
  const s = useTalk.getState();
  if (s.voice === 'off' || s.voice === 'asking' || !stream) return;
  const muted = !s.muted;
  for (const t of stream.getAudioTracks()) t.enabled = !muted;
  useTalk.setState({ muted });
  signal({ kind: 'on', on: true, muted });
}

export function toggleSilence() {
  const peerSilenced = !useTalk.getState().peerSilenced;
  useTalk.setState({ peerSilenced });
  if (audio) audio.muted = peerSilenced;
}

/** After a failed call: try once more. */
export function retryVoice() {
  if (useTalk.getState().voice !== 'failed') return;
  useTalk.setState({ voice: 'waiting' });
  // White calls again; Black's "I'm on" makes White call again.
  if (game()?.you === 'w') void call();
  else signal({ kind: 'on', on: true, muted: useTalk.getState().muted });
}

function stopMic() {
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
}

function ensureAudio() {
  if (audio || typeof document === 'undefined') return;
  audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  audio.hidden = true;
  document.body.appendChild(audio);
}

async function loadIce(): Promise<RTCIceServer[]> {
  if (iceCache) return iceCache;
  try {
    const r = await api<{ iceServers: RTCIceServer[] }>('/api/ice');
    iceCache = r.iceServers?.length ? r.iceServers : FALLBACK_ICE;
  } catch {
    iceCache = FALLBACK_ICE;
  }
  return iceCache;
}

/* ---------------------------------------------------------------- voice: the call */

function hangUp() {
  if (giveUp) clearTimeout(giveUp);
  giveUp = null;
  const p = pc;
  pc = null;
  if (p) {
    p.ontrack = null;
    p.onconnectionstatechange = null;
    p.close();
  }
  if (audio) audio.srcObject = null;
}

function fail() {
  hangUp();
  if (useTalk.getState().voice === 'off') return;
  useTalk.setState({ voice: 'failed' });
  toast("Voice couldn't connect on this network. The game carries on.", 'warn');
}

async function newCall(): Promise<RTCPeerConnection> {
  hangUp();
  const ice = await loadIce();
  const p = new RTCPeerConnection({ iceServers: ice });
  pc = p;
  for (const t of stream?.getTracks() ?? []) p.addTrack(t, stream!);
  p.ontrack = (e) => {
    ensureAudio();
    audio!.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    audio!.muted = useTalk.getState().peerSilenced;
    void audio!.play().catch(() => toast('Tap the microphone button to hear your opponent.', 'warn'));
  };
  p.onconnectionstatechange = () => {
    if (pc !== p) return;
    const st = p.connectionState;
    if (st === 'connected') {
      if (giveUp) clearTimeout(giveUp);
      giveUp = null;
      if (useTalk.getState().voice !== 'live') {
        useTalk.setState({ voice: 'live' });
        toast(`Voice on with ${opponentName()}. Say hello!`, 'good');
      }
    } else if (st === 'failed') fail();
    else if (st === 'disconnected') {
      // Often a blip on mobile networks: give it a moment to come back.
      useTalk.setState({ voice: 'connecting' });
      if (giveUp) clearTimeout(giveUp);
      giveUp = setTimeout(() => pc === p && p.connectionState !== 'connected' && fail(), 8000);
    }
  };
  return p;
}

/** Wait until every network route is known (or a little while), so one description carries them all. */
function gathered(p: RTCPeerConnection): Promise<void> {
  if (p.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const done = () => {
      p.removeEventListener('icegatheringstatechange', check);
      clearTimeout(t);
      res();
    };
    const check = () => p.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, GATHER_MS);
    p.addEventListener('icegatheringstatechange', check);
  });
}

function armGiveUp(p: RTCPeerConnection) {
  if (giveUp) clearTimeout(giveUp);
  giveUp = setTimeout(() => pc === p && p.connectionState !== 'connected' && fail(), CONNECT_MS);
}

/** White calls Black once both have switched voice on. */
async function call() {
  const s = useTalk.getState();
  if (game()?.you !== 'w' || !stream || !s.peer.on || (s.voice !== 'waiting' && s.voice !== 'failed')) return;
  useTalk.setState({ voice: 'connecting' });
  try {
    const p = await newCall();
    await p.setLocalDescription(await p.createOffer());
    await gathered(p);
    if (pc !== p) return;
    signal({ kind: 'offer', sdp: p.localDescription!.sdp });
    armGiveUp(p);
  } catch {
    fail();
  }
}

async function answer(sdp: string) {
  if (!stream || useTalk.getState().voice === 'off' || useTalk.getState().voice === 'asking') return;
  useTalk.setState({ voice: 'connecting' });
  try {
    const p = await newCall();
    await p.setRemoteDescription({ type: 'offer', sdp });
    await p.setLocalDescription(await p.createAnswer());
    await gathered(p);
    if (pc !== p) return;
    signal({ kind: 'answer', sdp: p.localDescription!.sdp });
    armGiveUp(p);
  } catch {
    fail();
  }
}

async function answered(sdp: string) {
  const p = pc;
  if (!p || p.signalingState !== 'have-local-offer') return;
  try {
    await p.setRemoteDescription({ type: 'answer', sdp });
  } catch {
    fail();
  }
}

/* ---------------------------------------------------------------- from the server */

export function handleTalk(m: Extract<ServerMsg, { t: 'react' } | { t: 'voice' }>) {
  const g = game();
  if (!g || g.code !== m.code) return;
  if (m.t === 'react') return showFloat(m.by, m.emoji);
  if (!g.you || m.from === g.you) return;
  if (useTalk.getState().code !== g.code) resetFor(g.code);
  const s = m.signal;
  if (s.kind === 'on') {
    const was = useTalk.getState().peer.on;
    useTalk.setState({ peer: { on: s.on, muted: !!s.muted } });
    const mine = useTalk.getState().voice;
    if (!s.on) {
      hangUp();
      if (mine !== 'off' && mine !== 'asking') useTalk.setState({ voice: 'waiting' });
      if (was && mine !== 'off') toast(`${opponentName()} left voice chat.`);
      return;
    }
    if (!was && mine === 'off') toast(`${opponentName()} switched voice chat on. Tap 🎙 to talk.`, 'good');
    // They (re)joined, or asked to try again after a failed call.
    const dead = !pc || pc.connectionState === 'failed' || pc.connectionState === 'closed';
    if ((!was || dead) && mine === 'failed') useTalk.setState({ voice: 'waiting' });
    if (!was || dead) void call();
    return;
  }
  if (s.kind === 'offer') void answer(s.sdp);
  else void answered(s.sdp);
}

/** A fresh slate for another game (keeps my voice switch only for a rematch). */
function resetFor(code: string) {
  floatId = 0;
  useTalk.setState({ code, peer: { on: false, muted: false }, floats: [] });
}

/**
 * Called whenever a game arrives from the server: a new game, a rematch, or
 * the same game again after a dropped connection.
 */
export function talkOnGame(code: string, you: Colour | null, rematchOf: string | null) {
  const s = useTalk.getState();
  if (!you) {
    // Watching: never on voice.
    if (s.voice !== 'off') leaveVoice();
    if (s.code !== code) resetFor(code);
    return;
  }
  if (s.code === code) {
    // Back after a dropped connection: the server dropped us from voice, so say we're here again.
    if (s.voice !== 'off' && s.voice !== 'asking') {
      hangUp();
      useTalk.setState({ voice: 'waiting', peer: { on: false, muted: false } });
      signal({ kind: 'on', on: true, muted: s.muted });
    }
    return;
  }
  const carry = s.voice !== 'off' && s.voice !== 'asking' && !!stream && rematchOf !== null && s.code === rematchOf;
  if (!carry) leaveVoice();
  else hangUp();
  resetFor(code);
  if (carry) {
    // A rematch with the same opponent: stay on voice.
    useTalk.setState({ voice: 'waiting' });
    signal({ kind: 'on', on: true, muted: s.muted });
  }
}

/** Leaving the game screen (or signing out): off voice, nothing left on screen. */
export function talkOff(tell = true) {
  leaveVoice(tell);
  useTalk.setState({ code: null, peer: { on: false, muted: false }, floats: [] });
}
