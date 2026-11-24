/**
 * Points: earned by playing, online and against the computer. Every change is
 * written to points_log (so points can later be spent, e.g. in the Forge, and
 * any total can be explained). Ratings stay separate: points never change a rating.
 *
 * Online (finished games only):
 *   rated  win 10 · draw 5 · loss 2
 *   casual win 6  · draw 3 · loss 1
 *   Games against the same opponent earn points for the first 5 a day only.
 *
 * Against the computer (accounts only; the server times the game itself):
 *   win  Squire 2 · Knight 4 · Lord 7 · Warlord 12
 *   draw half of a win, rounded up · loss 1 · resigned 0
 *   A game must last at least 30 seconds and 5 moves to earn anything,
 *   one computer game at a time, and at most 60 points a day from the computer.
 */
import type { AiLevel, Colour } from '@cr/chess-core';
import { AuthError } from './accounts';
import type { Db } from './db';

export const ONLINE_POINTS = { rated: { win: 10, draw: 5, loss: 2 }, casual: { win: 6, draw: 3, loss: 1 } } as const;
export const COMPUTER_WIN: Record<AiLevel, number> = { squire: 2, knight: 4, lord: 7, warlord: 12 };
export const COMPUTER_DAILY_CAP = 60;
const PAIR_DAILY = 5;
const MIN_SECONDS = 30;
const MIN_MOVES = 5;
const LEVELS = Object.keys(COMPUTER_WIN) as AiLevel[];

export type ComputerResult = 'win' | 'loss' | 'draw' | 'resigned';

/** A refused request (an error with an HTTP status, shown to the player). */
export class PointsError extends AuthError {}

export class Points {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {}

  async add(userId: number, delta: number, reason: string, details: Record<string, unknown> = {}) {
    if (!delta) return;
    await this.db.query('update users set points = points + $2 where id = $1', [userId, delta]);
    await this.db.query('insert into points_log(user_id, delta, reason, details) values ($1, $2, $3, $4)', [userId, delta, reason, JSON.stringify(details)]);
  }

  /** After a finished online game: points for both players. Returns what each got. */
  async online(g: { code: string; rated: boolean; white: number; black: number; winner: Colour | null }) {
    const table = g.rated ? ONLINE_POINTS.rated : ONLINE_POINTS.casual;
    // Two friends playing each other all day can't farm points.
    const rows = await this.db.query<{ n: string | number }>(
      `select count(*) as n from games where status = 'over' and ended_at > now() - interval '1 day'
         and code <> $3 and ((white = $1 and black = $2) or (white = $2 and black = $1))`,
      [g.white, g.black, g.code],
    );
    if (Number(rows[0]!.n) >= PAIR_DAILY) return { w: 0, b: 0 };
    const got = (c: Colour) => (g.winner == null ? table.draw : g.winner === c ? table.win : table.loss);
    const out = { w: got('w'), b: got('b') };
    const why = g.rated ? 'rated game' : 'casual game';
    await this.add(g.white, out.w, why, { code: g.code });
    await this.add(g.black, out.b, why, { code: g.code });
    return out;
  }

  /** A game against the computer begins. Any unfinished one is dropped. */
  async computerStart(userId: number, level: unknown) {
    if (typeof level !== 'string' || !LEVELS.includes(level as AiLevel)) throw new PointsError('Unknown level.');
    await this.db.query("update computer_games set status = 'dropped' where user_id = $1 and status = 'playing'", [userId]);
    const rows = await this.db.query<{ id: number }>(
      "insert into computer_games(user_id, level, status, started_at) values ($1, $2, 'playing', to_timestamp($3 / 1000.0)) returning id",
      [userId, level, this.now()],
    );
    return { id: Number(rows[0]!.id) };
  }

  /** The game is over: record it and award points. */
  async computerEnd(userId: number, id: unknown, result: unknown, moves: unknown) {
    const r = result as ComputerResult;
    if (!['win', 'loss', 'draw', 'resigned'].includes(r)) throw new PointsError('Unknown result.');
    const m = typeof moves === 'number' && Number.isFinite(moves) ? Math.max(0, Math.min(1000, Math.round(moves))) : 0;
    const rows = await this.db.query<{ id: number; level: AiLevel; started: number }>(
      "select id, level, extract(epoch from started_at) * 1000 as started from computer_games where id = $1 and user_id = $2 and status = 'playing'",
      [Number(id), userId],
    );
    const g = rows[0];
    if (!g) throw new PointsError('That game has already been counted.', 409);
    const seconds = Math.round((this.now() - Number(g.started)) / 1000);
    const win = COMPUTER_WIN[g.level];
    let earned = r === 'win' ? win : r === 'draw' ? Math.ceil(win / 2) : r === 'loss' ? 1 : 0;
    let note: string | null = null;
    if (seconds < MIN_SECONDS || m < MIN_MOVES) {
      earned = 0;
      note = 'Games shorter than 5 moves or 30 seconds don’t earn points.';
    }
    const today = await this.db.query<{ n: string | number | null }>(
      "select coalesce(sum(delta), 0) as n from points_log where user_id = $1 and reason = 'computer game' and at >= date_trunc('day', now())",
      [userId],
    );
    const left = Math.max(0, COMPUTER_DAILY_CAP - Number(today[0]!.n));
    if (earned > left) {
      earned = left;
      note = `That’s the most points from the computer for today (${COMPUTER_DAILY_CAP}). Play online for more!`;
    }
    await this.db.query(
      "update computer_games set status = 'over', result = $2, moves = $3, seconds = $4, points = $5, ended_at = now() where id = $1",
      [g.id, r, m, seconds, earned],
    );
    await this.add(userId, earned, 'computer game', { level: g.level, result: r });
    const total = await this.db.query<{ points: number }>('select points from users where id = $1', [userId]);
    return { points: earned, total: Number(total[0]!.points), level: g.level, note };
  }

  async leaderboard(limit = 50) {
    const rows = await this.db.query<{ name: string; points: number }>(
      `select name, points from users where guest = false and deleted = false and points > 0
        and (banned_until is null or banned_until < now()) order by points desc, id limit $1`,
      [limit],
    );
    return rows.map((r) => ({ name: r.name, points: Number(r.points) }));
  }
}
