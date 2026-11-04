/**
 * Clusters: teams that fight as one army in Clash of Clusters.
 *
 * The founder is the King (captain). Members each hold one of the sixteen
 * chess roles (King, Sorceress, two Siege Towers, two Rangers, two Raiders,
 * eight Footmen). Players ask to join; the King takes them in as a member,
 * a substitute (on the bench, ready to come on) or a spectator (can watch the
 * cluster's clashes), or turns them away. The King can switch anyone's role,
 * bring a substitute on for a member, hand over the crown, or remove people.
 */
import { CLUSTER_ROLES, type ClashRecord, type ClusterDetail, type ClusterMember, type ClusterRole, type ClusterSummary, type MemberStatus } from '@cr/chess-core';
import { AuthError, type Accounts, type UserRow } from './accounts';
import type { Db } from './db';
import { PROVISIONAL_RD, type GlickoRating } from './glicko';

export const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _'-]{1,22}[A-Za-z0-9]$/;

interface ClusterRow {
  id: number;
  name: string;
  motto: string;
  king: number;
  rating: number;
  rd: number;
  vol: number;
  clashes: number;
  wins: number;
  losses: number;
  draws: number;
}

interface MemberRow {
  user_id: number;
  name: string;
  status: MemberStatus;
  role: ClusterRole | null;
}

export class Clusters {
  /** Who is online right now (filled in by the hub). */
  online: (userId: number) => boolean = () => false;

  constructor(
    private db: Db,
    private accounts: Accounts,
  ) {}

  private async row(nameOrId: string | number): Promise<ClusterRow> {
    const rows =
      typeof nameOrId === 'number'
        ? await this.db.query<ClusterRow>('select * from clusters where id = $1', [nameOrId])
        : await this.db.query<ClusterRow>('select * from clusters where name_key = $1', [nameOrId.toLowerCase()]);
    if (!rows[0]) throw new AuthError('No cluster with that name.', 404);
    return rows[0];
  }

  private async members(clusterId: number): Promise<MemberRow[]> {
    return this.db.query<MemberRow>(
      `select m.user_id, u.name, m.status, m.role from cluster_members m join users u on u.id = m.user_id
       where m.cluster_id = $1 order by m.joined_at`,
      [clusterId],
    );
  }

  private async rating(userId: number): Promise<number> {
    const r = await this.accounts.ratings(userId);
    return Math.max(r.blitz.rating, r.rapid.rating);
  }

  /** The cluster a user belongs to (as member, substitute or spectator). */
  async mine(userId: number): Promise<{ clusterId: number; status: MemberStatus; role: ClusterRole | null } | null> {
    const rows = await this.db.query<{ cluster_id: number; status: MemberStatus; role: ClusterRole | null }>(
      "select cluster_id, status, role from cluster_members where user_id = $1 and status <> 'pending'",
      [userId],
    );
    const r = rows[0];
    return r ? { clusterId: r.cluster_id, status: r.status, role: r.role } : null;
  }

  private async requireKing(user: UserRow, name: string): Promise<ClusterRow> {
    const c = await this.row(name);
    if (c.king !== user.id) throw new AuthError('Only the cluster’s King can do that.', 403);
    return c;
  }

  private requireAccount(user: UserRow) {
    if (user.guest) throw new AuthError('Clusters need a free account. Make one from the online lobby.', 403);
  }

  private async freeRole(clusterId: number): Promise<ClusterRole | null> {
    const taken = new Set((await this.members(clusterId)).map((m) => m.role).filter(Boolean));
    // Fill the army from the back rank inward: Sorceress, Towers, Rangers, Raiders, then Footmen.
    return CLUSTER_ROLES.find((r) => !taken.has(r)) ?? null;
  }

  async create(user: UserRow, name: unknown, motto: unknown): Promise<ClusterDetail> {
    this.requireAccount(user);
    if (typeof name !== 'string' || !CLUSTER_NAME.test(name.trim())) throw new AuthError('Cluster names are 3 to 24 letters, numbers, spaces, _ - or \'.');
    const n = name.trim().replace(/\s+/g, ' ');
    if (['new', 'mine'].includes(n.toLowerCase())) throw new AuthError('That name is reserved. Try another.');
    if (await this.mine(user.id)) throw new AuthError('You are already in a cluster. Leave it first.', 409);
    const taken = await this.db.query('select id from clusters where name_key = $1', [n.toLowerCase()]);
    if (taken.length) throw new AuthError('That cluster name is taken.', 409);
    const m = typeof motto === 'string' ? motto.trim().slice(0, 80) : '';
    const rows = await this.db.query<{ id: number }>('insert into clusters(name, name_key, motto, king) values ($1, $2, $3, $4) returning id', [n, n.toLowerCase(), m, user.id]);
    const id = rows[0]!.id;
    await this.db.query("delete from cluster_members where user_id = $1 and status = 'pending'", [user.id]);
    await this.db.query("insert into cluster_members(cluster_id, user_id, status, role) values ($1, $2, 'member', 'k')", [id, user.id]);
    return this.detail(n, user);
  }

  async list(q: string | null, limit = 30): Promise<ClusterSummary[]> {
    const rows = q
      ? await this.db.query<ClusterRow>("select * from clusters where name_key like $1 order by rating desc limit $2", [`%${q.toLowerCase().replace(/[%_]/g, '')}%`, limit])
      : await this.db.query<ClusterRow>('select * from clusters order by rating desc, clashes desc limit $1', [limit]);
    return Promise.all(rows.map((r) => this.summary(r)));
  }

  private async summary(c: ClusterRow, members?: MemberRow[]): Promise<ClusterSummary> {
    const ms = members ?? (await this.members(c.id));
    const fighting = ms.filter((m) => m.status === 'member');
    let power = 0;
    for (const m of fighting) power += await this.rating(m.user_id);
    const king = ms.find((m) => m.user_id === c.king);
    return {
      id: c.id,
      name: c.name,
      motto: c.motto,
      king: king?.name ?? '',
      members: fighting.length,
      power,
      rating: Math.round(c.rating),
      provisional: c.rd >= PROVISIONAL_RD,
      record: { clashes: c.clashes, wins: c.wins, losses: c.losses, draws: c.draws },
    };
  }

  async detail(name: string | number, viewer: UserRow | null): Promise<ClusterDetail> {
    const c = await this.row(name);
    const ms = await this.members(c.id);
    const isKing = viewer?.id === c.king;
    const roster: ClusterMember[] = [];
    for (const m of ms) {
      // Join requests are only shown to the King (and to the person asking).
      if (m.status === 'pending' && !isKing && m.user_id !== viewer?.id) continue;
      roster.push({ id: m.user_id, name: m.name, status: m.status, role: m.role, rating: await this.rating(m.user_id), online: this.online(m.user_id) });
    }
    const me = viewer ? ms.find((m) => m.user_id === viewer.id) : undefined;
    return {
      ...(await this.summary(c, ms)),
      roster,
      you: me ? { status: me.status, role: me.role, king: isKing } : null,
      recent: await this.recent(c.id),
    };
  }

  async recent(clusterId: number, limit = 10): Promise<ClashRecord[]> {
    const rows = await this.db.query<{ code: string; wn: string | null; bn: string | null; winner: string | null; reason: string | null; moves: string; ended_at: string | Date | null }>(
      `select c.code, w.name as wn, b.name as bn, c.winner, c.reason, c.moves, c.ended_at from clashes c
       left join clusters w on w.id = c.white left join clusters b on b.id = c.black
       where (c.white = $1 or c.black = $1) and c.status = 'over' order by c.ended_at desc limit $2`,
      [clusterId, limit],
    );
    return rows.map((r) => ({
      code: r.code,
      white: r.wn,
      black: r.bn,
      winner: r.winner === 'w' || r.winner === 'b' || r.winner === 'draw' ? r.winner : null,
      reason: r.reason,
      moves: r.moves ? r.moves.split(' ').length : 0,
      endedAt: r.ended_at ? new Date(r.ended_at).getTime() : null,
    }));
  }

  async requestJoin(user: UserRow, name: string): Promise<ClusterDetail> {
    this.requireAccount(user);
    const c = await this.row(name);
    if (await this.mine(user.id)) throw new AuthError('You are already in a cluster. Leave it first.', 409);
    await this.db.query(
      "insert into cluster_members(cluster_id, user_id, status) values ($1, $2, 'pending') on conflict (cluster_id, user_id) do nothing",
      [c.id, user.id],
    );
    return this.detail(c.id, user);
  }

  /** The King takes someone in (as member, substitute or spectator), moves them between those, or turns a request down. */
  async decide(king: UserRow, name: string, userId: number, as: unknown): Promise<ClusterDetail> {
    const c = await this.requireKing(king, name);
    const m = (await this.members(c.id)).find((x) => x.user_id === userId);
    if (!m) throw new AuthError('That player is not in this cluster or asking to join.', 404);
    if (userId === c.king) throw new AuthError('Pass the crown to someone else first.');
    if (as === 'reject') {
      await this.db.query('delete from cluster_members where cluster_id = $1 and user_id = $2', [c.id, userId]);
      return this.detail(c.id, king);
    }
    if (as !== 'member' && as !== 'sub' && as !== 'spectator') throw new AuthError('Choose member, substitute or spectator.');
    if (m.status === 'pending' && (await this.mine(userId))) {
      await this.db.query('delete from cluster_members where cluster_id = $1 and user_id = $2', [c.id, userId]);
      throw new AuthError('That player has joined another cluster since asking.', 409);
    }
    let role: ClusterRole | null = null;
    if (as === 'member') {
      role = m.role ?? (await this.freeRole(c.id));
      if (!role) throw new AuthError('All sixteen roles are filled. Take them in as a substitute, or swap someone out.', 409);
    }
    await this.db.query('update cluster_members set status = $3, role = $4 where cluster_id = $1 and user_id = $2', [c.id, userId, as, role]);
    // Taking someone in clears their other requests.
    await this.db.query("delete from cluster_members where user_id = $1 and status = 'pending'", [userId]);
    return this.detail(c.id, king);
  }

  /** Give a member a role; whoever held it swaps into their old role. Giving away the King's role passes the crown. */
  async setRole(king: UserRow, name: string, userId: number, role: unknown): Promise<ClusterDetail> {
    const c = await this.requireKing(king, name);
    if (!CLUSTER_ROLES.includes(role as ClusterRole)) throw new AuthError('Unknown role.');
    const r = role as ClusterRole;
    const ms = await this.members(c.id);
    const target = ms.find((x) => x.user_id === userId);
    if (!target || target.status === 'pending' || target.status === 'spectator') throw new AuthError('Only members and substitutes can take a role.');
    if (target.role === r) return this.detail(c.id, king);
    const holder = ms.find((x) => x.role === r);
    // Free the role first (roles are unique within a cluster), then swap.
    if (holder) await this.db.query('update cluster_members set role = null where cluster_id = $1 and user_id = $2', [c.id, holder.user_id]);
    const targetOld = target.role;
    await this.db.query("update cluster_members set role = $3, status = 'member' where cluster_id = $1 and user_id = $2", [c.id, userId, r]);
    if (holder) {
      // The previous holder takes the target's old role, or goes to the bench if the target had none.
      await this.db.query('update cluster_members set role = $3, status = $4 where cluster_id = $1 and user_id = $2', [c.id, holder.user_id, targetOld, targetOld ? 'member' : 'sub']);
    }
    if (r === 'k') await this.db.query('update clusters set king = $2 where id = $1', [c.id, userId]);
    return this.detail(c.id, king);
  }

  /** Bring a substitute on in place of a member (like a football substitution). */
  async substitute(king: UserRow, name: string, outId: number, inId: number): Promise<ClusterDetail> {
    const c = await this.requireKing(king, name);
    const ms = await this.members(c.id);
    const out = ms.find((x) => x.user_id === outId);
    const inn = ms.find((x) => x.user_id === inId);
    if (!out || out.status !== 'member' || !out.role) throw new AuthError('Choose a member to take off.');
    if (!inn || inn.status !== 'sub') throw new AuthError('Choose a substitute to bring on.');
    if (out.role === 'k') throw new AuthError('To replace the King, pass the crown instead.');
    const role = out.role;
    await this.db.query("update cluster_members set role = null, status = 'sub' where cluster_id = $1 and user_id = $2", [c.id, outId]);
    await this.db.query("update cluster_members set role = $3, status = 'member' where cluster_id = $1 and user_id = $2", [c.id, inId, role]);
    return this.detail(c.id, king);
  }

  async remove(king: UserRow, name: string, userId: number): Promise<ClusterDetail> {
    const c = await this.requireKing(king, name);
    if (userId === king.id) throw new AuthError('To leave, pass the crown first or use Leave.');
    await this.db.query('delete from cluster_members where cluster_id = $1 and user_id = $2', [c.id, userId]);
    return this.detail(c.id, king);
  }

  /** Leave (or withdraw a request). A King who leaves passes the crown to the longest-serving member; the last one out disbands the cluster. */
  async leave(user: UserRow, name: string): Promise<{ disbanded: boolean }> {
    const c = await this.row(name);
    await this.db.query('delete from cluster_members where cluster_id = $1 and user_id = $2', [c.id, user.id]);
    if (c.king !== user.id) return { disbanded: false };
    const rest = (await this.members(c.id)).filter((m) => m.status === 'member' || m.status === 'sub');
    if (!rest.length) {
      await this.db.query('delete from clusters where id = $1', [c.id]);
      return { disbanded: true };
    }
    const heir = rest.find((m) => m.status === 'member') ?? rest[0]!;
    await this.db.query('update cluster_members set role = null where cluster_id = $1 and role = $2', [c.id, 'k']);
    await this.db.query("update cluster_members set role = 'k', status = 'member' where cluster_id = $1 and user_id = $2", [c.id, heir.user_id]);
    await this.db.query('update clusters set king = $2 where id = $1', [c.id, heir.user_id]);
    return { disbanded: false };
  }

  async setMotto(king: UserRow, name: string, motto: unknown) {
    const c = await this.requireKing(king, name);
    await this.db.query('update clusters set motto = $2 where id = $1', [c.id, typeof motto === 'string' ? motto.trim().slice(0, 80) : '']);
    return this.detail(c.id, king);
  }

  /* used by clashes */

  async byId(id: number) {
    return this.row(id);
  }

  async roster(clusterId: number) {
    return this.members(clusterId);
  }

  async memberRating(userId: number) {
    return this.rating(userId);
  }

  async glicko(id: number): Promise<GlickoRating> {
    const c = await this.row(id);
    return { rating: c.rating, rd: c.rd, vol: c.vol };
  }

  async saveResult(id: number, r: GlickoRating, outcome: 'wins' | 'losses' | 'draws') {
    await this.db.query(`update clusters set rating = $2, rd = $3, vol = $4, clashes = clashes + 1, ${outcome} = ${outcome} + 1 where id = $1`, [id, r.rating, r.rd, r.vol]);
  }

  async headToHead(a: number, b: number) {
    const rows = await this.db.query<{ white: number; winner: string | null; n: string | number }>(
      `select white, winner, count(*) as n from clashes where status = 'over' and ((white = $1 and black = $2) or (white = $2 and black = $1)) group by white, winner`,
      [a, b],
    );
    const out = { wins: 0, losses: 0, draws: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      const side = r.white === a ? 'w' : 'b';
      if (r.winner === 'draw' || !r.winner) out.draws += n;
      else if (r.winner === side) out.wins += n;
      else out.losses += n;
    }
    return out;
  }
}
