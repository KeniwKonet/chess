/**
 * Tournaments: Swiss and knockout, played as ordinary refereed online games.
 *
 * Swiss: everyone plays every round; each round pairs players with the same
 * score (or as close as possible) who haven't met, balancing colours. An odd
 * player out gets a bye worth a point (never twice). Standings break ties
 * with Buchholz (opponents' scores) and Sonneborn-Berger.
 *
 * Knockout: seeded by rating into a bracket (top seeds get byes when the
 * numbers aren't a power of two). A drawn game is replayed with colours
 * reversed; if the replay is drawn too, Black in the replay goes through.
 *
 * Each round's games start at once: players who are online are taken
 * straight to the board, and everyone gets a notification. Someone who
 * doesn't make their first move in time loses that game by forfeit.
 */
import { randomInt } from 'node:crypto';
import {
  ONLINE_TIME_CONTROLS,
  ratingCategory,
  type OnlineTc,
  type StandingRow,
  type TournamentDetail,
  type TournamentGame,
  type TournamentKind,
  type TournamentStatus,
  type TournamentSummary,
} from '@cr/chess-core';
import { AuthError, isBanned, type Accounts, type UserRow } from './accounts';
import type { Db } from './db';
import type { Notifier } from './social';

/** What the tournament needs from the game hub. */
export interface GameHost {
  /** Starts a game between two players, taking them to it if they are online. Returns its code. */
  arrange(whiteId: number, blackId: number, tc: OnlineTc, rated: boolean, tournament: string): Promise<string>;
}

export interface GameEnd {
  code: string;
  winner: 'w' | 'b' | null;
  status: 'over' | 'aborted';
  reason: string;
  /** For a game called off because someone never moved: who that was. */
  noShow?: 'w' | 'b';
}

interface TRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  kind: TournamentKind;
  tc: OnlineTc;
  rated: boolean;
  rounds: number;
  max_players: number;
  starts_at: string | Date | null;
  status: TournamentStatus;
  current_round: number;
  created_by: number | null;
  featured: boolean;
  winner: number | null;
}

interface PRow {
  user_id: number;
  name: string;
  rating: number;
  seed: number | null;
  score: number;
  byes: number;
  withdrawn: boolean;
  eliminated: boolean;
}

interface GRow {
  id: number;
  round: number;
  board: number;
  replay: number;
  white: number | null;
  black: number | null;
  game_code: string | null;
  result: string | null;
  reason: string | null;
}

const ROUND_BREAK_MS = 15_000;

const slugify = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'tournament'}-${randomInt(1000, 10000)}`;

export class Tournaments {
  host: GameHost | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private ticker: NodeJS.Timeout | null = null;
  private busy = new Map<number, Promise<unknown>>();

  constructor(
    private db: Db,
    private accounts: Accounts,
    private notifier: Notifier,
    private opts: { timers: boolean; log: (...a: unknown[]) => void; breakMs?: number },
  ) {
    if (opts.timers) this.ticker = setInterval(() => void this.startDue(), 15_000);
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    if (this.ticker) clearInterval(this.ticker);
  }

  /** One change at a time per tournament. */
  private serial<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.busy.set(id, next.catch(() => {}));
    return next;
  }

  private async row(slug: string): Promise<TRow> {
    const r = (await this.db.query<TRow>('select * from tournaments where slug = $1', [slug]))[0];
    if (!r) throw new AuthError('No tournament with that link.', 404);
    return r;
  }

  private async players(id: number): Promise<PRow[]> {
    return this.db.query<PRow>(
      `select p.user_id, u.name, p.rating, p.seed, p.score, p.byes, p.withdrawn, p.eliminated
       from tournament_players p join users u on u.id = p.user_id where p.tournament_id = $1 order by p.seed nulls last, p.rating desc, p.joined_at`,
      [id],
    );
  }

  private async games(id: number): Promise<GRow[]> {
    return this.db.query<GRow>('select id, round, board, replay, white, black, game_code, result, reason from tournament_games where tournament_id = $1 order by round, board, replay', [id]);
  }

  private async summary(t: TRow): Promise<TournamentSummary> {
    const n = await this.db.query<{ n: string }>('select count(*) as n from tournament_players where tournament_id = $1', [t.id]);
    const creator = t.created_by ? await this.accounts.user(t.created_by) : null;
    const winner = t.winner ? await this.accounts.user(t.winner) : null;
    return {
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      tc: t.tc,
      rated: t.rated,
      status: t.status,
      players: Number(n[0]!.n),
      maxPlayers: t.max_players,
      rounds: t.rounds,
      currentRound: t.current_round,
      startsAt: t.starts_at ? new Date(t.starts_at).getTime() : null,
      createdBy: creator?.name ?? null,
      featured: t.featured,
      winner: winner?.name ?? null,
    };
  }

  async list() {
    const rows = await this.db.query<TRow>(
      `select * from tournaments where status in ('open','running')
         or (status = 'finished' and ended_at > now() - interval '14 days')
       order by featured desc, case status when 'running' then 0 when 'open' then 1 else 2 end, starts_at nulls last, id desc limit 60`,
    );
    return Promise.all(rows.map((r) => this.summary(r)));
  }

  /* ---------- creating and entering ---------- */

  async create(me: UserRow, body: Record<string, unknown>): Promise<TournamentDetail> {
    if (me.guest) throw new AuthError('Tournaments are made from a free account.', 403);
    const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
    if (name.length < 3 || name.length > 60) throw new AuthError('Give the tournament a name (3 to 60 characters).');
    const kind = body.kind === 'knockout' ? 'knockout' : 'swiss';
    const tc = body.tc as OnlineTc;
    if (!(ONLINE_TIME_CONTROLS as readonly string[]).includes(tc) || tc === 'untimed') throw new AuthError('Choose a clock; tournaments are always timed.');
    const rated = body.rated !== false && !!ratingCategory(tc);
    const maxPlayers = Math.min(256, Math.max(2, Math.round(Number(body.maxPlayers) || 32)));
    const rounds = kind === 'swiss' ? Math.min(11, Math.max(1, Math.round(Number(body.rounds) || 5))) : 0;
    let startsAt: Date | null = null;
    if (body.startsAt) {
      startsAt = new Date(String(body.startsAt));
      const ahead = startsAt.getTime() - Date.now();
      if (Number.isNaN(ahead) || ahead < 60_000 || ahead > 60 * 86_400_000) throw new AuthError('Start it between a minute and 60 days from now, or leave the time empty to start it yourself.');
    }
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
    const mine = await this.db.query<{ n: string }>("select count(*) as n from tournaments where created_by = $1 and status in ('open','running')", [me.id]);
    if (Number(mine[0]!.n) >= 3 && !me.is_admin) throw new AuthError('You already run three tournaments. Finish one first.', 429);
    const slug = slugify(name);
    await this.db.query(
      `insert into tournaments(slug, name, description, kind, tc, rated, rounds, max_players, starts_at, created_by, featured)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [slug, name, description, kind, tc, rated, rounds, maxPlayers, startsAt, me.id, !!(me.is_admin && body.featured)],
    );
    return this.detail(slug, me);
  }

  async join(me: UserRow, slug: string) {
    const t = await this.row(slug);
    return this.serial(t.id, async () => {
      const fresh = await this.row(slug);
      if (fresh.status !== 'open') throw new AuthError('Entries are closed.', 409);
      if (isBanned(me)) throw new AuthError('Suspended accounts can’t enter.', 403);
      if (fresh.rated && me.guest) throw new AuthError('This is a rated tournament. Make a free account to enter (your guest games are kept).', 403);
      const n = await this.db.query<{ n: string }>('select count(*) as n from tournament_players where tournament_id = $1', [t.id]);
      if (Number(n[0]!.n) >= fresh.max_players) throw new AuthError('The tournament is full.', 409);
      const cat = ratingCategory(fresh.tc)!;
      const r = await this.accounts.glicko(me.id, cat);
      await this.db.query('insert into tournament_players(tournament_id, user_id, rating) values ($1, $2, $3) on conflict do nothing', [t.id, me.id, Math.round(r.rating)]);
      return this.detail(slug, me);
    });
  }

  async leave(me: UserRow, slug: string) {
    const t = await this.row(slug);
    return this.serial(t.id, async () => {
      const fresh = await this.row(slug);
      if (fresh.status === 'open') await this.db.query('delete from tournament_players where tournament_id = $1 and user_id = $2', [t.id, me.id]);
      else if (fresh.status === 'running') await this.db.query('update tournament_players set withdrawn = true where tournament_id = $1 and user_id = $2', [t.id, me.id]);
      return this.detail(slug, me);
    });
  }

  async cancel(me: UserRow, slug: string) {
    const t = await this.row(slug);
    if (t.created_by !== me.id && !me.is_admin) throw new AuthError('Only whoever made the tournament (or an admin) can cancel it.', 403);
    if (t.status === 'finished' || t.status === 'cancelled') return this.detail(slug, me);
    await this.db.query("update tournaments set status = 'cancelled', ended_at = now() where id = $1", [t.id]);
    for (const p of await this.players(t.id)) await this.notifier.notify(p.user_id, 'tournament', `${t.name} was cancelled.`, { tournament: t.slug });
    return this.detail(slug, me);
  }

  async feature(me: UserRow, slug: string, on: boolean) {
    if (!me.is_admin) throw new AuthError('Admins only.', 403);
    await this.db.query('update tournaments set featured = $2 where slug = $1', [slug, on]);
    return this.detail(slug, me);
  }

  /** Start now (the creator or an admin), or when the start time comes. */
  async start(me: UserRow | null, slug: string) {
    const t = await this.row(slug);
    if (me && t.created_by !== me.id && !me.is_admin) throw new AuthError('Only whoever made the tournament (or an admin) can start it.', 403);
    await this.serial(t.id, async () => {
      const fresh = await this.row(slug);
      if (fresh.status !== 'open') return;
      const ps = (await this.players(t.id)).sort((a, b) => b.rating - a.rating);
      if (ps.length < 2) {
        if (me) throw new AuthError('At least two players are needed to start.', 409);
        await this.db.query("update tournaments set status = 'cancelled', ended_at = now() where id = $1", [t.id]);
        for (const p of ps) await this.notifier.notify(p.user_id, 'tournament', `${t.name} was called off: not enough players entered.`, { tournament: t.slug });
        return;
      }
      for (let i = 0; i < ps.length; i++) await this.db.query('update tournament_players set seed = $3 where tournament_id = $1 and user_id = $2', [t.id, ps[i]!.user_id, i + 1]);
      const rounds = fresh.kind === 'knockout' ? Math.ceil(Math.log2(ps.length)) : Math.min(fresh.rounds, Math.max(1, ps.length - 1));
      await this.db.query("update tournaments set status = 'running', rounds = $2, starts_at = coalesce(starts_at, now()) where id = $1", [t.id, rounds]);
      for (const p of ps) await this.notifier.notify(p.user_id, 'tournament', `${t.name} has started. Your first game is being set up.`, { tournament: t.slug });
      await this.nextRound(t.id);
    });
    return this.detail(slug, me);
  }

  private async startDue() {
    const due = await this.db.query<{ slug: string }>("select slug from tournaments where status = 'open' and starts_at is not null and starts_at <= now()");
    for (const d of due) await this.start(null, d.slug).catch((e) => this.opts.log('tournament start failed', d.slug, e));
  }

  /** After a restart: carry on tournaments whose round finished while the server was down. */
  async restore() {
    const running = await this.db.query<{ id: number }>("select id from tournaments where status = 'running'");
    for (const r of running) await this.serial(r.id, () => this.maybeAdvance(r.id)).catch((e) => this.opts.log('tournament restore failed', r.id, e));
  }

  /* ---------- rounds ---------- */

  private async nextRound(id: number) {
    const t = (await this.db.query<TRow>('select * from tournaments where id = $1', [id]))[0]!;
    const round = t.current_round + 1;
    const ps = await this.players(id);
    const all = await this.games(id);
    const pairs = t.kind === 'swiss' ? this.swissPairs(ps, all) : this.knockoutPairs(ps, all, round);
    await this.db.query('update tournaments set current_round = $2 where id = $1', [id, round]);
    let board = 0;
    for (const p of pairs) {
      board++;
      if (p.black === null) {
        // A bye: a point in a Swiss, straight through in a knockout.
        await this.db.query("insert into tournament_games(tournament_id, round, board, white, result, reason) values ($1,$2,$3,$4,'bye','bye')", [id, round, board, p.white]);
        if (t.kind === 'swiss') await this.db.query('update tournament_players set score = score + 1, byes = byes + 1 where tournament_id = $1 and user_id = $2', [id, p.white]);
        await this.notifier.notify(p.white, 'tournament', `${t.name}, round ${round}: you have a bye${t.kind === 'swiss' ? ' (a free point)' : ' into the next round'}.`, { tournament: t.slug });
        continue;
      }
      await this.startGame(t, round, board, 0, p.white, p.black);
    }
    await this.maybeAdvance(id);
  }

  private async startGame(t: TRow, round: number, board: number, replay: number, white: number, black: number) {
    const rows = await this.db.query<{ id: number }>(
      'insert into tournament_games(tournament_id, round, board, replay, white, black) values ($1,$2,$3,$4,$5,$6) returning id',
      [t.id, round, board, replay, white, black],
    );
    const code = this.host ? await this.host.arrange(white, black, t.tc, t.rated, t.slug) : null;
    await this.db.query('update tournament_games set game_code = $2 where id = $1', [rows[0]!.id, code]);
    const [wn, bn] = [(await this.accounts.user(white))?.name, (await this.accounts.user(black))?.name];
    const label = replay ? `replay ${replay}` : `round ${round}`;
    await this.notifier.notify(white, 'tournament', `${t.name}, ${label}: you have the Sun against ${bn}. Your game has started.`, { tournament: t.slug, code });
    await this.notifier.notify(black, 'tournament', `${t.name}, ${label}: you have the Moon against ${wn}. Your game has started.`, { tournament: t.slug, code });
  }

  /** Called by the hub whenever a game ends. */
  async gameEnded(e: GameEnd) {
    const g = (await this.db.query<GRow & { tournament_id: number }>('select *, tournament_id from tournament_games where game_code = $1', [e.code]))[0];
    if (!g || g.result) return;
    await this.serial(g.tournament_id, async () => {
      const t = (await this.db.query<TRow>('select * from tournaments where id = $1', [g.tournament_id]))[0]!;
      if (t.status !== 'running') return;
      // A no-show loses by forfeit; otherwise the board's result stands.
      let winner = e.winner;
      let reason = e.reason;
      if (e.status === 'aborted') {
        winner = e.noShow ? (e.noShow === 'w' ? 'b' : 'w') : null;
        reason = e.noShow ? 'forfeit' : 'aborted';
      }
      const result = winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2';
      await this.db.query('update tournament_games set result = $2, reason = $3 where id = $1', [g.id, result, reason]);
      if (t.kind === 'swiss') {
        const add = async (uid: number | null, pts: number) => uid && pts && this.db.query('update tournament_players set score = score + $3 where tournament_id = $1 and user_id = $2', [t.id, uid, pts]);
        await add(g.white, winner === 'w' ? 1 : winner === null ? 0.5 : 0);
        await add(g.black, winner === 'b' ? 1 : winner === null ? 0.5 : 0);
      } else if (winner) {
        const loser = winner === 'w' ? g.black : g.white;
        await this.db.query('update tournament_players set eliminated = true where tournament_id = $1 and user_id = $2', [t.id, loser]);
      } else if (g.replay < 1) {
        // Drawn knockout game: play again with colours reversed.
        await this.startGame(t, g.round, g.board, g.replay + 1, g.black!, g.white!);
        return;
      } else {
        // The replay was drawn too: Black in the replay goes through.
        await this.db.query("update tournament_games set reason = 'drawn twice: Black goes through' where id = $1", [g.id]);
        await this.db.query('update tournament_players set eliminated = true where tournament_id = $1 and user_id = $2', [t.id, g.white]);
      }
      await this.maybeAdvance(t.id);
    });
  }

  /** When every game of the round is done: finish, or start the next round after a short break. */
  private async maybeAdvance(id: number) {
    const t = (await this.db.query<TRow>('select * from tournaments where id = $1', [id]))[0]!;
    if (t.status !== 'running' || t.current_round === 0) return;
    const round = (await this.games(id)).filter((g) => g.round === t.current_round);
    if (round.some((g) => !g.result)) return;
    const ps = await this.players(id);
    const alive = ps.filter((p) => !p.eliminated && !p.withdrawn);
    const done = t.kind === 'knockout' ? alive.length <= 1 || t.current_round >= t.rounds : t.current_round >= t.rounds;
    if (done) return this.finish(t);
    const go = () => void this.serial(id, () => this.nextRound(id)).catch((e) => this.opts.log('next round failed', id, e));
    const wait = this.opts.breakMs ?? ROUND_BREAK_MS;
    if (!this.opts.timers || wait <= 0) return this.nextRound(id);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      go();
    }, wait);
    this.timers.add(timer);
  }

  private async finish(t: TRow) {
    const standings = await this.standings(t, await this.players(t.id), await this.games(t.id));
    const champion = standings[0];
    await this.db.query("update tournaments set status = 'finished', ended_at = now(), winner = $2 where id = $1", [t.id, champion?.id ?? null]);
    for (const s of standings)
      await this.notifier.notify(
        s.id,
        'tournament',
        s.rank === 1 ? `🏆 You won ${t.name}!` : `${t.name} is over. ${champion?.name} won; you finished ${ordinal(s.rank)}.`,
        { tournament: t.slug },
      );
  }

  /* ---------- pairing ---------- */

  /** Swiss pairings: by score then rating, no rematches if possible, colours balanced. */
  swissPairs(ps: PRow[], games: GRow[]): { white: number; black: number | null }[] {
    const active = ps.filter((p) => !p.withdrawn).sort((a, b) => b.score - a.score || b.rating - a.rating);
    const met = new Set<string>();
    const colour = new Map<number, { balance: number; last: 'w' | 'b' | null }>();
    for (const p of active) colour.set(p.user_id, { balance: 0, last: null });
    for (const g of games) {
      if (g.white && g.black) {
        met.add(`${g.white}:${g.black}`);
        met.add(`${g.black}:${g.white}`);
      }
      const cw = g.white !== null ? colour.get(g.white) : undefined;
      const cb = g.black !== null ? colour.get(g.black) : undefined;
      if (cw && g.black) {
        cw.balance++;
        cw.last = 'w';
      }
      if (cb) {
        cb.balance--;
        cb.last = 'b';
      }
    }
    const out: { white: number; black: number | null }[] = [];
    let pool = [...active];
    if (pool.length % 2 === 1) {
      // The lowest-placed player who hasn't had a bye sits out with a point.
      const bye = [...pool].reverse().find((p) => p.byes === 0) ?? pool[pool.length - 1]!;
      pool = pool.filter((p) => p !== bye);
      out.push({ white: bye.user_id, black: null });
    }
    const ids = pool.map((p) => p.user_id);
    const pair = (rest: number[], allowRematch: boolean): [number, number][] | null => {
      if (!rest.length) return [];
      const [a, ...others] = rest;
      for (let i = 0; i < others.length; i++) {
        const b = others[i]!;
        if (!allowRematch && met.has(`${a}:${b}`)) continue;
        const sub = pair([...others.slice(0, i), ...others.slice(i + 1)], allowRematch);
        if (sub) return [[a!, b], ...sub];
      }
      return null;
    };
    const pairs = pair(ids, false) ?? pair(ids, true) ?? [];
    for (const [a, b] of pairs) {
      const ca = colour.get(a)!;
      const cb = colour.get(b)!;
      // Whoever has had White less often takes it; on a tie, the higher-placed player alternates from last time.
      const aWhite = ca.balance !== cb.balance ? ca.balance < cb.balance : ca.last !== 'w';
      out.push(aWhite ? { white: a, black: b } : { white: b, black: a });
    }
    // Top boards first, byes last.
    return [...out.filter((p) => p.black !== null), ...out.filter((p) => p.black === null)];
  }

  /** Knockout pairings: a seeded bracket in round 1, then winners of neighbouring boards. */
  knockoutPairs(ps: PRow[], games: GRow[], round: number): { white: number; black: number | null }[] {
    if (round === 1) {
      const seeded = [...ps].sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999));
      const size = 2 ** Math.ceil(Math.log2(Math.max(2, seeded.length)));
      const order = bracketOrder(size);
      const out: { white: number; black: number | null }[] = [];
      for (let i = 0; i < order.length; i += 2) {
        const a = seeded[order[i]! - 1];
        const b = seeded[order[i + 1]! - 1];
        if (a && b) out.push(i % 4 === 0 ? { white: a.user_id, black: b.user_id } : { white: b.user_id, black: a.user_id });
        else if (a || b) out.push({ white: (a ?? b)!.user_id, black: null });
      }
      return out;
    }
    // Winners of the previous round, board by board.
    const prev = games.filter((g) => g.round === round - 1);
    const boards = [...new Set(prev.map((g) => g.board))].sort((a, b) => a - b);
    const winners: number[] = [];
    for (const b of boards) {
      const last = prev.filter((g) => g.board === b).sort((x, y) => y.replay - x.replay)[0]!;
      const w = last.result === 'bye' ? last.white : last.result === '1-0' ? last.white : last.result === '0-1' ? last.black : last.black;
      const withdrawn = ps.find((p) => p.user_id === w)?.withdrawn;
      if (w && !withdrawn) winners.push(w);
    }
    const out: { white: number; black: number | null }[] = [];
    for (let i = 0; i < winners.length; i += 2) {
      const a = winners[i]!;
      const b = winners[i + 1];
      out.push(b === undefined ? { white: a, black: null } : i % 4 === 0 ? { white: a, black: b } : { white: b, black: a });
    }
    return out;
  }

  /* ---------- reading ---------- */

  private async standings(t: TRow, ps: PRow[], games: GRow[]): Promise<StandingRow[]> {
    const score = new Map(ps.map((p) => [p.user_id, p.score]));
    const rows = ps.map((p) => {
      let buchholz = 0;
      let sb = 0;
      let wins = 0;
      let played = 0;
      for (const g of games) {
        if (!g.result || g.result === 'bye') continue;
        const side = g.white === p.user_id ? 'w' : g.black === p.user_id ? 'b' : null;
        if (!side) continue;
        const opp = side === 'w' ? g.black! : g.white!;
        const os = score.get(opp) ?? 0;
        played++;
        buchholz += os;
        const mine = g.result === '1/2' ? 0.5 : (g.result === '1-0') === (side === 'w') ? 1 : 0;
        if (mine === 1) wins++;
        sb += mine * os;
      }
      return { id: p.user_id, name: p.name, rating: p.rating, score: p.score, buchholz, sb, wins, played, withdrawn: p.withdrawn, eliminated: p.eliminated };
    });
    if (t.kind === 'knockout') {
      // Still standing first; then by how far each got.
      const reached = new Map<number, number>();
      for (const g of games) for (const u of [g.white, g.black]) if (u) reached.set(u, Math.max(reached.get(u) ?? 0, g.round));
      rows.sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || (reached.get(b.id) ?? 0) - (reached.get(a.id) ?? 0) || b.wins - a.wins || b.rating - a.rating);
    } else rows.sort((a, b) => b.score - a.score || b.buchholz - a.buchholz || b.sb - a.sb || b.wins - a.wins || b.rating - a.rating);
    return rows.map((r, i) => ({ rank: i + 1, ...r }));
  }

  async detail(slug: string, me: UserRow | null): Promise<TournamentDetail> {
    const t = await this.row(slug);
    const ps = await this.players(t.id);
    const games = await this.games(t.id);
    const names = new Map(ps.map((p) => [p.user_id, p.name]));
    const who = (id: number | null) => (id ? { id, name: names.get(id) ?? 'deleted player' } : null);
    const rounds: TournamentDetail['schedule'] = [];
    for (const g of games) {
      let r = rounds.find((x) => x.round === g.round);
      if (!r) rounds.push((r = { round: g.round, games: [] }));
      const tg: TournamentGame = { board: g.board, replay: g.replay, white: who(g.white), black: who(g.black), result: g.result, reason: g.reason, code: g.game_code };
      r.games.push(tg);
    }
    const myGame = me ? games.find((g) => !g.result && g.game_code && (g.white === me.id || g.black === me.id))?.game_code ?? null : null;
    return {
      ...(await this.summary(t)),
      description: t.description,
      standings: await this.standings(t, ps, games),
      schedule: rounds,
      you: me ? { joined: ps.some((p) => p.user_id === me.id), creator: t.created_by === me.id, admin: me.is_admin, game: myGame } : null,
    };
  }
}

/** Seed positions down a bracket of `size`, so seeds 1 and 2 can only meet in the final. */
export function bracketOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap((s) => [s, n - s]);
  }
  return order;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
