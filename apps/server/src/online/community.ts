/**
 * The community: one chat room for every player, with cards for win streaks,
 * wins and ratings, and a small leaderboard beside it.
 *
 * - Anyone can read; posting needs an account (not a guest) that isn't suspended.
 * - Cards are filled in by the server from its own records, so they can't be faked.
 * - ChessFront itself posts when someone reaches a win-streak milestone.
 * - Admins can remove any message; players can remove their own.
 * - Limits: CHAT_MAX characters, a message every 2.5 s and 6 per 30 s, no repeats,
 *   and no links except to chessfront.app.
 */
import {
  CHAT_MAX,
  type ChatAuthor,
  type ChatCard,
  type ChatMessage,
  type ChatShare,
  type CommunityBoard,
  type CommunityMsg,
  type RatingCategory,
  type ServerMsg,
} from '@cr/chess-core';
import { isBanned, type Accounts, type UserRow } from './accounts';
import type { Db } from './db';
import { PROVISIONAL_RD } from './glicko';

const HISTORY = 50;
const GAP_MS = 2500;
const BURST = 6;
const BURST_MS = 30_000;
const SHARE_GAP_MS = 5 * 60_000;
export const MILESTONES = [3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];

interface Listener {
  user: UserRow | null;
  send: (m: ServerMsg) => void;
}

interface Row {
  id: number;
  user_id: number;
  text: string;
  card: string | null;
  created_at: string | Date;
}

export class Community {
  readonly listeners = new Set<Listener>();
  private recent: ChatMessage[] | null = null;
  private posts = new Map<number, number[]>();
  private lastText = new Map<number, { text: string; at: number }>();
  private shared = new Map<string, number>();
  private authors = new Map<number, { a: ChatAuthor; at: number }>();
  private board: { b: CommunityBoard; at: number } | null = null;

  constructor(
    private db: Db,
    private accounts: Accounts,
    private now: () => number = Date.now,
  ) {}

  async receive(c: Listener, msg: CommunityMsg) {
    switch (msg.t) {
      case 'chat-open': {
        this.listeners.add(c);
        c.send({ t: 'chat', messages: await this.history(), board: await this.leaders(), online: this.listeners.size });
        return this.sayOnline();
      }
      case 'chat-close':
        if (this.listeners.delete(c)) this.sayOnline();
        return;
      case 'chat-say': {
        const u = await this.poster(c);
        if (!u) return;
        const text = clean(msg.text);
        if (!text) return;
        if (!this.allowed(c, u, text)) return;
        return this.post(u.id, text, null);
      }
      case 'chat-share': {
        const u = await this.poster(c);
        if (!u) return;
        const what = msg.what;
        if (what !== 'streak' && what !== 'win' && what !== 'rating') return;
        const key = `${u.id}:${what}`;
        if (this.now() - (this.shared.get(key) ?? -Infinity) < SHARE_GAP_MS) return err(c, 'You shared that a moment ago. Give it a few minutes.');
        const card = await this.card(u, what);
        if (typeof card === 'string') return err(c, card);
        const text = clean(msg.text ?? '');
        if (text && !this.allowed(c, u, text)) return;
        this.shared.set(key, this.now());
        return this.post(u.id, text, card);
      }
      case 'chat-delete': {
        if (!c.user) return;
        const u = (await this.accounts.user(c.user.id)) ?? c.user;
        const id = Number(msg.id);
        const rows = await this.db.query<{ user_id: number }>('select user_id from community_messages where id = $1 and deleted = false', [id]);
        const row = rows[0];
        if (!row) return;
        if (row.user_id !== u.id && !u.is_admin) return err(c, 'You can only remove your own messages.');
        await this.db.query('update community_messages set deleted = true where id = $1', [id]);
        if (u.is_admin && row.user_id !== u.id) {
          await this.db.query('insert into audit(admin, action, details) values ($1, $2, $3)', [u.id, 'remove-chat', JSON.stringify({ id, author: row.user_id })]);
        }
        if (this.recent) this.recent = this.recent.filter((m) => m.id !== id);
        return this.broadcast({ t: 'chat-gone', id });
      }
    }
  }

  disconnect(c: Listener) {
    if (this.listeners.delete(c)) this.sayOnline();
  }

  /** Called when a game ends: ChessFront congratulates a winner who reaches a milestone. */
  async gameWon(userId: number) {
    const u = await this.accounts.user(userId);
    if (!u || u.guest || u.deleted || !MILESTONES.includes(u.streak)) return;
    this.board = null;
    await this.post(u.id, '', { kind: 'milestone', streak: u.streak });
  }

  /* ---------- posting ---------- */

  private async poster(c: Listener): Promise<UserRow | null> {
    if (!c.user) {
      err(c, 'Sign in to chat with the community.');
      return null;
    }
    const u = (await this.accounts.user(c.user.id)) ?? c.user;
    c.user = u;
    if (u.guest) {
      err(c, 'Make a free account to chat with the community. Guests can read along.');
      return null;
    }
    if (u.deleted || isBanned(u)) {
      err(c, 'Your account is suspended, so you can’t post right now.');
      return null;
    }
    return u;
  }

  private allowed(c: Listener, u: UserRow, text: string): boolean {
    const t = this.now();
    if (/(https?:\/\/|www\.)\S+/i.test(text.replace(/(https?:\/\/)?(www\.)?chessfront\.app\S*/gi, ''))) {
      err(c, 'Links aren’t allowed in the community, except chessfront.app links.');
      return false;
    }
    const mine = (this.posts.get(u.id) ?? []).filter((at) => t - at < BURST_MS);
    if (mine.length && t - mine[mine.length - 1]! < GAP_MS) {
      err(c, 'Slow down a little.');
      return false;
    }
    if (mine.length >= BURST) {
      err(c, 'That’s a lot of messages. Wait a few seconds.');
      return false;
    }
    const last = this.lastText.get(u.id);
    if (last && last.text.toLowerCase() === text.toLowerCase() && t - last.at < 60_000) {
      err(c, 'You just said that.');
      return false;
    }
    mine.push(t);
    this.posts.set(u.id, mine);
    this.lastText.set(u.id, { text, at: t });
    return true;
  }

  private async post(userId: number, text: string, card: ChatCard | null) {
    const recent = await this.history(); // loaded before the insert, so the new message isn't in it twice
    const rows = await this.db.query<{ id: number }>('insert into community_messages(user_id, text, card) values ($1, $2, $3) returning id', [
      userId,
      text,
      card ? JSON.stringify(card) : null,
    ]);
    const message: ChatMessage = { id: Number(rows[0]!.id), at: this.now(), user: await this.author(userId, true), text, card };
    if (!recent.some((m) => m.id === message.id)) recent.push(message);
    if (recent.length > HISTORY) recent.splice(0, recent.length - HISTORY);
    this.broadcast({ t: 'chat-new', message });
  }

  /* ---------- cards ---------- */

  private async card(u: UserRow, what: ChatShare): Promise<ChatCard | string> {
    if (what === 'streak') {
      if (u.streak < 1) return 'You’re not on a winning streak right now. Win a game to start one!';
      return { kind: 'streak', streak: u.streak, best: u.best_streak };
    }
    if (what === 'win') {
      const rows = await this.db.query<{ code: string; tc: string; rated: boolean; reason: string | null; moves: string; white: number; opp: string | null; opp_rating: number | null }>(
        `select g.code, g.tc, g.rated, g.reason, g.moves, g.white, o.name as opp,
                case when g.white = $1 then g.black_before else g.white_before end as opp_rating
           from games g left join users o on o.id = case when g.white = $1 then g.black else g.white end
          where g.status = 'over' and ((g.white = $1 and g.winner = 'w') or (g.black = $1 and g.winner = 'b'))
          order by g.ended_at desc nulls last limit 1`,
        [u.id],
      );
      const g = rows[0];
      if (!g) return 'You haven’t won an online game yet. Your first win will be worth sharing!';
      return {
        kind: 'win',
        code: g.code,
        opponent: g.opp ?? 'a player',
        opponentRating: g.opp_rating == null ? null : Math.round(Number(g.opp_rating)),
        tc: g.tc as never,
        rated: !!g.rated,
        reason: g.reason ?? 'win',
        moves: g.moves ? Math.ceil(g.moves.split(' ').length / 2) : 0,
      };
    }
    const ratings = await this.accounts.ratings(u.id);
    const cat: RatingCategory = ratings.rapid.games > ratings.blitz.games ? 'rapid' : 'blitz';
    const r = ratings[cat];
    if (!r.games) return 'Play a rated game first to get a rating to share.';
    const provisional = r.rd >= PROVISIONAL_RD;
    let rank: number | null = null;
    if (!provisional) {
      const above = await this.db.query<{ n: string | number }>(
        `select count(*) as n from ratings r join users x on x.id = r.user_id
          where r.category = $1 and x.guest = false and x.deleted = false and r.rd < $2 and r.rating > $3`,
        [cat, PROVISIONAL_RD, r.rating],
      );
      rank = Number(above[0]!.n) + 1;
    }
    return { kind: 'rating', category: cat, rating: Math.round(r.rating), rank, provisional };
  }

  /* ---------- reading ---------- */

  private async history(): Promise<ChatMessage[]> {
    if (this.recent) return this.recent;
    const rows = await this.db.query<Row>(
      'select id, user_id, text, card, created_at from community_messages where deleted = false order by id desc limit $1',
      [HISTORY],
    );
    const out: ChatMessage[] = [];
    for (const r of rows.reverse()) {
      out.push({ id: Number(r.id), at: new Date(r.created_at).getTime(), user: await this.author(r.user_id), text: r.text, card: r.card ? (JSON.parse(r.card) as ChatCard) : null });
    }
    // Another call may have filled it meanwhile.
    if (!this.recent) this.recent = out;
    return this.recent;
  }

  private async author(id: number, fresh = false): Promise<ChatAuthor> {
    const hit = this.authors.get(id);
    if (hit && !fresh && this.now() - hit.at < 5 * 60_000) return hit.a;
    const p = await this.accounts.publicUser(id);
    const r = p ? (p.ratings.rapid.games > p.ratings.blitz.games ? p.ratings.rapid : p.ratings.blitz) : null;
    const a: ChatAuthor = {
      id,
      name: p?.name ?? 'Former player',
      avatar: p?.avatar ?? null,
      rating: r && r.games ? Math.round(r.rating) : null,
      admin: !!p?.admin,
      country: p?.country ?? '',
    };
    this.authors.set(id, { a, at: this.now() });
    return a;
  }

  async leaders(): Promise<CommunityBoard> {
    if (this.board && this.now() - this.board.at < 30_000) return this.board.b;
    const top = async (cat: RatingCategory) =>
      (await this.accounts.leaderboard(cat, 5)).filter((r) => r.games > 0).map((r) => ({ name: r.name, rating: r.rating, provisional: r.provisional }));
    const streaks = await this.db.query<{ name: string; streak: number }>(
      `select name, streak from users
        where streak >= 2 and guest = false and deleted = false and (banned_until is null or banned_until < now())
        order by streak desc, best_streak desc limit 5`,
    );
    const b: CommunityBoard = { blitz: await top('blitz'), rapid: await top('rapid'), streaks: streaks.map((s) => ({ name: s.name, streak: Number(s.streak) })) };
    this.board = { b, at: this.now() };
    return b;
  }

  private sayOnline() {
    this.broadcast({ t: 'chat-online', online: this.listeners.size });
  }

  private broadcast(m: ServerMsg) {
    for (const l of this.listeners) l.send(m);
  }
}

function err(c: Listener, message: string) {
  c.send({ t: 'error', message, code: 'chat' });
}

/** One line of plain text: no control characters, spaces collapsed, at most CHAT_MAX characters. */
export function clean(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX);
}
