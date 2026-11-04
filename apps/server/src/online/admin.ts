/**
 * Safety and administration.
 *
 * Players can report someone (cheating, abuse, an offensive name, stalling).
 * Admins (the names in ADMIN_NAMES) see reports, fair-play flags, figures
 * and users; they can suspend or lift a suspension, rename someone, remove
 * a picture or bio, close a cluster, and send an announcement. Every admin
 * action goes in the audit log.
 *
 * Fair-play checks run after every finished game and raise flags for a
 * human to look at; nothing is punished automatically.
 */
import type { Colour } from '@cr/chess-core';
import { AuthError, checkName, type Accounts, type UserRow } from './accounts';
import type { Db } from './db';
import type { Notifier } from './social';

export const REPORT_REASONS = ['cheating', 'abuse', 'name', 'stalling', 'other'] as const;

export class Admin {
  /** Signs a user out everywhere at once (set by the hub). */
  kick: (userId: number) => void = () => {};
  /** Sends a message to everyone online (set by the hub). */
  broadcast: (text: string) => number = () => 0;
  /** Live figures from the hub. */
  liveStats: () => { online: number; games: number; clashes: number } = () => ({ online: 0, games: 0, clashes: 0 });
  /** The game clock (the hub's), so checks line up with when games were saved. */
  now: () => number = Date.now;

  constructor(
    private db: Db,
    private accounts: Accounts,
    private notifier: Notifier,
  ) {}

  requireAdmin(u: UserRow | null): UserRow {
    if (!u) throw new AuthError('Please sign in.', 401);
    if (!u.is_admin) throw new AuthError('Admins only.', 403);
    return u;
  }

  private async audit(admin: UserRow, action: string, details: Record<string, unknown>) {
    await this.db.query('insert into audit(admin, action, details) values ($1, $2, $3)', [admin.id, action, JSON.stringify(details)]);
  }

  /* ---------- reports ---------- */

  async report(me: UserRow, body: Record<string, unknown>) {
    const target = typeof body.name === 'string' ? await this.accounts.byName(body.name) : null;
    if (!target) throw new AuthError('No player with that name.', 404);
    if (target.id === me.id) throw new AuthError('You can’t report yourself.');
    const reason = String(body.reason);
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) throw new AuthError('Choose a reason.');
    const recent = await this.db.query<{ n: string }>("select count(*) as n from reports where reporter = $1 and created_at > now() - interval '1 day'", [me.id]);
    if (Number(recent[0]!.n) >= 10) throw new AuthError('You’ve sent a lot of reports today. Our admins will look at them.', 429);
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 500) : '';
    const game = typeof body.game === 'string' ? body.game.slice(0, 12) : null;
    await this.db.query('insert into reports(reporter, target, game_code, reason, details) values ($1, $2, $3, $4, $5)', [me.id, target.id, game, reason, details]);
  }

  async reports(status: 'open' | 'resolved' = 'open') {
    return this.db.query(
      `select r.id, r.reason, r.details, r.game_code as game, r.status, r.resolution, r.created_at as at,
              t.name as target, t.id as "targetId", p.name as reporter, a.name as "resolvedBy",
              (select count(*) from reports x where x.target = r.target) as "timesReported"
       from reports r join users t on t.id = r.target left join users p on p.id = r.reporter left join users a on a.id = r.resolved_by
       where r.status = $1 order by r.id desc limit 100`,
      [status],
    );
  }

  async resolve(admin: UserRow, id: number, resolution: unknown) {
    const text = typeof resolution === 'string' && resolution.trim() ? resolution.trim().slice(0, 200) : 'Reviewed';
    await this.db.query("update reports set status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [id, text, admin.id]);
    await this.audit(admin, 'resolve-report', { id, resolution: text });
  }

  /* ---------- suspensions and edits ---------- */

  async ban(admin: UserRow, userId: number, days: unknown, reason: unknown) {
    const u = await this.accounts.user(userId);
    if (!u) throw new AuthError('No such player.', 404);
    if (u.is_admin) throw new AuthError('Admins can’t be suspended here.');
    const d = Number(days);
    if (!(d > 0 && d <= 36500)) throw new AuthError('Suspend for 1 to 36500 days (36500 is permanent).');
    const why = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    await this.db.query(`update users set banned_until = now() + ($2::int * interval '1 day'), ban_reason = $3 where id = $1`, [userId, Math.round(d), why || null]);
    await this.db.query('delete from sessions where user_id = $1', [userId]);
    this.kick(userId);
    await this.audit(admin, 'ban', { user: u.name, days: d, reason: why });
  }

  async unban(admin: UserRow, userId: number) {
    const u = await this.accounts.user(userId);
    if (!u) throw new AuthError('No such player.', 404);
    await this.db.query('update users set banned_until = null, ban_reason = null where id = $1', [userId]);
    await this.audit(admin, 'unban', { user: u.name });
  }

  async rename(admin: UserRow, userId: number, name: unknown) {
    const u = await this.accounts.user(userId);
    if (!u) throw new AuthError('No such player.', 404);
    const n = checkName(name);
    if ((await this.db.query('select id from users where name_key = $1', [n.toLowerCase()])).length) throw new AuthError('That name is taken.', 409);
    await this.db.query('update users set name = $2, name_key = $3 where id = $1', [userId, n, n.toLowerCase()]);
    await this.notifier.notify(userId, 'account', `An admin changed your name to ${n}. Sign in with the new name from now on.`);
    await this.audit(admin, 'rename', { from: u.name, to: n });
  }

  async clearProfile(admin: UserRow, userId: number) {
    const u = await this.accounts.user(userId);
    if (!u) throw new AuthError('No such player.', 404);
    await this.db.query("update users set avatar = null, avatar_ver = 0, bio = '' where id = $1", [userId]);
    await this.notifier.notify(userId, 'account', 'An admin removed your profile picture and bio because they broke the rules.');
    await this.audit(admin, 'clear-profile', { user: u.name });
  }

  async closeCluster(admin: UserRow, name: unknown) {
    if (typeof name !== 'string') throw new AuthError('Which cluster?');
    const c = (await this.db.query<{ id: number; name: string }>('select id, name from clusters where name_key = $1', [name.toLowerCase()]))[0];
    if (!c) throw new AuthError('No cluster with that name.', 404);
    const members = await this.db.query<{ user_id: number }>("select user_id from cluster_members where cluster_id = $1 and status <> 'pending'", [c.id]);
    await this.db.query('delete from clusters where id = $1', [c.id]);
    for (const m of members) await this.notifier.notify(m.user_id, 'cluster', `The cluster ${c.name} was closed by an admin.`);
    await this.audit(admin, 'close-cluster', { cluster: c.name });
  }

  async announce(admin: UserRow, text: unknown) {
    if (typeof text !== 'string' || !text.trim()) throw new AuthError('Write the announcement.');
    const t = text.trim().slice(0, 300);
    const reached = this.broadcast(t);
    await this.audit(admin, 'announce', { text: t, reached });
    return reached;
  }

  /* ---------- looking things up ---------- */

  async stats() {
    const one = async (sql: string) => Number((await this.db.query<{ n: string | number }>(sql))[0]!.n);
    return {
      ...this.liveStats(),
      players: await one('select count(*) as n from users where guest = false and deleted = false'),
      guests: await one('select count(*) as n from users where guest = true'),
      newToday: await one("select count(*) as n from users where created_at > now() - interval '1 day' and deleted = false"),
      gamesToday: await one("select count(*) as n from games where status = 'over' and ended_at > now() - interval '1 day'"),
      gamesTotal: await one("select count(*) as n from games where status = 'over'"),
      clusters: await one('select count(*) as n from clusters'),
      tournaments: await one("select count(*) as n from tournaments where status in ('open','running')"),
      openReports: await one("select count(*) as n from reports where status = 'open'"),
      openFlags: await one('select count(*) as n from flags where reviewed = false'),
      suspended: await one('select count(*) as n from users where banned_until > now()'),
    };
  }

  async users(q: string | null) {
    const rows = await this.db.query<{ id: number }>(
      q
        ? "select id from users where deleted = false and (name_key like $1 or email_key like $1) order by created_at desc limit 50"
        : 'select id from users where deleted = false order by created_at desc limit 50',
      q ? [`%${q.toLowerCase().replace(/[%_]/g, '')}%`] : [],
    );
    return Promise.all(rows.map((r) => this.user(r.id)));
  }

  async user(id: number) {
    const u = await this.accounts.user(id);
    if (!u) throw new AuthError('No such player.', 404);
    const reports = await this.db.query<{ n: string }>('select count(*) as n from reports where target = $1', [id]);
    const flags = await this.db.query<{ kind: string; details: string; created_at: string }>('select kind, details, created_at from flags where user_id = $1 order by id desc limit 10', [id]);
    return {
      ...(await this.accounts.publicUser(id))!,
      email: u.email,
      bannedUntil: u.banned_until ? new Date(u.banned_until).getTime() : null,
      banReason: u.ban_reason,
      reported: Number(reports[0]!.n),
      flags,
    };
  }

  async flags() {
    return this.db.query(
      `select f.id, f.kind, f.details, f.created_at as at, u.name, u.id as "userId" from flags f join users u on u.id = f.user_id
       where f.reviewed = false order by f.id desc limit 100`,
    );
  }

  async reviewFlag(admin: UserRow, id: number) {
    await this.db.query('update flags set reviewed = true where id = $1', [id]);
    await this.audit(admin, 'review-flag', { id });
  }

  async auditLog() {
    return this.db.query('select a.id, u.name as admin, a.action, a.details, a.created_at as at from audit a left join users u on u.id = a.admin order by a.id desc limit 100');
  }

  /* ---------- fair play ---------- */

  private async flag(userId: number, kind: string, details: string) {
    // One open flag of a kind per player is enough.
    const open = await this.db.query('select 1 from flags where user_id = $1 and kind = $2 and reviewed = false', [userId, kind]);
    if (!open.length) await this.db.query('insert into flags(user_id, kind, details) values ($1, $2, $3)', [userId, kind, details]);
  }

  /**
   * Looks for patterns worth a human look after a game ends:
   *  - win trading: the same two players, four or more rated games in a day,
   *    one side winning them all quickly;
   *  - leaving games: three or more losses by walking away in the last ten;
   *  - sudden rating climbs: 300 points or more in a day.
   */
  async checkGame(white: number, black: number, rated: boolean, winner: Colour | null) {
    if (rated && winner) {
      const rows = await this.db.query<{ winner: string; white: number; moves: string }>(
        `select winner, white, moves from games where status = 'over' and rated = true and ended_at > $3
         and ((white = $1 and black = $2) or (white = $2 and black = $1))`,
        [white, black, new Date(this.now() - 86_400_000)],
      );
      if (rows.length >= 4) {
        const winners = new Set(rows.map((r) => (r.winner === 'w' ? r.white : r.winner === 'b' ? (r.white === white ? black : white) : 0)));
        const quick = rows.every((r) => (r.moves ? r.moves.split(' ').length : 0) < 20);
        if (winners.size === 1 && !winners.has(0) && quick) {
          const w = [...winners][0]!;
          const names = `${(await this.accounts.user(white))?.name} and ${(await this.accounts.user(black))?.name}`;
          await this.flag(w, 'win-trading', `${rows.length} quick rated wins in a day against the same player (${names}).`);
          await this.flag(w === white ? black : white, 'win-trading', `${rows.length} quick rated losses in a day to the same player (${names}).`);
        }
      }
    }
    for (const id of [white, black]) {
      const last = await this.db.query<{ winner: string; reason: string; white: number }>(
        "select winner, reason, white from games where status = 'over' and (white = $1 or black = $1) order by ended_at desc limit 10",
        [id],
      );
      const walked = last.filter((g) => g.reason === 'abandoned' && g.winner !== (g.white === id ? 'w' : 'b')).length;
      if (walked >= 3) await this.flag(id, 'leaving-games', `Left ${walked} of their last ${last.length} games.`);
      const climb = await this.db.query<{ gain: string | null }>(
        `select sum(case when white = $1 then white_after - white_before else black_after - black_before end) as gain
         from games where status = 'over' and rated = true and (white = $1 or black = $1) and ended_at > $2`,
        [id, new Date(this.now() - 86_400_000)],
      );
      const gain = Number(climb[0]?.gain ?? 0);
      if (gain >= 300) await this.flag(id, 'rating-climb', `Gained ${gain} rating points in a day.`);
    }
  }
}
