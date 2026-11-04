/**
 * Runs a game of Chess Kingdom on this device: the rules (KingdomGame), the
 * computer opponent, clocks, and the director that stages each move.
 * React reads it through the store's `rev`; the scene calls `frame` every frame.
 *
 * Online play (stage 2) plugs in as another `Seat` source; the same code
 * stages the moves whoever makes them.
 */
import { KingdomGame, ROLE_NAME, searchKingdom, TIME_CONTROLS, type Colour, type MoveInput, type Role } from '@cr/chess-core';
import { director } from './director';
import { sfx, sound, unlockAudio } from './sound';
import { toast, useKingdom, type Opponent } from './store';
import { leaveOnlineGame, onlineDraw, onlineResign } from './online';

const ANIM_SPEED = { cinematic: 1, quick: 2.2, off: 0 } as const;
/** The computer never answers faster than this (s), so its moves can be followed. */
const MIN_THINK = 0.7;
/** Work budget for the computer's search per frame (ms). */
const AI_SLICE_MS = 7;

export const kc = {
  game: new KingdomGame(),
  opponent: 'ai' as Opponent,
  /** Colour(s) the person at this device plays; null when watching an online game. */
  you: 'w' as Colour | 'both' | null,
  ai: null as null | { it: Generator<void, string | null>; started: number; result?: string | null },
  /** Real time (ms) of the game's clock reference. */
  clockNow: () => performance.now(),
  lastTick: 0,
  /** Called by online play to send a move instead of playing it locally. */
  send: null as null | ((m: MoveInput) => void),
  /** In a clash: may this person move the soldier on this square now? */
  mayMove: null as null | ((sq: string) => boolean),
  /** In a clash: a move becomes a proposal to the cluster instead of being played. */
  propose: null as null | ((m: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) => void),
};

const bump = () => useKingdom.setState((s) => ({ rev: s.rev + 1 }));

export const canMove = (c: Colour) => !kc.game.over && kc.game.turn === c && (kc.you === 'both' || kc.you === c);
export const humanToMove = () => canMove(kc.game.turn);
export const aiColour = (): Colour | null => (kc.opponent === 'ai' ? (kc.you === 'w' ? 'b' : 'w') : null);
export const online = () => kc.opponent === 'online';
export const clashing = () => kc.opponent === 'clash';

export function startGame(opts: { opponent: Opponent; side?: Colour | 'random'; tc?: string; level?: string; fen?: string }) {
  unlockAudio();
  const s = useKingdom.getState();
  const tc = TIME_CONTROLS[opts.tc ?? s.tc] ?? null;
  kc.game = new KingdomGame({ timeControl: tc, ...(opts.fen ? { fen: opts.fen } : {}) });
  kc.opponent = opts.opponent;
  kc.ai = null;
  if (kc.opponent === 'online' || opts.opponent === 'online') leaveOnlineGame();
  kc.send = null;
  kc.mayMove = null;
  kc.propose = null;
  const side = opts.side ?? s.side;
  kc.you = opts.opponent === 'local' ? 'both' : side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
  director.speed = ANIM_SPEED[s.animSpeed];
  director.sync(kc.game.tracker);
  useKingdom.setState({
    screen: 'playing',
    opponent: opts.opponent,
    selected: null,
    targets: [],
    promotion: null,
    result: null,
    showResult: false,
    thinking: false,
    showMenu: false,
    card: null,
    viewFrom: kc.you === 'both' ? 'w' : kc.you,
  });
  bump();
  if (kc.opponent === 'ai' && kc.you === 'b') toast('The Sun moves first. The computer opens…');
  else toast(kc.opponent === 'local' ? 'The Sun moves first. Tap a soldier to see where it can go.' : 'Your move. Tap a soldier to see where it can go.', 'good');
}

/** A tap on a square (from the board, a piece, or a highlight). */
export function tapSquare(sq: string) {
  unlockAudio();
  const s = useKingdom.getState();
  const g = kc.game;
  if (g.over || s.promotion) return;
  const piece = g.tracker.on(sq);
  // Moving the selected piece to a legal square.
  if (s.selected && s.targets.includes(sq)) {
    if (g.isPromotion(s.selected, sq)) {
      useKingdom.setState({ promotion: { from: s.selected, to: sq } });
      return;
    }
    play({ from: s.selected, to: sq });
    return;
  }
  // Selecting one of your own pieces (or any piece, just to read its card).
  if (piece) {
    const mine = kc.mayMove ? kc.mayMove(sq) : canMove(piece.colour);
    if (s.selected === sq) {
      useKingdom.setState({ selected: null, targets: [], card: null });
      return;
    }
    sfx('select');
    useKingdom.setState({ selected: sq, targets: mine ? g.targets(sq) : [], card: { role: piece.role, colour: piece.colour } });
    if (!mine && !g.over && humanToMove() && piece.colour === g.turn) toast(kc.mayMove ? 'Another member commands that soldier.' : 'Not your soldier.', 'warn');
    return;
  }
  useKingdom.setState({ selected: null, targets: [], card: null });
}

export function choosePromotion(role: Role | null) {
  const p = useKingdom.getState().promotion;
  useKingdom.setState({ promotion: null });
  if (!p || !role) return;
  play({ from: p.from, to: p.to, promotion: role as 'q' | 'r' | 'b' | 'n' });
}

/** Play a move for the side to move (a person at this device, or the computer). */
export function play(m: MoveInput): boolean {
  if (clashing()) {
    // A clash move is a proposal; it reaches the board when the cluster decides.
    if (kc.propose && typeof m !== 'string') kc.propose(m);
    useKingdom.setState({ selected: null, targets: [], card: null });
    return true;
  }
  if (online() && !humanToMove()) return false;
  const r = kc.game.move(kc.game.turn, m, kc.clockNow());
  if (!r.ok) {
    toast(r.reason, 'warn');
    return false;
  }
  // Online, the move shows at once and goes to the server, which checks it and runs the clocks.
  if (online() && kc.send) kc.send({ from: r.move.from, to: r.move.to, ...(r.move.promotion ? { promotion: r.move.promotion as 'q' | 'r' | 'b' | 'n' } : {}) });
  afterMove();
  void director.play(r.move, kc.game.tracker).then(() => {
    if (kc.opponent === 'local' && useKingdom.getState().flipEachTurn && !kc.game.over) useKingdom.setState({ viewFrom: kc.game.turn });
    bump();
  });
  return true;
}

/** Bookkeeping after any move. */
function afterMove() {
  const g = kc.game;
  const last = g.history.at(-1)!;
  useKingdom.setState({ selected: null, targets: [], card: null });
  // Online, the result comes from the server.
  if (g.result && online()) bump();
  else if (g.result) finish();
  else if (last.check) {
    const victim = last.colour === 'w' ? 'b' : 'w';
    if (kc.you === 'both' || kc.you === victim) toast('Check! Your King is under attack.', 'warn');
    else toast('Check!', 'good');
  }
  bump();
}

function finish() {
  const g = kc.game;
  const r = g.result!;
  useKingdom.setState({ result: r, thinking: false });
  director.celebrate(r.winner, g.tracker, r.reason);
  // Show the report once the last scene has played.
  void director.queue.then(() => setTimeout(() => useKingdom.setState({ showResult: true }), director.speed ? 1600 : 300));
  bump();
}

export function resign() {
  const g = kc.game;
  if (g.over) return;
  if (online()) {
    onlineResign();
    useKingdom.setState({ showMenu: false });
    return;
  }
  const c: Colour = kc.you === 'both' || !kc.you ? g.turn : kc.you;
  g.resign(c);
  useKingdom.setState({ showMenu: false });
  finish();
}

export function offerDraw() {
  const g = kc.game;
  if (g.over) return;
  if (online()) {
    onlineDraw();
    toast('Draw offered.');
    return;
  }
  if (kc.opponent === 'ai') {
    // The computer accepts only when it is clearly worse or the board is bare.
    const ai = aiColour()!;
    const adv = g.material() * (ai === 'w' ? 1 : -1);
    if (adv <= -3 || g.history.length > 80) {
      g.offerDraw(kc.you as Colour);
      g.offerDraw(ai);
      toast('The computer accepts the draw.', 'good');
      finish();
    } else toast('The computer declines. Fight on!', 'warn');
    return;
  }
  if (kc.opponent === 'local') {
    g.offerDraw(g.turn);
    g.offerDraw(g.turn === 'w' ? 'b' : 'w');
    finish();
  }
}

/** Take back your last move (and the computer's reply) against the computer, untimed only. */
export function takeback() {
  const g = kc.game;
  if (kc.opponent !== 'ai' || g.timeControl || g.over) return;
  const you = kc.you as Colour;
  const sans = g.history.map((m) => m.san);
  // Remove back to (and including) your last move.
  let n = sans.length;
  while (n > 0 && g.history[n - 1]!.colour !== you) n--;
  if (n === 0) return toast('Nothing to take back yet.', 'warn');
  const keep = sans.slice(0, n - 1);
  const fresh = new KingdomGame({ timeControl: null });
  keep.forEach((s, i) => fresh.move(fresh.turn, s, i));
  kc.game = fresh;
  kc.ai = null;
  director.sync(fresh.tracker);
  useKingdom.setState({ selected: null, targets: [], card: null, thinking: false });
  bump();
  toast('Move taken back.');
}

/** Called by the scene every frame. */
export function frame(dt: number) {
  director.update(dt);
  const g = kc.game;
  const now = kc.clockNow();
  // Online, only the server's clock decides a loss on time.
  if (!online() && !clashing() && !g.over && g.checkTime(now)) finish();

  // Low-time ticking for the person at this device.
  if (g.timeControl && !g.over && humanToMove()) {
    const left = g.timeLeft(g.turn, now);
    if (left < 10_000 && Math.floor(left / 1000) !== kc.lastTick) {
      kc.lastTick = Math.floor(left / 1000);
      sfx('tick');
    }
  }

  // The computer thinks once the last scene has played.
  const ai = aiColour();
  if (ai && !g.over && g.turn === ai && !director.busy && useKingdom.getState().screen === 'playing') {
    if (!kc.ai) {
      kc.ai = { it: searchKingdom(g.chess.fen, useKingdom.getState().aiLevel), started: performance.now() };
      useKingdom.setState({ thinking: true });
    }
    const t0 = performance.now();
    while (!('result' in kc.ai) && performance.now() - t0 < AI_SLICE_MS) {
      const r = kc.ai.it.next();
      if (r.done) kc.ai.result = r.value;
    }
    if ('result' in kc.ai && performance.now() - kc.ai.started > MIN_THINK * 1000) {
      const san = kc.ai.result;
      kc.ai = null;
      useKingdom.setState({ thinking: false });
      if (san) play(san);
    }
  }
}

export function setAnimSpeed(v: keyof typeof ANIM_SPEED) {
  director.speed = ANIM_SPEED[v];
  useKingdom.setState({ animSpeed: v });
}

export function setSound(on: boolean) {
  sound.on = on;
  useKingdom.setState({ sound: on });
}
sound.on = useKingdom.getState().sound;

export function exitToHome() {
  kc.ai = null;
  kc.mayMove = null;
  kc.propose = null;
  if (online()) leaveOnlineGame();
  kc.send = null;
  kc.opponent = 'ai';
  useKingdom.setState({ screen: 'home', showMenu: false, showResult: false, result: null, selected: null, targets: [], card: null, thinking: false });
}

export const pieceLabel = (role: Role) => ROLE_NAME[role];
