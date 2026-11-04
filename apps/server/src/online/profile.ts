/**
 * Account settings: password, email and password reset, profile (bio,
 * country, picture), signing out everywhere, and deleting the account.
 */
import { randomInt } from 'node:crypto';
import { AuthError, checkNewPassword, checkPassword, hashPassword, sha, type Accounts, type UserRow } from './accounts';
import type { Clusters } from './clusters';
import type { Db } from './db';
import type { Mailer } from './mailer';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RESET_MINUTES = 15;
export const AVATAR_MAX_BYTES = 64 * 1024;

/** The picture's type from its first bytes (JPEG, PNG or WebP only). */
export function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export class Profiles {
  constructor(
    private db: Db,
    private accounts: Accounts,
    private clusters: Clusters,
    private mail: Mailer,
  ) {}

  private async requirePassword(me: UserRow, password: unknown) {
    const row = (await this.db.query<{ pass_hash: string | null }>('select pass_hash from users where id = $1', [me.id]))[0];
    if (!row?.pass_hash || typeof password !== 'string' || !(await checkPassword(password, row.pass_hash))) throw new AuthError('That password is not right.', 401);
  }

  /** Your own account, with private fields. */
  async me(me: UserRow) {
    return { ...(await this.accounts.publicUser(me.id))!, email: me.email };
  }

  async changePassword(me: UserRow, current: unknown, next: unknown, keepToken: string | null) {
    await this.requirePassword(me, current);
    const pw = await hashPassword(checkNewPassword(next));
    await this.db.query('update users set pass_hash = $2 where id = $1', [me.id, pw]);
    // Every other device is signed out.
    await this.db.query('delete from sessions where user_id = $1 and token_hash <> $2', [me.id, keepToken ? sha(keepToken) : '']);
  }

  async setEmail(me: UserRow, email: unknown, password: unknown) {
    if (me.guest) throw new AuthError('Make an account first.', 403);
    await this.requirePassword(me, password);
    if (email === '' || email === null) {
      await this.db.query('update users set email = null, email_key = null where id = $1', [me.id]);
      return;
    }
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) throw new AuthError('That email address does not look right.');
    const e = email.trim();
    const taken = await this.db.query('select id from users where email_key = $1 and id <> $2', [e.toLowerCase(), me.id]);
    if (taken.length) throw new AuthError('Another account uses that email.', 409);
    await this.db.query('update users set email = $2, email_key = $3 where id = $1', [me.id, e, e.toLowerCase()]);
  }

  /** Emails a reset code. Always answers the same way, so it can't be used to find out who has an account. */
  async requestReset(nameOrEmail: unknown) {
    if (typeof nameOrEmail !== 'string' || !nameOrEmail.trim()) throw new AuthError('Enter your name or email.');
    const key = nameOrEmail.trim().toLowerCase();
    const u = (await this.db.query<{ id: number; name: string; email: string | null }>('select id, name, email from users where (name_key = $1 or email_key = $1) and deleted = false limit 1', [key]))[0];
    if (!u?.email) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.query(
      `insert into reset_codes(user_id, code_hash, expires_at, tries) values ($1, $2, now() + interval '${RESET_MINUTES} minutes', 0)
       on conflict (user_id) do update set code_hash = $2, expires_at = now() + interval '${RESET_MINUTES} minutes', tries = 0`,
      [u.id, sha(`${u.id}:${code}`)],
    );
    await this.mail({
      to: u.email,
      subject: `Your ChessFront code: ${code}`,
      text: `Hello ${u.name},\n\nYour code to set a new ChessFront password is ${code}. It works for ${RESET_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email; your password hasn't changed.\n\nChessFront · The Living Chess Experience\nhttps://chessfront.app`,
    });
  }

  async reset(nameOrEmail: unknown, code: unknown, password: unknown): Promise<string> {
    if (typeof nameOrEmail !== 'string' || typeof code !== 'string') throw new AuthError('Enter your name or email and the code.');
    const key = nameOrEmail.trim().toLowerCase();
    const row = (
      await this.db.query<{ id: number; code_hash: string; expired: boolean; tries: number }>(
        `select u.id, r.code_hash, r.expires_at < now() as expired, r.tries from users u join reset_codes r on r.user_id = u.id
         where (u.name_key = $1 or u.email_key = $1) and u.deleted = false limit 1`,
        [key],
      )
    )[0];
    const bad = new AuthError('That code is not right, or it has expired. Ask for a new one.', 400);
    if (!row || row.expired || row.tries >= 5) throw bad;
    if (sha(`${row.id}:${code.trim()}`) !== row.code_hash) {
      await this.db.query('update reset_codes set tries = tries + 1 where user_id = $1', [row.id]);
      throw bad;
    }
    const pw = await hashPassword(checkNewPassword(password));
    await this.db.query('update users set pass_hash = $2 where id = $1', [row.id, pw]);
    await this.db.query('delete from reset_codes where user_id = $1', [row.id]);
    await this.db.query('delete from sessions where user_id = $1', [row.id]);
    return this.accounts.newSession(row.id);
  }

  async update(me: UserRow, body: Record<string, unknown>) {
    if (me.guest) throw new AuthError('Make an account first.', 403);
    if (body.bio !== undefined) {
      if (typeof body.bio !== 'string') throw new AuthError('Bad bio.');
      await this.db.query('update users set bio = $2 where id = $1', [me.id, body.bio.replace(/\s+/g, ' ').trim().slice(0, 160)]);
    }
    if (body.country !== undefined) {
      const c = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
      if (c && !/^[A-Z]{2}$/.test(c)) throw new AuthError('Choose a country from the list.');
      await this.db.query('update users set country = $2 where id = $1', [me.id, c]);
    }
  }

  async setAvatar(me: UserRow, data: unknown) {
    if (me.guest) throw new AuthError('Make an account first.', 403);
    if (typeof data !== 'string') throw new AuthError('Choose a picture.');
    const b64 = data.replace(/^data:image\/[a-z]+;base64,/, '');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > AVATAR_MAX_BYTES) throw new AuthError('That picture is too big. Pictures are shrunk before upload; try another.', 413);
    if (!imageType(bytes)) throw new AuthError('Pictures must be JPEG, PNG or WebP.');
    await this.db.query('update users set avatar = $2, avatar_ver = avatar_ver + 1 where id = $1', [me.id, bytes]);
  }

  async removeAvatar(userId: number) {
    await this.db.query('update users set avatar = null, avatar_ver = 0 where id = $1', [userId]);
  }

  async avatar(userId: number): Promise<{ type: string; bytes: Buffer } | null> {
    const row = (await this.db.query<{ avatar: Uint8Array | null }>('select avatar from users where id = $1 and deleted = false', [userId]))[0];
    if (!row?.avatar) return null;
    const bytes = Buffer.from(row.avatar);
    const type = imageType(bytes);
    return type ? { type, bytes } : null;
  }

  async logoutAll(me: UserRow) {
    await this.db.query('delete from sessions where user_id = $1', [me.id]);
  }

  /**
   * Deletes the account: the name, password, email, picture, bio, friends,
   * notifications and sessions go. Finished games stay in opponents' history
   * under "deleted player".
   */
  async deleteAccount(me: UserRow, password: unknown) {
    if (!me.guest) await this.requirePassword(me, password);
    const mine = await this.clusters.mine(me.id);
    if (mine) {
      const c = await this.clusters.byId(mine.clusterId);
      await this.clusters.leave(me, c.name);
    }
    const ghost = `deleted-${me.id}`;
    await this.db.query(
      `update users set name = $2, name_key = $2, pass_hash = null, email = null, email_key = null, avatar = null, avatar_ver = 0,
         bio = '', country = '', deleted = true where id = $1`,
      [me.id, ghost],
    );
    for (const sql of [
      'delete from sessions where user_id = $1',
      'delete from friends where a = $1 or b = $1',
      'delete from notifications where user_id = $1',
      'delete from cluster_members where user_id = $1',
      'delete from reset_codes where user_id = $1',
      "delete from tournament_players where user_id = $1 and tournament_id in (select id from tournaments where status = 'open')",
    ])
      await this.db.query(sql, [me.id]);
  }
}
