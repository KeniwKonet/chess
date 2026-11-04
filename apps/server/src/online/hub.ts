/**
 * The online game hub: invites and quick pairing, every live game (moves,
 * clocks, offers, results, ratings), the people connected to each game
 * (players and spectators), and reconnection.
 *
 * Every game is refereed here with KingdomGame and the server's clock, and
 * saved after every move, so a restart of the server resumes the games.
 */
import { randomInt } from 'node:crypto';
import {
  KingdomGame,
  ONLINE_TIME_CONTROLS,
  ONLINE_TIMING,
  ratingCategory,
  TIME_CONTROLS,
  type ClientMsg,
  type Colour,
  type GameRecord,
  type GameStatus,
  type GameView,
  type LiveGame,
  type OnlineTc,
  type Presence,
  type SeatInfo,
  type ServerMsg,
} from '@cr/chess-core';
import type { Accounts, UserRow } from './accounts';
import type { Db } from './db';
import { PROVISIONAL_RD, rate } from './glicko';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const other = (c: Colour): Colour => (c === 'w' ? 'b' : 'w');
/** Untimed games with nobody connected leave memory after this (they stay saved). */
const IDLE_EVICT_MS = 10 * 60_000;

export interface Conn {
  user: UserRow | null;
  send: (m: ServerMsg) => void;
  games: Set<string>;
  seek: string | null;
  /** Message budget (simple token bucket). */
  budget: number;
  lastRefill: number;
}

type RatingChange = Record<Colour, { before: number; after: number }>;

interface Live {
  code: string;
  tc: OnlineTc;
  rated: boolean;
  status: GameStatus;
  creator: SeatInfo;
  creatorColour: Colour | 'random';
  seats: Partial<Record<Colour, SeatInfo>>;
  game: KingdomGame | null;
  createdAt: number;
  startedAt: number | null;
  /** Players and spectators connected to this game. */
  conns: Set<Conn>;
  awaySince: Partial<Record<Colour, number>>;
  timer: NodeJS.Timeout | null;
  rematchOffer: Colour | null;
  rematchNext?: string;
  ratingChange?: RatingChange;
  saving: Promise<unknown>;
  idleSince: number | null;
}

export interface HubOptions {
  /** Clock source (ms); tests pass a fake one. */
  now?: () => number;
  /** Turn off timers (tests drive `tick` by hand). */
  timers?: boolean;
  /** Time each side has for its first move (ms); default ONLINE_TIMING.firstMove. */
  firstMoveMs?: number;
  log?: (...a: unknown[]) => void;
}

export class Hub {
  readonly games = new Map<string, Live>();
  /** Waiting seekers per "tc|rated". */
  readonly pool = new Map<string, Conn[]>();
  readonly conns = new Set<Conn>();
  private now: () => number;
  private timers: boolean;
  private firstMoveMs: number;
  private log: (...a: unknown[]) => void;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private accounts: Accounts,
    opts: HubOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? true;
    this.firstMoveMs = opts.firstMoveMs ?? (Number(process.env.FIRST_MOVE_MS) || ONLINE_TIMING.firstMove);
    this.log = opts.log ?? console.log;
    if (this.timers) this.sweeper = setInterval(() => this.sweep(), 60_000);
  }

  /** Bring back games that were waiting or in play when the server last stopped. */
  async restore() {
    const rows = await this.db.query<GameRow>("select * from games where status in ('waiting','playing')");
    for (const r of rows) {
      try {
        const g = await this.fromRow(r);
        if (g.status === 'waiting' && this.now() - g.createdAt > ONLINE_TIMING.inviteTtl) {
          g.status = 'aborted';
          await this.persist(g);
          continue;
        }
        this.games.set(g.code, g);
        this.schedule(g);
      } catch (e) {
        this.log('could not restore game', r.code, e);
      }
    }
    if (rows.length) this.log(`restored ${this.games.size} online games`);
  }

  close() {
    for (const g of this.games.values()) if (g.timer) clearTimeout(g.timer);
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /* ---------- connections ---------- */

  connect(send: (m: ServerMsg) => void): Conn {
    const c: Conn = { user: null, send, games: new Set(), seek: null, budget: 40, lastRefill: this.now() };
    this.conns.add(c);
    return c;
  }

  disconnect(c: Conn) {
    this.conns.delete(c);
    this.unseek(c);
    for (const code of c.games) {
      const g = this.games.get(code);
      if (!g) continue;
      g.conns.delete(c);
      const seat = this.seatOf(g, c);
      if (seat && !this.seatConnected(g, seat) && g.status === 'playing') g.awaySince[seat] = this.now();
      if (g.conns.size === 0) g.idleSince = this.now();
      this.broadcastPresence(g);
    }
    c.games.clear();
  }

  /** Handle one message from a browser. */
  async receive(c: Conn, msg: ClientMsg) {
    // Rate limit: 40 messages, refilling 10 per second.
    const t = this.now();
    c.budget = Math.min(40, c.budget + ((t - c.lastRefill) / 1000) * 10);
    c.lastRefill = t;
    if (c.budget < 1) return c.send({ t: 'error', message: 'Too many messages. Slow down a little.' });
    c.budget -= 1;

    if (msg.t === 'ping') return c.send({ t: 'pong', at: msg.at, serverNow: this.now() });
    if (msg.t === 'auth') {
      const u = await this.accounts.fromToken(msg.token);
      if (!u) return c.send({ t: 'error', message: 'Please sign in again.', code: 'auth' });
      c.user = u;
      return c.send({ t: 'ready', user: (await this.accounts.publicUser(u.id))! });
    }
    if (msg.t === 'watch') return this.attach(c, String(msg.code), false);
    if (!c.user) return c.send({ t: 'error', message: 'Please sign in first.', code: 'auth' });
    // Refresh the user (a guest may have just made an account).
    c.user = (await this.accounts.user(c.user.id)) ?? c.user;
    switch (msg.t) {
      case 'invite':
        return this.invite(c, msg.tc, msg.colour, !!msg.rated);
      case 'seek':
        return this.seekGame(c, msg.tc, !!msg.rated);
      case 'cancel':
        return this.cancel(c);
      case 'join':
        return this.attach(c, String(msg.code), true);
      case 'leave': {
        const g = this.games.get(msg.code);
        if (g) {
          g.conns.delete(c);
          c.games.delete(g.code);
          const seat = this.seatOf(g, c);
          if (seat && !this.seatConnected(g, seat) && g.status === 'playing') g.awaySince[seat] = this.now();
          this.broadcastPresence(g);
        }
        return;
      }
      case 'move':
        return this.move(c, msg.code, msg.ply, msg.move);
      case 'resign':
        return this.act(c, msg.code, (g, seat) => {
          if (g.game!.history.length < 2) return this.finish(g, 'aborted', null, 'aborted');
          g.game!.resign(seat);
          return this.finish(g, 'over');
        });
      case 'abort':
        return this.act(c, msg.code, (g) => {
          if (g.game!.history.length >= 2) return c.send({ t: 'error', message: 'Too late to call it off. You can resign or offer a draw.' });
          return this.finish(g, 'aborted', null, 'aborted');
        });
      case 'draw':
        return this.act(c, msg.code, (g, seat) => {
          if (g.game!.history.length < 2) return c.send({ t: 'error', message: 'Make your first moves before offering a draw.' });
          if (g.game!.offerDraw(seat)) return this.finish(g, 'over');
          this.broadcast(g, { t: 'offer', code: g.code, drawOffer: g.game!.drawOffer });
        });
      case 'decline':
        return this.act(c, msg.code, (g, seat) => {
          g.game!.declineDraw(seat);
          this.broadcast(g, { t: 'offer', code: g.code, drawOffer: g.game!.drawOffer });
        });
      case 'claim':
        return this.act(c, msg.code, (g, seat) => {
          const opp = other(seat);
          const away = g.awaySince[opp];
          if (away === undefined || this.seatConnected(g, opp) || this.now() - away < ONLINE_TIMING.abandon)
            return c.send({ t: 'error', message: 'Your opponent can still come back.' });
          if (g.game!.history.length < 2) return this.finish(g, 'aborted', null, 'aborted');
          return this.finish(g, 'over', seat, 'abandoned');
        });
      case 'rematch':
        return this.rematch(c, msg.code);
    }
  }

  /* ---------- starting games ---------- */

  private async seat(u: UserRow, tc: OnlineTc): Promise<SeatInfo> {
    const cat = ratingCategory(tc);
    if (!cat) return { id: u.id, name: u.name, guest: u.guest, rating: null, provisional: false };
    const r = await this.accounts.glicko(u.id, cat);
    return { id: u.id, name: u.name, guest: u.guest, rating: Math.round(r.rating), provisional: r.rd >= PROVISIONAL_RD };
  }

  private validTc(tc: unknown): tc is OnlineTc {
    return typeof tc === 'string' && (ONLINE_TIME_CONTROLS as readonly string[]).includes(tc);
  }

  private async invite(c: Conn, tc: OnlineTc, colour: Colour | 'random', rated: boolean) {
    if (!this.validTc(tc)) return c.send({ t: 'error', message: 'Unknown time control.' });
    if (colour !== 'w' && colour !== 'b') colour = 'random';
    this.unseek(c);
    const u = c.user!;
    // Rated games need a timed control and an account.
    rated = rated && !!ratingCategory(tc) && !u.guest;
    const g = this.blank(newCode(), tc, rated, await this.seat(u, tc), colour);
    this.games.set(g.code, g);
    await this.persist(g);
    c.send({ t: 'invited', code: g.code });
    await this.attach(c, g.code, true);
  }

  private async seekGame(c: Conn, tc: OnlineTc, rated: boolean) {
    if (!this.validTc(tc)) return c.send({ t: 'error', message: 'Unknown time control.' });
    const u = c.user!;
    rated = rated && !!ratingCategory(tc) && !u.guest;
    this.unseek(c);
    const key = `${tc}|${rated}`;
    const queue = this.pool.get(key) ?? [];
    const mine = await this.seat(u, tc);
    // Pair with the waiting player closest in rating (anyone but yourself).
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const o = queue[i]!;
      if (!o.user || o.user.id === u.id || !this.conns.has(o)) continue;
      const gap = Math.abs(((await this.seat(o.user, tc)).rating ?? 1500) - (mine.rating ?? 1500));
      if (gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best < 0) {
      queue.push(c);
      this.pool.set(key, queue);
      c.seek = key;
      return c.send({ t: 'seeking', tc, rated, waiting: queue.length - 1 });
    }
    const o = queue.splice(best, 1)[0]!;
    o.seek = null;
    if (!queue.length) this.pool.delete(key);
    const theirs = await this.seat(o.user!, tc);
    const g = this.blank(newCode(), tc, rated, theirs, 'random');
    this.games.set(g.code, g);
    const youWhite = randomInt(2) === 0;
    g.seats = youWhite ? { w: mine, b: theirs } : { w: theirs, b: mine };
    await this.start(g, [c, o]);
  }

  private unseek(c: Conn) {
    if (!c.seek) return;
    const q = this.pool.get(c.seek);
    if (q) {
      const i = q.indexOf(c);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) this.pool.delete(c.seek);
    }
    c.seek = null;
  }

  private async cancel(c: Conn) {
    this.unseek(c);
    // Close your own open invites.
    for (const g of this.games.values()) {
      if (g.status === 'waiting' && g.creator.id === c.user!.id) {
        g.status = 'aborted';
        await this.persist(g);
        this.broadcast(g, { t: 'end', code: g.code, result: { winner: null, reason: 'cancelled' }, status: 'aborted' });
        this.drop(g);
      }
    }
    c.send({ t: 'cancelled' });
  }

  private blank(code: string, tc: OnlineTc, rated: boolean, creator: SeatInfo, creatorColour: Colour | 'random'): Live {
    return {
      code,
      tc,
      rated,
      status: 'waiting',
      creator,
      creatorColour,
      seats: {},
      game: null,
      createdAt: this.now(),
      startedAt: null,
      conns: new Set(),
      awaySince: {},
      timer: null,
      rematchOffer: null,
      saving: Promise.resolve(),
      idleSince: null,
    };
  }

  private async start(g: Live, conns: Conn[]) {
    g.game = new KingdomGame({ timeControl: TIME_CONTROLS[g.tc] ?? null });
    g.status = 'playing';
    g.startedAt = this.now();
    g.awaySince = {};
    await this.persist(g);
    for (const c of conns) {
      g.conns.add(c);
      c.games.add(g.code);
    }
    for (const c of g.conns) c.send({ t: 'game', game: this.view(g, c) });
    this.schedule(g);
  }

  /** Open a game by its code: join a waiting invite, come back to your own game, or watch. */
  private async attach(c: Conn, code: string, wantSeat: boolean) {
    let g = this.games.get(code);
    if (!g) {
      const row = (await this.db.query<GameRow>('select * from games where code = $1', [code]))[0];
      if (!row) return c.send({ t: 'error', message: 'No game with that link. Check it, or ask for a new invite.', code: 'missing' });
      if (row.status === 'over' || row.status === 'aborted') {
        const rec = await this.record(row);
        return c.send({ t: 'game', game: { ...rec, clocks: null, running: null, drawOffer: null, you: this.seatOfId(rec, c.user?.id), presence: { w: false, b: false, watchers: 0, awaySince: {} }, serverNow: this.now() } });
      }
      g = await this.fromRow(row);
      this.games.set(code, g);
      this.schedule(g);
    }
    g.idleSince = null;
    const u = c.user;
    if (g.status === 'waiting' && wantSeat && u && u.id !== g.creator.id) {
      if (g.rated && u.guest) return c.send({ t: 'error', message: 'This is a rated game. Create a free account to join it, or ask your friend for a casual game.', code: 'rated-guest' });
      const joiner = await this.seat(u, g.tc);
      const creatorWhite = g.creatorColour === 'w' || (g.creatorColour === 'random' && randomInt(2) === 0);
      g.seats = creatorWhite ? { w: g.creator, b: joiner } : { w: joiner, b: g.creator };
      await this.start(g, [c]);
      return;
    }
    g.conns.add(c);
    c.games.add(g.code);
    const seat = this.seatOf(g, c);
    if (seat) delete g.awaySince[seat];
    c.send({ t: 'game', game: this.view(g, c) });
    this.broadcastPresence(g);
  }

  /* ---------- playing ---------- */

  private async act(c: Conn, code: string, fn: (g: Live, seat: Colour) => unknown) {
    const g = this.games.get(code);
    if (!g || g.status !== 'playing' || !g.game) return c.send({ t: 'error', message: 'That game is not in play.', code: 'state' });
    const seat = this.seatOf(g, c);
    if (!seat) return c.send({ t: 'error', message: 'You are watching this game.' });
    if (this.flagCheck(g)) return;
    await fn(g, seat);
  }

  private async move(c: Conn, code: string, ply: number, mv: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) {
    await this.act(c, code, async (g, seat) => {
      const game = g.game!;
      if (ply !== game.history.length) return c.send({ t: 'game', game: this.view(g, c) });
      if (!mv || typeof mv.from !== 'string' || typeof mv.to !== 'string') return;
      const r = game.move(seat, { from: mv.from.slice(0, 2), to: mv.to.slice(0, 2), ...(mv.promotion ? { promotion: mv.promotion } : {}) }, this.now());
      if (!r.ok) {
        c.send({ t: 'error', message: r.reason });
        return c.send({ t: 'game', game: this.view(g, c) });
      }
      g.rematchOffer = null;
      const { clocks, running } = this.clocks(g);
      this.broadcast(g, { t: 'move', code: g.code, ply: game.history.length, san: r.move.san, clocks, running, serverNow: this.now() });
      if (game.result) await this.finish(g, 'over');
      else {
        await this.persist(g);
        this.schedule(g);
      }
    });
  }

  /** Ends the game on time if the side to move has run out. */
  private flagCheck(g: Live): boolean {
    if (g.status !== 'playing' || !g.game) return false;
    if (g.game.checkTime(this.now())) {
      void this.finish(g, 'over');
      return true;
    }
    return false;
  }

  /** Called by timers (and by tests): flags, first-move limits, and idle games. */
  tick(code?: string) {
    const list = code ? [this.games.get(code)].filter((g): g is Live => !!g) : [...this.games.values()];
    for (const g of list) {
      if (g.status !== 'playing' || !g.game) continue;
      if (this.flagCheck(g)) continue;
      const deadline = this.firstMoveDeadline(g);
      if (deadline !== null && this.now() >= deadline) void this.finish(g, 'aborted', null, 'aborted');
      else this.schedule(g);
    }
  }

  private firstMoveDeadline(g: Live): number | null {
    const n = g.game!.history.length;
    if (n >= 2) return null;
    const since = n === 0 ? g.startedAt! : g.game!.turnStartedAt!;
    return since + this.firstMoveMs;
  }

  private schedule(g: Live) {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    if (!this.timers || g.status !== 'playing' || !g.game) return;
    const now = this.now();
    let next = Infinity;
    const fm = this.firstMoveDeadline(g);
    if (fm !== null) next = Math.min(next, fm);
    if (g.game.timeControl && g.game.turnStartedAt !== null) next = Math.min(next, now + g.game.timeLeft(g.game.turn, now));
    if (next === Infinity) return;
    g.timer = setTimeout(() => this.tick(g.code), Math.max(20, next - now + 15));
  }

  private async finish(g: Live, status: 'over' | 'aborted', winner?: Colour | null, reason?: string) {
    if (g.status === 'over' || g.status === 'aborted') return;
    const game = g.game!;
    if (reason === 'abandoned' && winner) game.result = { winner, reason: 'abandoned' };
    g.status = status;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    const result = status === 'aborted' ? { winner: null, reason: reason ?? 'aborted' } : game.result!;
    if (status === 'over') {
      await this.recordResult(g, result.winner);
    }
    await this.persist(g, result);
    this.broadcast(g, { t: 'end', code: g.code, result, status, ...(g.ratingChange ? { ratingChange: g.ratingChange } : {}) });
  }

  private async recordResult(g: Live, winner: Colour | null) {
    const w = g.seats.w!;
    const b = g.seats.b!;
    const col = (id: number, k: 'wins' | 'losses' | 'draws') => this.db.query(`update users set games = games + 1, ${k} = ${k} + 1 where id = $1`, [id]);
    await col(w.id, winner === 'w' ? 'wins' : winner === 'b' ? 'losses' : 'draws');
    await col(b.id, winner === 'b' ? 'wins' : winner === 'w' ? 'losses' : 'draws');
    const cat = ratingCategory(g.tc);
    if (!g.rated || !cat || w.guest || b.guest) return;
    const rw = await this.accounts.glicko(w.id, cat);
    const rb = await this.accounts.glicko(b.id, cat);
    const s = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const nw = rate(rw, rb, s);
    const nb = rate(rb, rw, 1 - s);
    await this.accounts.saveGlicko(w.id, cat, nw);
    await this.accounts.saveGlicko(b.id, cat, nb);
    g.ratingChange = {
      w: { before: Math.round(rw.rating), after: Math.round(nw.rating) },
      b: { before: Math.round(rb.rating), after: Math.round(nb.rating) },
    };
  }

  private async rematch(c: Conn, code: string) {
    const g = this.games.get(code);
    if (!g || (g.status !== 'over' && g.status !== 'aborted') || !g.seats.w || !g.seats.b) return c.send({ t: 'error', message: 'A rematch is offered once the game ends.' });
    const seat = this.seatOf(g, c);
    if (!seat) return;
    if (g.rematchNext) return c.send({ t: 'rematch', code, by: null, next: g.rematchNext });
    if (g.rematchOffer === other(seat)) {
      const next = this.blank(newCode(), g.tc, g.rated, g.seats.b, 'w');
      // Swap colours; refresh ratings for the new game.
      next.seats = { w: await this.seatFromId(g.seats.b.id, g.tc), b: await this.seatFromId(g.seats.w.id, g.tc) };
      next.creator = next.seats.w!;
      this.games.set(next.code, next);
      g.rematchNext = next.code;
      g.rematchOffer = null;
      this.broadcast(g, { t: 'rematch', code, by: null, next: next.code });
      await this.start(next, []);
      return;
    }
    g.rematchOffer = seat;
    this.broadcast(g, { t: 'rematch', code, by: seat });
  }

  private async seatFromId(id: number, tc: OnlineTc): Promise<SeatInfo> {
    const u = await this.accounts.user(id);
    return this.seat(u!, tc);
  }

  /* ---------- views ---------- */

  private seatOf(g: Live, c: Conn): Colour | null {
    if (!c.user) return null;
    if (g.seats.w?.id === c.user.id) return 'w';
    if (g.seats.b?.id === c.user.id) return 'b';
    return null;
  }

  private seatOfId(r: { white: SeatInfo | null; black: SeatInfo | null }, id?: number): Colour | null {
    if (!id) return null;
    return r.white?.id === id ? 'w' : r.black?.id === id ? 'b' : null;
  }

  private seatConnected(g: Live, seat: Colour): boolean {
    for (const c of g.conns) if (this.seatOf(g, c) === seat) return true;
    return false;
  }

  private presence(g: Live): Presence {
    const watchers = new Set<number | Conn>();
    for (const c of g.conns) if (!this.seatOf(g, c) && !(g.status === 'waiting' && c.user?.id === g.creator.id)) watchers.add(c.user?.id ?? c);
    return { w: this.seatConnected(g, 'w'), b: this.seatConnected(g, 'b'), watchers: watchers.size, awaySince: { ...g.awaySince } };
  }

  private clocks(g: Live): { clocks: Record<Colour, number> | null; running: Colour | null } {
    const game = g.game;
    const tc = TIME_CONTROLS[g.tc];
    if (!tc) return { clocks: null, running: null };
    if (!game) return { clocks: { w: tc.initialMs, b: tc.initialMs }, running: null };
    const now = this.now();
    const running = g.status === 'playing' && game.turnStartedAt !== null ? game.turn : null;
    return { clocks: { w: Math.round(game.timeLeft('w', now)), b: Math.round(game.timeLeft('b', now)) }, running };
  }

  view(g: Live, c: Conn): GameView {
    const { clocks, running } = this.clocks(g);
    return {
      code: g.code,
      tc: g.tc,
      rated: g.rated,
      status: g.status,
      white: g.status === 'waiting' ? (g.creatorColour === 'w' ? g.creator : null) : (g.seats.w ?? null),
      black: g.status === 'waiting' ? (g.creatorColour === 'b' ? g.creator : null) : (g.seats.b ?? null),
      creatorColour: g.creatorColour,
      creator: g.creator,
      moves: g.game?.history.map((m) => m.san) ?? [],
      clocks,
      running,
      result: g.status === 'aborted' ? { winner: null, reason: 'aborted' } : (g.game?.result ?? null),
      drawOffer: g.game?.drawOffer ?? null,
      you: this.seatOf(g, c),
      presence: this.presence(g),
      ...(g.ratingChange ? { ratingChange: g.ratingChange } : {}),
      rematchOffer: g.rematchOffer,
      ...(g.rematchNext ? { rematchOf: g.rematchNext } : {}),
      serverNow: this.now(),
    };
  }

  private broadcast(g: Live, m: ServerMsg) {
    for (const c of g.conns) c.send(m);
  }

  private broadcastPresence(g: Live) {
    this.broadcast(g, { t: 'presence', code: g.code, presence: this.presence(g) });
  }

  live(): LiveGame[] {
    const out: LiveGame[] = [];
    for (const g of this.games.values()) {
      if (g.status !== 'playing' || !g.seats.w || !g.seats.b || !g.game) continue;
      out.push({ code: g.code, tc: g.tc, rated: g.rated, white: g.seats.w, black: g.seats.b, moves: g.game.history.length, watchers: this.presence(g).watchers });
    }
    return out.sort((a, b) => (b.white.rating ?? 0) + (b.black.rating ?? 0) - ((a.white.rating ?? 0) + (a.black.rating ?? 0)) || b.watchers - a.watchers).slice(0, 40);
  }

  /** Drop finished and long-idle games from memory (they stay saved). */
  private sweep() {
    const now = this.now();
    for (const g of this.games.values()) {
      const done = g.status === 'over' || g.status === 'aborted';
      if (g.conns.size === 0 && g.idleSince === null) g.idleSince = now;
      if (g.conns.size > 0 || g.idleSince === null) continue;
      const untimed = !TIME_CONTROLS[g.tc];
      if (done || (untimed && now - g.idleSince > IDLE_EVICT_MS) || (g.status === 'waiting' && now - g.idleSince > IDLE_EVICT_MS)) this.drop(g);
    }
  }

  private drop(g: Live) {
    if (g.timer) clearTimeout(g.timer);
    this.games.delete(g.code);
  }

  /* ---------- saving and loading ---------- */

  private persist(g: Live, result?: { winner: Colour | null; reason: string } | null) {
    const game = g.game;
    const { clocks } = this.clocks(g);
    const r = result ?? (g.status === 'over' ? game?.result : null);
    const params = [
      g.code,
      g.tc,
      g.rated,
      g.status,
      g.seats.w?.id ?? null,
      g.seats.b?.id ?? null,
      g.creator.id,
      g.creatorColour,
      game?.history.map((m) => m.san).join(' ') ?? '',
      clocks?.w ?? null,
      clocks?.b ?? null,
      r ? (r.winner ?? 'draw') : null,
      r?.reason ?? null,
      g.ratingChange?.w.before ?? null,
      g.ratingChange?.w.after ?? null,
      g.ratingChange?.b.before ?? null,
      g.ratingChange?.b.after ?? null,
      g.startedAt ? new Date(g.startedAt) : null,
      g.status === 'over' || g.status === 'aborted' ? new Date(this.now()) : null,
      new Date(g.createdAt),
    ];
    g.saving = g.saving
      .then(() =>
        this.db.query(
          `insert into games(code, tc, rated, status, white, black, creator, creator_colour, moves, clock_w, clock_b, winner, reason,
             white_before, white_after, black_before, black_after, started_at, ended_at, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           on conflict (code) do update set status=$4, white=$5, black=$6, moves=$9, clock_w=$10, clock_b=$11, winner=$12, reason=$13,
             white_before=$14, white_after=$15, black_before=$16, black_after=$17, started_at=$18, ended_at=$19`,
          params,
        ),
      )
      .catch((e) => this.log('save failed', g.code, e));
    return g.saving;
  }

  private async fromRow(r: GameRow): Promise<Live> {
    const tc = r.tc as OnlineTc;
    const creator = await this.seatFromId(r.creator, tc);
    const g = this.blank(r.code, tc, r.rated, creator, (r.creator_colour ?? 'random') as Colour | 'random');
    g.createdAt = new Date(r.created_at).getTime();
    g.status = r.status as GameStatus;
    if (r.white) g.seats.w = await this.seatFromId(r.white, tc);
    if (r.black) g.seats.b = await this.seatFromId(r.black, tc);
    if (g.status === 'playing') {
      const game = new KingdomGame({ timeControl: TIME_CONTROLS[tc] ?? null });
      const sans = r.moves ? r.moves.split(' ') : [];
      sans.forEach((s, i) => {
        const ok = game.move(game.turn, s, i);
        if (!ok.ok) throw new Error(`bad saved move ${s}`);
      });
      // Time the server was down is not charged to anyone.
      if (game.timeControl && r.clock_w !== null && r.clock_b !== null) {
        game.clock.w = Number(r.clock_w);
        game.clock.b = Number(r.clock_b);
      }
      game.turnStartedAt = sans.length ? this.now() : null;
      g.game = game;
      g.startedAt = this.now();
      g.awaySince = { w: this.now(), b: this.now() };
    }
    return g;
  }

  async record(r: GameRow): Promise<GameRecord> {
    const tc = r.tc as OnlineTc;
    const seat = async (id: number | null, before: number | null): Promise<SeatInfo | null> => {
      if (!id) return null;
      const u = await this.accounts.user(id);
      return u ? { id: u.id, name: u.name, guest: u.guest, rating: before, provisional: false } : null;
    };
    return {
      code: r.code,
      tc,
      rated: r.rated,
      status: r.status as GameStatus,
      white: await seat(r.white, r.white_before),
      black: await seat(r.black, r.black_before),
      moves: r.moves ? r.moves.split(' ') : [],
      result: r.reason ? { winner: r.winner === 'w' || r.winner === 'b' ? r.winner : null, reason: r.reason } : null,
      ...(r.white_before !== null && r.white_after !== null && r.black_before !== null && r.black_after !== null
        ? { ratingChange: { w: { before: r.white_before, after: r.white_after }, b: { before: r.black_before, after: r.black_after } } }
        : {}),
      endedAt: r.ended_at ? new Date(r.ended_at).getTime() : null,
    };
  }
}

export interface GameRow {
  code: string;
  tc: string;
  rated: boolean;
  status: string;
  white: number | null;
  black: number | null;
  creator: number;
  creator_colour: string | null;
  moves: string;
  clock_w: string | number | null;
  clock_b: string | number | null;
  winner: string | null;
  reason: string | null;
  white_before: number | null;
  white_after: number | null;
  black_before: number | null;
  black_after: number | null;
  created_at: string | Date;
  started_at: string | Date | null;
  ended_at: string | Date | null;
}
