/**
 * Analytics for the admin dashboard.
 *
 * Games against the computer and pass-and-play games run entirely in the
 * browser, so the game reports them here (POST /api/track): a visit, a game
 * started, a game finished. Each browser has an anonymous visitor id (random,
 * kept in its storage); nothing personal is sent or kept. Online games, players,
 * tournaments and the community come from the server's own tables.
 *
 * Every five minutes the server also notes how many players are online and how
 * many games are in play, so the dashboard can show peaks.
 */
import type { Db } from './db';

export const KINDS = ['visit', 'game-start', 'game-end'] as const;
export const MODES = ['ai', 'local'] as const;
const LEVELS = ['squire', 'knight', 'lord', 'warlord'];
const RESULTS = ['win', 'loss', 'draw', 'resigned', 'both'];
const DEVICES = ['phone', 'tablet', 'desktop'];
const MAX_BATCH = 20;
const PER_MINUTE = 120; // events per address per minute

export interface TrackEvent {
  kind: string;
  mode?: string;
  level?: string;
  result?: string;
  moves?: number;
  seconds?: number;
  device?: string;
  referrer?: string;
  game?: string;
}

const id = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(s) ? s : null);
const pick = (s: unknown, ok: readonly string[]) => (typeof s === 'string' && ok.includes(s) ? s : null);
const int = (n: unknown, max: number) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null);
const host = (s: unknown) =>
  typeof s === 'string' && /^[a-z0-9.-]{1,80}$/i.test(s) ? s.toLowerCase().replace(/^www\./, '').replace(/^(l|lm|m)\.facebook\.com$/, 'facebook.com') : null;

export class Analytics {
  private budget = new Map<string, { n: number; at: number }>();

  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {}

  /** Stores a batch of events from a browser. Returns how many were kept. */
  async track(addr: string, body: { visitor?: unknown; events?: unknown }): Promise<number> {
    const visitor = id(body.visitor);
    if (!visitor || !Array.isArray(body.events)) return 0;
    const t = this.now();
    const b = this.budget.get(addr);
    const left = b && t - b.at < 60_000 ? b : { n: 0, at: t };
    let kept = 0;
    for (const raw of body.events.slice(0, MAX_BATCH) as TrackEvent[]) {
      if (!raw || typeof raw !== 'object' || left.n >= PER_MINUTE) continue;
      const kind = pick(raw.kind, KINDS);
      if (!kind) continue;
      const mode = pick(raw.mode, MODES);
      if (kind !== 'visit' && !mode) continue;
      left.n++;
      await this.db.query(
        `insert into events(visitor, kind, mode, level, result, moves, seconds, device, referrer, game)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
        [
          visitor,
          kind,
          mode,
          mode === 'ai' ? pick(raw.level, LEVELS) : null,
          kind === 'game-end' ? pick(raw.result, RESULTS) : null,
          int(raw.moves, 2000),
          int(raw.seconds, 86_400),
          kind === 'visit' ? pick(raw.device, DEVICES) : null,
          kind === 'visit' ? host(raw.referrer) : null,
          kind === 'visit' ? null : id(raw.game),
        ],
      );
      kept++;
    }
    this.budget.set(addr, left);
    if (this.budget.size > 5000) for (const [k, v] of this.budget) if (t - v.at > 60_000) this.budget.delete(k);
    return kept;
  }

  /** Notes how busy the server is (every five minutes). */
  async sample(online: number, games: number) {
    await this.db.query('insert into stats_samples(at, online, games) values (now(), $1, $2) on conflict do nothing', [online, games]);
    await this.db.query("delete from stats_samples where at < now() - interval '400 days'");
  }

  /** Everything the dashboard's Analytics tab shows, over the last `days` days. */
  async report(days: number) {
    const d = Math.min(Math.max(Math.round(days) || 30, 1), 365);
    const q = <T>(sql: string, p: unknown[] = []) => this.db.query<T>(sql, p);
    const n = async (sql: string, p: unknown[] = []) => Number((await q<{ n: string | number | null }>(sql, p))[0]?.n ?? 0);
    const since = (days: number) => `now() - interval '${days} days'`;
    const today = "date_trunc('day', now())";
    const R = since(d);

    /* ---------- visitors ---------- */
    const visitors = {
      today: await n(`select count(distinct visitor) as n from events where at >= ${today}`),
      week: await n(`select count(distinct visitor) as n from events where at >= ${since(7)}`),
      month: await n(`select count(distinct visitor) as n from events where at >= ${since(30)}`),
      range: await n(`select count(distinct visitor) as n from events where at >= ${R}`),
      ever: await n('select count(distinct visitor) as n from events'),
      visits: await n(`select count(*) as n from events where kind = 'visit' and at >= ${R}`),
      // Came back: seen in the range and also on an earlier day.
      returning: await n(
        `select count(*) as n from (select visitor from events where at >= ${R} group by visitor
           having min(at) < date_trunc('day', max(at))) x`,
      ),
      devices: await q<{ device: string; n: number }>(
        `select coalesce(device, 'unknown') as device, count(distinct visitor)::int as n from events
          where kind = 'visit' and at >= ${R} group by 1 order by 2 desc`,
      ),
      referrers: await q<{ referrer: string; n: number }>(
        `select referrer, count(*)::int as n from events where kind = 'visit' and referrer is not null and at >= ${R}
          group by 1 order by 2 desc limit 10`,
      ),
    };

    /* ---------- games in the browser ---------- */
    const browserGames = async (mode: string) => {
      const count = (kind: string, from: string | null) =>
        n(`select count(*) as n from events where kind = $1 and mode = $2 ${from ? `and at >= ${from}` : ''}`, [kind, mode]);
      return {
        started: await count('game-start', null),
        finished: await count('game-end', null),
        startedToday: await count('game-start', today),
        startedWeek: await count('game-start', since(7)),
        startedRange: await count('game-start', R),
        finishedRange: await count('game-end', R),
        players: await n(`select count(distinct visitor) as n from events where kind = 'game-start' and mode = $1`, [mode]),
        playersRange: await n(`select count(distinct visitor) as n from events where kind = 'game-start' and mode = $1 and at >= ${R}`, [mode]),
        avgMoves: await n(`select round(avg(moves)) as n from events where kind = 'game-end' and mode = $1 and moves > 0 and at >= ${R}`, [mode]),
        avgMinutes: await n(`select round(avg(seconds) / 60.0, 1) as n from events where kind = 'game-end' and mode = $1 and seconds > 0 and at >= ${R}`, [mode]),
      };
    };
    const computer = {
      ...(await browserGames('ai')),
      results: await q<{ result: string; n: number }>(
        `select result, count(*)::int as n from events where kind = 'game-end' and mode = 'ai' and at >= ${R} group by 1 order by 2 desc`,
      ),
      levels: await q<{ level: string; started: number; finished: number; wins: number; losses: number; draws: number }>(
        `select level,
                count(*) filter (where kind = 'game-start')::int as started,
                count(*) filter (where kind = 'game-end')::int as finished,
                count(*) filter (where kind = 'game-end' and result = 'win')::int as wins,
                count(*) filter (where kind = 'game-end' and result in ('loss', 'resigned'))::int as losses,
                count(*) filter (where kind = 'game-end' and result = 'draw')::int as draws
           from events where mode = 'ai' and level is not null and at >= ${R}
          group by level`,
      ),
    };
    const local = await browserGames('local');

    /* ---------- online games ---------- */
    const og = (where: string) => n(`select count(*) as n from games where status = 'over' and ${where}`);
    const online = {
      ever: await og('true'),
      today: await og(`ended_at >= ${today}`),
      week: await og(`ended_at >= ${since(7)}`),
      range: await og(`ended_at >= ${R}`),
      rated: await og(`rated and ended_at >= ${R}`),
      casual: await og(`not rated and ended_at >= ${R}`),
      tournament: await og(`tournament is not null and ended_at >= ${R}`),
      aborted: await n(`select count(*) as n from games where status in ('aborted', 'cancelled') and created_at >= ${R}`),
      players: await n(
        `select count(distinct p) as n from (select white as p from games where status = 'over' and ended_at >= ${R}
           union all select black from games where status = 'over' and ended_at >= ${R}) x`,
      ),
      avgMoves: await n(
        `select round(avg((length(moves) - length(replace(moves, ' ', '')) + 1) / 2.0)) as n from games
          where status = 'over' and moves <> '' and ended_at >= ${R}`,
      ),
      avgMinutes: await n(
        `select round(avg(extract(epoch from (ended_at - coalesce(started_at, created_at)))) / 60.0, 1) as n from games
          where status = 'over' and ended_at >= ${R}`,
      ),
      timeControls: await q<{ tc: string; n: number }>(
        `select tc, count(*)::int as n from games where status = 'over' and ended_at >= ${R} group by 1 order by 2 desc`,
      ),
      endings: await q<{ reason: string; n: number }>(
        `select coalesce(reason, 'unknown') as reason, count(*)::int as n from games where status = 'over' and ended_at >= ${R} group by 1 order by 2 desc`,
      ),
      winners: await q<{ winner: string; n: number }>(
        `select coalesce(winner, 'draw') as winner, count(*)::int as n from games where status = 'over' and ended_at >= ${R} group by 1`,
      ),
      busiestHours: await q<{ hour: number; n: number }>(
        `select extract(hour from ended_at at time zone 'Africa/Lagos')::int as hour, count(*)::int as n from games
          where status = 'over' and ended_at >= ${R} group by 1 order by 1`,
      ),
      mostActive: await q<{ name: string; n: number }>(
        `select u.name, count(*)::int as n from (select white as p from games where status = 'over' and ended_at >= ${R}
           union all select black from games where status = 'over' and ended_at >= ${R}) x join users u on u.id = x.p
          where u.guest = false and u.deleted = false group by u.name order by 2 desc limit 10`,
      ),
    };

    /* ---------- players ---------- */
    const players = {
      accounts: await n('select count(*) as n from users where guest = false and deleted = false'),
      guests: await n('select count(*) as n from users where guest = true and deleted = false'),
      withEmail: await n('select count(*) as n from users where guest = false and deleted = false and email is not null'),
      newToday: await n(`select count(*) as n from users where guest = false and deleted = false and created_at >= ${today}`),
      newWeek: await n(`select count(*) as n from users where guest = false and deleted = false and created_at >= ${since(7)}`),
      newRange: await n(`select count(*) as n from users where guest = false and deleted = false and created_at >= ${R}`),
      guestsRange: await n(`select count(*) as n from users where guest = true and created_at >= ${R}`),
      activeToday: await n(`select count(distinct user_id) as n from sessions where last_seen >= ${today}`),
      activeWeek: await n(`select count(distinct user_id) as n from sessions where last_seen >= ${since(7)}`),
      rated: await n('select count(distinct user_id) as n from ratings where games > 0'),
      suspended: await n('select count(*) as n from users where banned_until > now()'),
      deleted: await n('select count(*) as n from users where deleted = true'),
      countries: await q<{ country: string; n: number }>(
        `select country, count(*)::int as n from users where guest = false and deleted = false and country <> '' group by 1 order by 2 desc limit 10`,
      ),
      bestStreaks: await q<{ name: string; n: number }>(
        'select name, best_streak as n from users where guest = false and deleted = false and best_streak > 0 order by best_streak desc limit 5',
      ),
    };

    /* ---------- the rest ---------- */
    const social = {
      messages: await n('select count(*) as n from community_messages where deleted = false'),
      messagesRange: await n(`select count(*) as n from community_messages where deleted = false and created_at >= ${R}`),
      chatters: await n(`select count(distinct user_id) as n from community_messages where created_at >= ${R}`),
      shared: await n(`select count(*) as n from community_messages where card is not null and created_at >= ${R}`),
      friendships: await n("select count(*) as n from friends where status = 'accepted'"),
      reports: await n(`select count(*) as n from reports where created_at >= ${R}`),
      openReports: await n("select count(*) as n from reports where status = 'open'"),
    };
    const events = {
      tournaments: await n('select count(*) as n from tournaments'),
      tournamentsFinished: await n("select count(*) as n from tournaments where status = 'finished'"),
      tournamentsLive: await n("select count(*) as n from tournaments where status in ('open', 'running')"),
      tournamentEntries: await n('select count(*) as n from tournament_players'),
      clusters: await n('select count(*) as n from clusters'),
      clusterMembers: await n("select count(*) as n from cluster_members where status <> 'pending'"),
      clashes: await n("select count(*) as n from clashes where status = 'over'"),
    };
    const peaks = {
      onlineToday: await n(`select max(online) as n from stats_samples where at >= ${today}`),
      onlineRange: await n(`select max(online) as n from stats_samples where at >= ${R}`),
      onlineEver: await n('select max(online) as n from stats_samples'),
      gamesEver: await n('select max(games) as n from stats_samples'),
    };

    /* ---------- day by day ---------- */
    const series = async (sql: string) => {
      const rows = await q<{ day: string; n: number }>(sql);
      return new Map(rows.map((r) => [String(r.day), Number(r.n)]));
    };
    const day = (col: string) => `to_char(${col} at time zone 'Africa/Lagos', 'YYYY-MM-DD')`;
    const vis = await series(`select ${day('at')} as day, count(distinct visitor)::int as n from events where at >= ${R} group by 1`);
    const ai = await series(`select ${day('at')} as day, count(*)::int as n from events where kind = 'game-start' and mode = 'ai' and at >= ${R} group by 1`);
    const loc = await series(`select ${day('at')} as day, count(*)::int as n from events where kind = 'game-start' and mode = 'local' and at >= ${R} group by 1`);
    const onl = await series(`select ${day('ended_at')} as day, count(*)::int as n from games where status = 'over' and ended_at >= ${R} group by 1`);
    const sign = await series(`select ${day('created_at')} as day, count(*)::int as n from users where guest = false and created_at >= ${R} group by 1`);
    const daily: { day: string; visitors: number; computer: number; local: number; online: number; signups: number }[] = [];
    for (let i = d - 1; i >= 0; i--) {
      const k = new Date(lagosToday(this.now()) - i * 86_400_000).toISOString().slice(0, 10);
      daily.push({ day: k, visitors: vis.get(k) ?? 0, computer: ai.get(k) ?? 0, local: loc.get(k) ?? 0, online: onl.get(k) ?? 0, signups: sign.get(k) ?? 0 });
    }

    return { days: d, visitors, computer, local, online, players, social, events, peaks, daily, trackingSince: await this.firstEvent() };
  }

  private async firstEvent(): Promise<number | null> {
    const r = await this.db.query<{ at: string | Date | null }>('select min(at) as at from events');
    return r[0]?.at ? new Date(r[0].at).getTime() : null;
  }
}

/** Midnight today in Lagos, as a UTC timestamp of that calendar day. */
function lagosToday(now: number) {
  const k = new Date(now + 3_600_000).toISOString().slice(0, 10);
  return Date.parse(k + 'T00:00:00Z');
}
