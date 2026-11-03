/**
 * Battle sounds, synthesised with Web Audio (no files to download or licence):
 * footsteps, sword swings and clashes, crossbow bolts, spells, catapults,
 * crumbling towers, the check bell and fanfares. Quiet by design.
 */
export type Sfx =
  | 'march'
  | 'roll'
  | 'whoosh'
  | 'land'
  | 'swing'
  | 'clash'
  | 'bolt'
  | 'spell'
  | 'catapult'
  | 'creak'
  | 'impact'
  | 'fall'
  | 'crumble'
  | 'promote'
  | 'check'
  | 'victory'
  | 'draw'
  | 'select'
  | 'move'
  | 'tick';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
export const sound = { on: true, volume: 0.55 };

function audio(): AudioContext | null {
  if (!sound.on || typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = sound.volume;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    master!.gain.value = sound.volume;
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a tap/click so mobile browsers allow sound. */
export function unlockAudio() {
  audio();
}

function noise(c: AudioContext, t: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass') {
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t, Math.random() * 0.5, dur + 0.05);
  return f;
}

function tone(c: AudioContext, t: number, dur: number, f0: number, f1: number, gain: number, type: OscillatorType = 'sine') {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function sfx(name: Sfx) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  switch (name) {
    case 'march':
      for (let i = 0; i < 4; i++) noise(c, t + i * 0.22, 0.07, 260, 1.5, 0.18, 'lowpass');
      break;
    case 'roll':
      noise(c, t, 0.9, 120, 0.8, 0.25, 'lowpass');
      for (let i = 0; i < 5; i++) noise(c, t + i * 0.17, 0.05, 700, 6, 0.06);
      break;
    case 'whoosh': {
      const f = noise(c, t, 0.35, 500, 1.2, 0.25);
      f.frequency.exponentialRampToValueAtTime(2200, t + 0.3);
      break;
    }
    case 'land':
      noise(c, t, 0.18, 160, 1, 0.35, 'lowpass');
      break;
    case 'swing': {
      const f = noise(c, t, 0.22, 900, 2, 0.18);
      f.frequency.exponentialRampToValueAtTime(3000, t + 0.2);
      break;
    }
    case 'clash':
      tone(c, t, 0.35, 1850, 1700, 0.08, 'triangle');
      tone(c, t, 0.3, 2600, 2450, 0.05, 'square');
      noise(c, t, 0.12, 3500, 3, 0.25, 'highpass');
      break;
    case 'bolt':
      noise(c, t, 0.06, 1800, 4, 0.3);
      tone(c, t, 0.12, 900, 300, 0.08, 'triangle');
      break;
    case 'spell':
      tone(c, t, 0.6, 440, 1320, 0.07, 'sine');
      tone(c, t + 0.05, 0.55, 660, 1760, 0.05, 'triangle');
      noise(c, t, 0.5, 4000, 8, 0.05);
      break;
    case 'catapult':
      noise(c, t, 0.25, 200, 2, 0.3);
      tone(c, t, 0.2, 140, 70, 0.15, 'triangle');
      break;
    case 'creak':
      tone(c, t, 0.35, 180, 120, 0.06, 'sawtooth');
      break;
    case 'impact':
      noise(c, t, 0.3, 140, 1, 0.45, 'lowpass');
      tone(c, t, 0.25, 110, 45, 0.25);
      break;
    case 'fall':
      noise(c, t + 0.1, 0.25, 220, 1, 0.22, 'lowpass');
      break;
    case 'crumble':
      for (let i = 0; i < 6; i++) noise(c, t + i * 0.09, 0.25, 180 + i * 40, 1, 0.3, 'lowpass');
      break;
    case 'promote':
      [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.09, 0.5, f, f, 0.07, 'triangle'));
      break;
    case 'check':
      tone(c, t, 1.2, 880, 870, 0.09, 'sine');
      tone(c, t, 1.0, 1760, 1750, 0.03, 'sine');
      break;
    case 'victory':
      [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.14, i === 6 ? 0.9 : 0.25, f, f, 0.08, 'triangle'));
      break;
    case 'draw':
      [523, 494, 523].forEach((f, i) => tone(c, t + i * 0.2, 0.35, f, f, 0.06, 'triangle'));
      break;
    case 'select':
      tone(c, t, 0.08, 1200, 1400, 0.04, 'sine');
      break;
    case 'move':
      tone(c, t, 0.1, 600, 500, 0.05, 'triangle');
      break;
    case 'tick':
      tone(c, t, 0.05, 2000, 2000, 0.03, 'square');
      break;
  }
}
