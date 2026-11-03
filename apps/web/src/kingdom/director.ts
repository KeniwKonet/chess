/**
 * The battlefield director: turns each chess move into a short staged scene.
 *
 * The rules never live here. A move is decided by KingdomGame (chess.js);
 * the director only shows it: a Footman marches and stabs, a Raider leaps,
 * a Ranger shoots, the Sorceress casts, a Siege Tower bombards and rolls in,
 * the King steps. Scenes queue one after another, so moves made quickly (or
 * by the computer) still play in order, and `sync` snaps everything to the
 * true board at any time (new game, takeback, reconnect).
 *
 * Time is the director's own clock (seconds), advanced by the scene each frame
 * and scaled by the animation speed setting.
 */
import type { Colour, KingdomMove, PieceTracker, Role } from '@cr/chess-core';
import { BOARD_Y, homeYaw, squarePos, yawTo, type ClipKey, type P2 } from './board';
import { sfx } from './sound';

export interface PieceVis {
  id: string;
  colour: Colour;
  role: Role;
  x: number;
  z: number;
  /** Height above the board (leaps). */
  y: number;
  yaw: number;
  clip: ClipKey;
  clipStart: number;
  loop: boolean;
  /** 1 = solid, 0 = gone. */
  fade: number;
  /** How far the piece has sunk into the ground (fallen soldiers, collapsing towers). */
  sink: number;
  /** Tilt (radians) for collapsing towers; arm swing for catapults. */
  tilt: number;
  arm: number;
  /** On the board (false once captured and faded). */
  alive: boolean;
  /** Short flash after promotion. */
  glow: number;
}

export type EffectKind = 'bolt' | 'orb' | 'boulder' | 'burst' | 'light' | 'dust';
export interface Effect {
  kind: EffectKind;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  t0: number;
  dur: number;
  arc: number;
  colour: string;
}

type Anim = { t0: number; dur: number; fn: (k: number) => void; resolve: () => void };

/** Fallback clip lengths (s) until the models load and report the real ones. */
const DEFAULT_LEN: Record<ClipKey, number> = { idle: 2, walk: 1, run: 0.6, attack: 1.0, hit: 0.6, death: 1.4, cheer: 2.2, block: 1.0, leap: 1.4 };

const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function angleTo(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}

export const director = {
  now: 0,
  /** Animation speed: 1 cinematic, 2 quick; 0 means no animation (instant). */
  speed: 1,
  pieces: new Map<string, PieceVis>(),
  effects: [] as Effect[],
  anims: [] as Anim[],
  queue: Promise.resolve() as Promise<void>,
  pending: 0,
  /** Clip lengths per character model, filled in when the models load. */
  clipLen: {} as Record<string, Partial<Record<ClipKey, number>>>,
  /** The square the camera may glance toward during a scene. */
  focus: null as P2 | null,
  /** Bumped on every visual change that React overlays care about. */
  rev: 0,

  get busy() {
    return this.pending > 0;
  },

  update(dt: number) {
    this.now += dt * (this.speed || 1);
    const t = this.now;
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i]!;
      const k = a.dur <= 0 ? 1 : Math.min(1, (t - a.t0) / a.dur);
      a.fn(k);
      if (k >= 1) {
        this.anims.splice(i, 1);
        a.resolve();
      }
    }
    this.effects = this.effects.filter((e) => t - e.t0 < e.dur + 0.6);
  },

  /** Snap every piece to the tracker's board: no animation. */
  sync(tracker: PieceTracker) {
    this.anims.forEach((a) => a.resolve());
    this.anims = [];
    this.effects = [];
    this.pending = 0;
    this.queue = Promise.resolve();
    this.pieces.clear();
    for (const [sq, id] of tracker.at) {
      const p = tracker.pieces.get(id)!;
      const pos = squarePos(sq);
      this.pieces.set(id, { id, colour: p.colour, role: p.role, x: pos.x, z: pos.z, y: 0, yaw: homeYaw(p.colour), clip: 'idle', clipStart: this.now - Math.random() * 2, loop: true, fade: 1, sink: 0, tilt: 0, arm: 0, alive: true, glow: 0 });
    }
    this.rev++;
  },

  /** Queue a move's scene. Resolves when it has played. */
  play(m: KingdomMove, tracker: PieceTracker): Promise<void> {
    this.pending++;
    this.queue = this.queue
      .then(() => (this.speed === 0 ? this.instant(m, tracker) : stage(m)))
      .catch((e) => console.error('[Kingdom] scene failed', e))
      .finally(() => {
        this.pending--;
        // Once the queue has caught up, end on the true board, whatever happened on screen.
        // (Not between queued scenes: the tracker already holds the later moves.)
        if (this.pending === 0) settle(tracker);
        this.rev++;
      });
    return this.queue;
  },

  instant(_m: KingdomMove, tracker: PieceTracker) {
    settle(tracker);
  },

  /** Victory: the loser's king falls, the winners cheer. */
  celebrate(winner: Colour | null, tracker: PieceTracker, reason: string) {
    this.queue = this.queue.then(async () => {
      for (const p of this.pieces.values()) {
        if (!p.alive) continue;
        if (winner && p.colour !== winner && p.role === 'k' && (reason === 'checkmate' || reason === 'resignation' || reason === 'timeout')) {
          this.focus = p;
          setClip(p, 'death', false);
        } else if (!winner || p.colour === winner) setClip(p, 'cheer', true, Math.random() * 0.4);
      }
      sfx(winner ? 'victory' : 'draw');
      void tracker;
      this.rev++;
    });
  },
};

function animate(dur: number, fn: (k: number) => void): Promise<void> {
  return new Promise((resolve) => director.anims.push({ t0: director.now, dur, fn, resolve }));
}
const wait = (s: number) => animate(s, () => {});

function clipLen(p: PieceVis, clip: ClipKey): number {
  const model = p.role === 'p' ? 'footman' : p.role === 'n' ? 'raider' : p.role === 'b' ? 'ranger' : p.role === 'q' ? 'sorceress' : 'king';
  return director.clipLen[model]?.[clip] ?? DEFAULT_LEN[clip];
}

function setClip(p: PieceVis, clip: ClipKey, loop: boolean, offset = 0) {
  p.clip = clip;
  p.clipStart = director.now - offset;
  p.loop = loop;
}

const vis = (id: string) => director.pieces.get(id);

async function face(p: PieceVis, target: P2, dur = 0.18) {
  const from = p.yaw;
  const to = angleTo(from, yawTo(p, target));
  if (Math.abs(to - from) < 0.05) return;
  await animate(dur, (k) => (p.yaw = lerp(from, to, ease(k))));
}

async function walk(p: PieceVis, to: P2, opts: { run?: boolean } = {}) {
  const d = Math.hypot(to.x - p.x, to.z - p.z);
  if (d < 0.02) return;
  await face(p, to);
  const run = opts.run ?? d > 3.6;
  const speed = run ? 4.6 : 2.5;
  if (p.role === 'r') return roll(p, to);
  setClip(p, run ? 'run' : 'walk', true);
  const x0 = p.x;
  const z0 = p.z;
  await animate(d / speed, (k) => {
    p.x = lerp(x0, to.x, k);
    p.z = lerp(z0, to.z, k);
  });
  setClip(p, 'idle', true);
}

/** Siege towers roll, rocking gently. */
async function roll(p: PieceVis, to: P2) {
  const d = Math.hypot(to.x - p.x, to.z - p.z);
  if (d < 0.02) return;
  const x0 = p.x;
  const z0 = p.z;
  sfx('roll');
  await animate(0.25 + d / 3.4, (k) => {
    const e = ease(k);
    p.x = lerp(x0, to.x, e);
    p.z = lerp(z0, to.z, e);
    p.tilt = Math.sin(k * Math.PI * 6) * 0.03 * (1 - k);
  });
  p.tilt = 0;
}

/** Raiders leap the knight's L in one bound, over anyone in between. */
async function leap(p: PieceVis, to: P2) {
  await face(p, to);
  const len = clipLen(p, 'leap');
  setClip(p, 'leap', false);
  const x0 = p.x;
  const z0 = p.z;
  const d = Math.hypot(to.x - x0, to.z - z0);
  // The clip crouches first, flies, then lands: move during its middle.
  await wait(len * 0.22);
  sfx('whoosh');
  await animate(len * 0.5, (k) => {
    p.x = lerp(x0, to.x, k);
    p.z = lerp(z0, to.z, k);
    p.y = Math.sin(k * Math.PI) * (0.9 + d * 0.12);
  });
  p.y = 0;
  sfx('land');
  await wait(len * 0.2);
  setClip(p, 'idle', true);
}

/** The victim reacts and falls. */
async function fall(v: PieceVis, attacker: P2) {
  if (v.role === 'r') {
    // Towers shake, tilt and collapse into a cloud of dust.
    sfx('crumble');
    director.effects.push({ kind: 'dust', from: { x: v.x, y: 0.2, z: v.z }, to: { x: v.x, y: 0.2, z: v.z }, t0: director.now, dur: 1.2, arc: 0, colour: '#b8a98c' });
    const dir = Math.sign(v.x - attacker.x || 1);
    await animate(0.9, (k) => {
      v.tilt = dir * ease(k) * 0.9;
      v.sink = ease(k) * 0.9;
      v.fade = 1 - Math.max(0, (k - 0.5) * 2);
    });
    v.alive = false;
    return;
  }
  await face(v, attacker, 0.12);
  setClip(v, 'hit', false);
  await wait(clipLen(v, 'hit') * 0.55);
  setClip(v, 'death', false);
  sfx('fall');
  await wait(clipLen(v, 'death') * 0.85);
  await animate(0.55, (k) => {
    v.sink = k * 0.35;
    v.fade = 1 - k;
  });
  v.alive = false;
}

function shoot(kind: 'bolt' | 'orb' | 'boulder', from: PieceVis, to: PieceVis): Promise<void> {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const dur = kind === 'bolt' ? 0.12 + d / 18 : kind === 'orb' ? 0.25 + d / 9 : 0.45 + d / 8;
  const fy = kind === 'boulder' ? 1.55 : kind === 'orb' ? 0.95 : 0.7;
  director.effects.push({
    kind,
    from: { x: from.x, y: BOARD_Y + fy, z: from.z },
    to: { x: to.x, y: BOARD_Y + 0.6, z: to.z },
    t0: director.now,
    dur,
    arc: kind === 'boulder' ? 1.6 + d * 0.15 : kind === 'orb' ? 0.4 : 0.1,
    colour: kind === 'orb' ? (from.colour === 'w' ? '#ffd36a' : '#7fb8ff') : '#5b4a36',
  });
  sfx(kind === 'bolt' ? 'bolt' : kind === 'orb' ? 'spell' : 'catapult');
  return wait(dur).then(() => {
    director.effects.push({ kind: 'burst', from: { x: to.x, y: BOARD_Y + 0.6, z: to.z }, to: { x: to.x, y: BOARD_Y + 0.6, z: to.z }, t0: director.now, dur: 0.5, arc: 0, colour: kind === 'orb' ? (from.colour === 'w' ? '#ffcf55' : '#8ec5ff') : '#ffffff' });
    sfx('impact');
  });
}

/** A point `gap` short of `to`, on the line from `from`. */
function shortOf(from: P2, to: P2, gap: number): P2 {
  const d = Math.hypot(to.x - from.x, to.z - from.z) || 1;
  const k = Math.max(0, (d - gap) / d);
  return { x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k };
}

/** Stage one move. */
async function stage(m: KingdomMove) {
  const p = vis(m.mover.id);
  if (!p) return;
  const to = squarePos(m.to);
  director.focus = to;
  const role = m.moverRole;

  if (m.castle) {
    const rook = vis(m.castle.rook.id);
    sfx('march');
    await Promise.all([walk(p, to), rook ? (async () => {
      await wait(0.15);
      await roll(rook, squarePos(m.castle!.to));
    })() : Promise.resolve()]);
    await face(p, { x: p.x, z: p.z + (m.colour === 'w' ? -1 : 1) });
  } else if (m.captured) {
    const v = vis(m.captured.id);
    const vpos = squarePos(m.captured.square);
    if (v) {
      // The defender turns to meet the threat.
      void face(v, p, 0.2).then(() => {
        if (v.role !== 'r') setClip(v, 'block', false);
      });
    }
    if (role === 'b' || role === 'q' || role === 'r') {
      // Rangers shoot, the Sorceress casts, towers bombard: then they take the square.
      if (role !== 'r') await face(p, vpos);
      if (role === 'r') {
        sfx('creak');
        await animate(0.35, (k) => (p.arm = -k * 1.1));
        void animate(0.3, (k) => (p.arm = -1.1 + k * 2.1));
      } else {
        setClip(p, 'attack', false);
        await wait(clipLen(p, 'attack') * (role === 'b' ? 0.42 : 0.5));
      }
      if (v) {
        await shoot(role === 'b' ? 'bolt' : role === 'q' ? 'orb' : 'boulder', p, v);
        const falling = fall(v, p);
        if (role === 'r') void animate(0.4, (k) => (p.arm = 1 - k));
        await wait(role === 'r' ? 0.5 : 0.35);
        setClip(p, 'idle', true);
        await falling;
      }
      await walk(p, to);
    } else {
      // Footmen, Raiders and the King fight hand to hand.
      const strikeFrom = shortOf(p, vpos, role === 'n' ? 1.25 : 1.12);
      if (role === 'n') await leap(p, strikeFrom);
      else await walk(p, strikeFrom, { run: Math.hypot(strikeFrom.x - p.x, strikeFrom.z - p.z) > 3 });
      await face(p, vpos, 0.12);
      setClip(p, 'attack', false);
      sfx('swing');
      await wait(clipLen(p, 'attack') * 0.45);
      sfx('clash');
      director.effects.push({ kind: 'burst', from: { x: vpos.x, y: BOARD_Y + 0.65, z: vpos.z }, to: { x: vpos.x, y: BOARD_Y + 0.65, z: vpos.z }, t0: director.now, dur: 0.4, arc: 0, colour: '#ffffff' });
      if (v) {
        const falling = fall(v, p);
        await wait(clipLen(p, 'attack') * 0.4);
        setClip(p, 'idle', true);
        await falling;
      }
      await walk(p, to);
    }
  } else if (role === 'n') {
    await leap(p, to);
  } else {
    if (role !== 'r') sfx('march');
    await walk(p, to);
  }

  // Back to facing the enemy lines.
  if (!m.castle) await face(p, { x: p.x, z: p.z + (m.colour === 'w' ? -1 : 1) });

  if (m.promotion) {
    // A pillar of light, and the Footman becomes the chosen piece.
    sfx('promote');
    director.effects.push({ kind: 'light', from: { x: p.x, y: 0, z: p.z }, to: { x: p.x, y: 4, z: p.z }, t0: director.now, dur: 1.1, arc: 0, colour: m.colour === 'w' ? '#ffe08a' : '#a8d0ff' });
    await wait(0.45);
    p.role = m.promotion;
    p.glow = 1;
    void animate(1.2, (k) => (p.glow = 1 - k));
    if (p.role !== 'r') setClip(p, 'cheer', false);
    await wait(0.9);
    setClip(p, 'idle', true);
  }

  if (m.check && !m.mate) {
    // The threatened king raises his guard.
    const king = [...director.pieces.values()].find((x) => x.alive && x.role === 'k' && x.colour !== m.colour);
    if (king) {
      sfx('check');
      setClip(king, 'block', false);
      await wait(0.6);
      setClip(king, 'idle', true);
    }
  }
}

/** End state of any scene: every piece exactly where the rules say. */
function settle(tracker: PieceTracker) {
  const onBoard = new Set(tracker.at.values());
  for (const [id, p] of director.pieces) {
    if (!onBoard.has(id)) {
      if (p.alive && p.fade > 0) {
        p.alive = false;
        p.fade = 0;
      }
      continue;
    }
    const t = tracker.pieces.get(id)!;
    p.role = t.role;
  }
  for (const [sq, id] of tracker.at) {
    let p = director.pieces.get(id);
    const pos = squarePos(sq);
    if (!p) {
      const t = tracker.pieces.get(id)!;
      p = { id, colour: t.colour, role: t.role, x: pos.x, z: pos.z, y: 0, yaw: homeYaw(t.colour), clip: 'idle', clipStart: director.now, loop: true, fade: 1, sink: 0, tilt: 0, arm: 0, alive: true, glow: 0 };
      director.pieces.set(id, p);
    }
    if (Math.hypot(p.x - pos.x, p.z - pos.z) > 0.05) {
      p.x = pos.x;
      p.z = pos.z;
    }
    p.y = 0;
    p.alive = true;
    p.fade = 1;
    p.sink = 0;
    p.tilt = 0;
    if (!p.loop && director.now - p.clipStart > 2.5 && p.clip !== 'death') setClip(p, 'idle', true);
  }
}
