/**
 * Accounts and sign-in. Passwords are hashed with scrypt (a fresh salt each);
 * sign-in hands out a random token whose SHA-256 is all the database keeps.
 * Guests get a real account with no password, so their games count, and can
 * turn it into a full account later by choosing a name and password.
 */
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { NAME_RULE, PASSWORD_MIN, type PublicUser, type Rating, type RatingCategory } from '@cr/chess-core';
import type { Db } from './db';
import { NEW_RATING, PROVISIONAL_RD, type GlickoRating } from './glicko';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface UserRow {
  id: number;
  name: string;
  guest: boolean;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  best_streak: number;
  is_admin: boolean;
  banned_until: string | Date | null;
  ban_reason: string | null;
  deleted: boolean;
  bio: string;
  country: string;
  avatar_ver: number;
  email: string | null;
  created_at: string | Date;
}

const USER_COLS = 'id, name, guest, games, wins, losses, draws, streak, best_streak, is_admin, banned_until, ban_reason, deleted, bio, country, avatar_ver, email, created_at';
/** Sessions end after this long without use. */
const SESSION_IDLE_DAYS = 90;
/** Names given admin rights (comma-separated ADMIN_NAMES). */
export const adminNames = () => new Set((process.env.ADMIN_NAMES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
export const isBanned = (u: Pick<UserRow, 'banned_until'>) => !!u.banned_until && new Date(u.banned_until).getTime() > Date.now();

const CATEGORIES: RatingCategory[] = ['blitz', 'rapid'];
const RESERVED = new Set(['admin', 'administrator', 'chessfront', 'moderator', 'support', 'system', 'guest', 'anonymous', 'computer']);

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RULE.test(name)) throw new AuthError('Names are 3 to 20 letters, numbers, _ or -.');
  const key = name.toLowerCase();
  if (RESERVED.has(key) || key.startsWith('guest')) throw new AuthError('That name is reserved. Try another.');
  return name;
}

export function checkNewPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw new AuthError(`Passwords need at least ${PASSWORD_MIN} characters.`);
  if (pw.length > 200) throw new AuthError('That password is too long.');
  return pw;
}

export class Accounts {
  constructor(private db: Db) {}

  async newSession(userId: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query('insert into sessions(token_hash, user_id) values ($1, $2)', [sha(token), userId]);
    return token;
  }

  async register(name: unknown, password: unknown, currentUserId?: number): Promise<{ token: string; user: PublicUser }> {
    const n = checkName(name);
    const pw = await hashPassword(checkNewPassword(password));
    const taken = await this.db.query('select id from users where name_key = $1', [n.toLowerCase()]);
    if (taken.length) throw new AuthError('That name is taken. Try another.', 409);
    let id: number;
    const current = currentUserId ? await this.user(currentUserId) : null;
    if (current?.guest) {
      // A guest keeps their games and ratings when they make an account.
      await this.db.query('update users set name = $1, name_key = $2, pass_hash = $3, guest = false where id = $4', [n, n.toLowerCase(), pw, current.id]);
      id = current.id;
    } else {
      const rows = await this.db.query<{ id: number }>('insert into users(name, name_key, pass_hash) values ($1, $2, $3) returning id', [n, n.toLowerCase(), pw]);
      id = rows[0]!.id;
    }
    if (adminNames().has(n.toLowerCase())) await this.db.query('update users set is_admin = true where id = $1', [id]);
    return { token: await this.newSession(id), user: (await this.publicUser(id))! };
  }

  async login(name: unknown, password: unknown): Promise<{ token: string; user: PublicUser }> {
    if (typeof name !== 'string' || typeof password !== 'string') throw new AuthError('Enter your name and password.');
    // Sign in with your name or your email.
    const key = name.trim().toLowerCase();
    const rows = await this.db.query<{ id: number; pass_hash: string | null; banned_until: string | null; ban_reason: string | null; deleted: boolean }>(
      'select id, pass_hash, banned_until, ban_reason, deleted from users where name_key = $1 or email_key = $1 limit 1',
      [key],
    );
    const row = rows[0];
    const ok = row?.pass_hash ? await checkPassword(password, row.pass_hash) : (await hashPassword('timing-equaliser'), false);
    if (!row || !ok || row.deleted) throw new AuthError('That name and password do not match.', 401);
    if (isBanned(row)) throw new AuthError(`This account is suspended until ${new Date(row.banned_until!).toUTCString()}${row.ban_reason ? `: ${row.ban_reason}` : ''}.`, 403);
    if (adminNames().has(key)) await this.db.query('update users set is_admin = true where id = $1', [row.id]);
    return { token: await this.newSession(row.id), user: (await this.publicUser(row.id))! };
  }

  async guest(): Promise<{ token: string; user: PublicUser }> {
    for (let i = 0; i < 20; i++) {
      const name = `Guest-${randomInt(1000, 100000)}`;
      const rows = await this.db.query<{ id: number }>('insert into users(name, name_key, guest) values ($1, $2, true) on conflict (name_key) do nothing returning id', [name, name.toLowerCase()]);
      if (rows[0]) return { token: await this.newSession(rows[0].id), user: (await this.publicUser(rows[0].id))! };
    }
    throw new AuthError('Could not make a guest name. Please try again.', 503);
  }

  async logout(token: string) {
    await this.db.query('delete from sessions where token_hash = $1', [sha(token)]);
  }

  /** The user a token belongs to, or null. */
  async fromToken(token: string | null | undefined): Promise<UserRow | null> {
    if (!token || token.length > 100) return null;
    const rows = await this.db.query<{ user_id: number }>(
      `update sessions set last_seen = now() where token_hash = $1 and last_seen > now() - interval '${SESSION_IDLE_DAYS} days' returning user_id`,
      [sha(token)],
    );
    const uid = rows[0]?.user_id;
    if (!uid) return null;
    const u = await this.user(uid);
    // Suspended and deleted accounts are signed out.
    if (!u || u.deleted || isBanned(u)) return null;
    return u;
  }

  async user(id: number): Promise<UserRow | null> {
    const rows = await this.db.query<UserRow>(`select ${USER_COLS} from users where id = $1`, [id]);
    return rows[0] ?? null;
  }

  async byName(name: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRow>(`select ${USER_COLS} from users where name_key = $1 and deleted = false`, [name.toLowerCase()]);
    return rows[0] ?? null;
  }

  async glicko(userId: number, cat: RatingCategory): Promise<GlickoRating & { games: number }> {
    const rows = await this.db.query<{ rating: number; rd: number; vol: number; games: number }>('select rating, rd, vol, games from ratings where user_id = $1 and category = $2', [userId, cat]);
    return rows[0] ?? { ...NEW_RATING, games: 0 };
  }

  async saveGlicko(userId: number, cat: RatingCategory, r: GlickoRating) {
    await this.db.query(
      `insert into ratings(user_id, category, rating, rd, vol, games) values ($1, $2, $3, $4, $5, 1)
       on conflict (user_id, category) do update set rating = $3, rd = $4, vol = $5, games = ratings.games + 1`,
      [userId, cat, r.rating, r.rd, r.vol],
    );
  }

  async ratings(userId: number): Promise<Record<RatingCategory, Rating>> {
    const out = {} as Record<RatingCategory, Rating>;
    for (const c of CATEGORIES) {
      const r = await this.glicko(userId, c);
      out[c] = { rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games };
    }
    return out;
  }

  async publicUser(id: number): Promise<PublicUser | null> {
    const u = await this.user(id);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      guest: u.guest,
      ratings: await this.ratings(id),
      record: { games: u.games, wins: u.wins, losses: u.losses, draws: u.draws, streak: u.streak, bestStreak: u.best_streak },
      bio: u.bio,
      country: u.country,
      avatar: u.avatar_ver ? `/api/avatars/${u.id}?v=${u.avatar_ver}` : null,
      ...(u.is_admin ? { admin: true } : {}),
      joined: new Date(u.created_at).getTime(),
    };
  }

  /** Results between two players (finished online games), from `a`'s side. */
  async headToHead(a: number, b: number) {
    const rows = await this.db.query<{ white: number; winner: string | null; n: string | number }>(
      `select white, winner, count(*) as n from games
       where status = 'over' and ((white = $1 and black = $2) or (white = $2 and black = $1))
       group by white, winner`,
      [a, b],
    );
    const out = { wins: 0, losses: 0, draws: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      const aColour = r.white === a ? 'w' : 'b';
      if (r.winner === 'draw' || r.winner === null) out.draws += n;
      else if (r.winner === aColour) out.wins += n;
      else out.losses += n;
    }
    return out;
  }

  /** Everyone `a` has played, with the score against each (most played first). */
  async rivals(a: number, limit = 20) {
    const rows = await this.db.query<{ opp: number; name: string; won: string; lost: string; drawn: string }>(
      `select opp, u.name,
         sum(case when winner = mine then 1 else 0 end) as won,
         sum(case when winner <> mine and winner <> 'draw' then 1 else 0 end) as lost,
         sum(case when winner = 'draw' then 1 else 0 end) as drawn
       from (select case when white = $1 then black else white end as opp,
                    case when white = $1 then 'w' else 'b' end as mine, winner
             from games where status = 'over' and (white = $1 or black = $1)) g
       join users u on u.id = g.opp
       group by opp, u.name order by count(*) desc limit $2`,
      [a, limit],
    );
    return rows.map((r) => ({ name: r.name, wins: Number(r.won), losses: Number(r.lost), draws: Number(r.drawn) }));
  }

  async leaderboard(cat: RatingCategory, limit = 50) {
    const rows = await this.db.query<{ name: string; rating: number; rd: number; games: number }>(
      `select u.name, r.rating, r.rd, r.games from ratings r join users u on u.id = r.user_id
       where r.category = $1 and u.guest = false order by (r.rd < $2) desc, r.rating desc limit $3`,
      [cat, PROVISIONAL_RD, limit],
    );
    return rows.map((r) => ({ name: r.name, rating: Math.round(r.rating), games: r.games, provisional: r.rd >= PROVISIONAL_RD }));
  }
}
