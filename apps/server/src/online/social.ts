/**
 * Notifications and friends.
 *
 * A notification is saved (so it is there when you next sign in) and pushed
 * at once to any open connection of that person: friend requests, direct
 * challenges, cluster join requests, tournament games starting,
 * announcements.
 */
import type { FriendInfo, Notification, ServerMsg } from '@cr/chess-core';
import { AuthError, type Accounts, type UserRow } from './accounts';
import type { Db } from './db';

export class Notifier {
  /** Pushes a message to every open connection of a user (set by the hub). */
  push: (userId: number, m: ServerMsg) => void = () => {};
  /** Is this user connected right now? (set by the hub) */
  online: (userId: number) => boolean = () => false;

  constructor(private db: Db) {}

  async notify(userId: number, kind: Notification['kind'], text: string, data: Record<string, unknown> = {}) {
    const rows = await this.db.query<{ id: number; created_at: string | Date }>(
      'insert into notifications(user_id, kind, text, data) values ($1, $2, $3, $4) returning id, created_at',
      [userId, kind, text, JSON.stringify(data)],
    );
    const note: Notification = { id: rows[0]!.id, kind, text, data, read: false, at: new Date(rows[0]!.created_at).getTime() };
    this.push(userId, { t: 'notify', note });
    // Keep the last 100.
    await this.db.query('delete from notifications where user_id = $1 and id < (select coalesce(min(id), 0) from (select id from notifications where user_id = $1 order by id desc limit 100) x)', [userId]);
    return note;
  }

  async list(userId: number): Promise<{ notes: Notification[]; unread: number }> {
    const rows = await this.db.query<{ id: number; kind: Notification['kind']; text: string; data: string; read: boolean; created_at: string | Date }>(
      'select id, kind, text, data, read, created_at from notifications where user_id = $1 order by id desc limit 50',
      [userId],
    );
    const notes = rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, data: JSON.parse(r.data || '{}'), read: r.read, at: new Date(r.created_at).getTime() }));
    return { notes, unread: notes.filter((n) => !n.read).length };
  }

  async markRead(userId: number, ids: number[] | 'all') {
    if (ids === 'all') await this.db.query('update notifications set read = true where user_id = $1', [userId]);
    else for (const id of ids.slice(0, 100)) await this.db.query('update notifications set read = true where user_id = $1 and id = $2', [userId, Number(id)]);
  }
}

const pair = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);

export class Friends {
  constructor(
    private db: Db,
    private accounts: Accounts,
    private notifier: Notifier,
  ) {}

  async list(me: UserRow): Promise<FriendInfo[]> {
    const rows = await this.db.query<{ a: number; b: number; status: string; requested_by: number }>('select a, b, status, requested_by from friends where a = $1 or b = $1', [me.id]);
    const out: FriendInfo[] = [];
    for (const r of rows) {
      const other = r.a === me.id ? r.b : r.a;
      const u = await this.accounts.user(other);
      if (!u || u.deleted) continue;
      const ratings = await this.accounts.ratings(other);
      out.push({
        id: u.id,
        name: u.name,
        status: r.status === 'accepted' ? 'friend' : r.requested_by === me.id ? 'sent' : 'received',
        online: this.notifier.online(u.id),
        rating: Math.max(ratings.blitz.rating, ratings.rapid.rating),
        avatar: u.avatar_ver ? `/api/avatars/${u.id}?v=${u.avatar_ver}` : null,
        h2h: await this.accounts.headToHead(me.id, u.id),
      });
    }
    return out.sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  }

  /** Send a request, or accept theirs if they already asked. */
  async request(me: UserRow, name: unknown) {
    if (me.guest) throw new AuthError('Friends need a free account.', 403);
    if (typeof name !== 'string') throw new AuthError('Whose friend do you want to be?');
    const them = await this.accounts.byName(name);
    if (!them || them.guest) throw new AuthError('No player with that name.', 404);
    if (them.id === me.id) throw new AuthError('You are already your own best friend.');
    const [a, b] = pair(me.id, them.id);
    const existing = (await this.db.query<{ status: string; requested_by: number }>('select status, requested_by from friends where a = $1 and b = $2', [a, b]))[0];
    if (existing?.status === 'accepted') return { status: 'friend' as const };
    if (existing && existing.requested_by !== me.id) {
      await this.db.query("update friends set status = 'accepted' where a = $1 and b = $2", [a, b]);
      await this.notifier.notify(them.id, 'friend', `${me.name} accepted your friend request.`, { name: me.name });
      return { status: 'friend' as const };
    }
    if (!existing) {
      const count = await this.db.query<{ n: string }>("select count(*) as n from friends where (a = $1 or b = $1) and status = 'pending' and requested_by = $1", [me.id]);
      if (Number(count[0]!.n) >= 50) throw new AuthError('You have 50 requests waiting. Wait for some answers first.', 429);
      await this.db.query("insert into friends(a, b, status, requested_by) values ($1, $2, 'pending', $3)", [a, b, me.id]);
      await this.notifier.notify(them.id, 'friend-request', `${me.name} wants to be your friend.`, { name: me.name });
    }
    return { status: 'sent' as const };
  }

  async remove(me: UserRow, name: unknown) {
    if (typeof name !== 'string') throw new AuthError('Who?');
    const them = await this.accounts.byName(name);
    if (!them) throw new AuthError('No player with that name.', 404);
    const [a, b] = pair(me.id, them.id);
    await this.db.query('delete from friends where a = $1 and b = $2', [a, b]);
  }

  async areFriends(x: number, y: number) {
    const [a, b] = pair(x, y);
    return (await this.db.query("select 1 from friends where a = $1 and b = $2 and status = 'accepted'", [a, b])).length > 0;
  }
}
