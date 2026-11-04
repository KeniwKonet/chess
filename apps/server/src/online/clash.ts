/**
 * Clash of Clusters: cluster against cluster on one board, each side's
 * pieces moved by the members who hold those roles.
 *
 * Chess still allows one move per turn, so on its turn a cluster decides
 * together:
 *   - members propose moves with the pieces they hold, and back each other's
 *     proposals;
 *   - the King plays any proposal (or makes a move directly, with any piece);
 *   - when the turn timer runs out, the most-backed proposal plays (the
 *     earliest wins a tie). If nobody proposed anything, the army acts on its
 *     own with a sound move from the engine, so a clash never stalls.
 * The King can hand any piece to another member or substitute mid-clash (or
 * keep it), which covers members who are away. Roles nobody holds belong to
 * the King. Anyone can watch.
 */
import { randomInt } from 'node:crypto';
import {
  CLASH_TURN_SECS,
  CLUSTER_ROLES,
  KingdomGame,
  ROLE_TITLE,
  chooseKingdomMove,
  roleOfPieceId,
  rolePieceId,
  type ClashMsg,
  type ClashProposal,
  type ClashSide,
  type ClashView,
  type ClusterRole,
  type Colour,
  type ServerMsg,
} from '@cr/chess-core';
import type { Accounts, UserRow } from './accounts';
import type { Clusters } from './clusters';
import type { Db } from './db';
import { rate } from './glicko';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () => 'c' + Array.from({ length: 7 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const other = (c: Colour): Colour => (c === 'w' ? 'b' : 'w');

export interface ClashConn {
  user: UserRow | null;
  send: (m: ServerMsg) => void;
  clashes: Set<string>;
}

interface LiveClash {
  code: string;
  status: ClashView['status'];
  turnSecs: number;
  target: number | null;
  targetName: string | null;
  sides: Partial<Record<Colour, ClashSide>>;
  game: KingdomGame | null;
  owners: Map<string, number>;
  proposals: ClashProposal[];
  nextId: number;
  turnEndsAt: number | null;
  timer: NodeJS.Timeout | null;
  conns: Set<ClashConn>;
  drawOffer: Colour | null;
  ratingChange?: Record<Colour, { before: number; after: number }>;
  lastNote: string | null;
  createdAt: number;
}

export class ClashHub {
  readonly clashes = new Map<string, LiveClash>();

  constructor(
    private db: Db,
    private accounts: Accounts,
    private clusters: Clusters,
    private opts: { now: () => number; timers: boolean; log: (...a: unknown[]) => void; connsOf: (userId: number) => ClashConn[] },
  ) {}

  close() {
    for (const c of this.clashes.values()) if (c.timer) clearTimeout(c.timer);
  }

  disconnect(conn: ClashConn) {
    for (const code of conn.clashes) {
      const c = this.clashes.get(code);
      if (!c) continue;
      c.conns.delete(conn);
      this.broadcast(c);
    }
    conn.clashes.clear();
  }

  async receive(conn: ClashConn, m: ClashMsg) {
    const err = (message: string) => conn.send({ t: 'error', message });
    if (m.t === 'clash-open') return this.open(conn, String(m.code));
    if (m.t === 'clash-list') return this.list(conn);
    const u = conn.user;
    if (!u) return conn.send({ t: 'error', message: 'Please sign in first.', code: 'auth' });
    try {
      switch (m.t) {
        case 'clash-create':
          return await this.create(conn, u, Number(m.turnSecs), m.target);
        case 'clash-accept':
          return await this.accept(conn, u, String(m.code));
        case 'clash-cancel':
          return await this.cancel(u, String(m.code));
        case 'clash-propose':
          return await this.propose(u, String(m.code), Number(m.ply), m.move);
        case 'clash-back':
          return this.back(u, String(m.code), Number(m.id));
        case 'clash-play':
          return await this.playProposal(u, String(m.code), Number(m.id));
        case 'clash-assign':
          return await this.assign(u, String(m.code), m.role, Number(m.to));
        case 'clash-resign':
          return await this.resign(u, String(m.code));
        case 'clash-draw':
          return await this.draw(u, String(m.code));
      }
    } catch (e) {
      return err((e as Error).message);
    }
  }

  /* ---------- setting up ---------- */

  private async side(clusterId: number): Promise<ClashSide> {
    const c = await this.clusters.byId(clusterId);
    const roster = await this.clusters.roster(clusterId);
    const members = [];
    for (const m of roster) {
      if (m.status === 'pending') continue;
      members.push({ id: m.user_id, name: m.name, status: m.status, role: m.role, rating: await this.clusters.memberRating(m.user_id) });
    }
    return { clusterId, name: c.name, kingId: c.king, rating: Math.round(c.rating), members };
  }

  /** The King's own cluster, or an error. */
  private async kingsCluster(u: UserRow): Promise<number> {
    const mine = await this.clusters.mine(u.id);
    if (!mine) throw new Error('Join or create a cluster first.');
    const c = await this.clusters.byId(mine.clusterId);
    if (c.king !== u.id) throw new Error('Only your cluster’s King can start or accept a clash.');
    return c.id;
  }

  private async create(conn: ClashConn, u: UserRow, turnSecs: number, target?: string) {
    const clusterId = await this.kingsCluster(u);
    if (!(CLASH_TURN_SECS as readonly number[]).includes(turnSecs)) turnSecs = 60;
    let targetId: number | null = null;
    let targetName: string | null = null;
    if (target) {
      const rows = await this.db.query<{ id: number; name: string }>('select id, name from clusters where name_key = $1', [target.trim().toLowerCase()]);
      if (!rows[0]) throw new Error('No cluster with that name.');
      if (rows[0].id === clusterId) throw new Error('A cluster can’t clash with itself.');
      targetId = rows[0].id;
      targetName = rows[0].name;
    }
    const c: LiveClash = {
      code: newCode(),
      status: 'waiting',
      turnSecs,
      target: targetId,
      targetName,
      sides: { w: await this.side(clusterId) },
      game: null,
      owners: new Map(),
      proposals: [],
      nextId: 1,
      turnEndsAt: null,
      timer: null,
      conns: new Set(),
      drawOffer: null,
      lastNote: null,
      createdAt: this.opts.now(),
    };
    // The challenger's colour is decided when the clash starts.
    this.clashes.set(c.code, c);
    await this.persist(c);
    conn.send({ t: 'clash-created', code: c.code });
    this.attach(conn, c);
    // Tell the challenged cluster's King (and everyone else's lobby) about it.
    if (targetId) {
      const tc = await this.clusters.byId(targetId);
      for (const k of this.opts.connsOf(tc.king)) await this.list(k);
    }
  }

  private async accept(conn: ClashConn, u: UserRow, code: string) {
    const c = this.clashes.get(code);
    if (!c || c.status !== 'waiting') throw new Error('That challenge is no longer open.');
    const clusterId = await this.kingsCluster(u);
    if (clusterId === c.sides.w!.clusterId) throw new Error('This is your own challenge. Send the link to the other cluster’s King.');
    if (c.target && c.target !== clusterId) throw new Error(`This challenge is for ${c.targetName}.`);
    const challenger = c.sides.w!;
    const accepter = await this.side(clusterId);
    const challengerWhite = randomInt(2) === 0;
    c.sides = challengerWhite ? { w: challenger, b: accepter } : { w: accepter, b: challenger };
    // Refresh the challenger's roster too (it may have changed while waiting).
    const fresh = await this.side(challenger.clusterId);
    if (challengerWhite) c.sides.w = fresh;
    else c.sides.b = fresh;
    c.game = new KingdomGame();
    c.status = 'playing';
    for (const colour of ['w', 'b'] as const) {
      const s = c.sides[colour]!;
      for (const role of CLUSTER_ROLES) {
        const holder = s.members.find((m) => m.status === 'member' && m.role === role);
        c.owners.set(rolePieceId(role, colour), holder?.id ?? s.kingId);
      }
    }
    this.attach(conn, c);
    this.startTurn(c);
    await this.persist(c);
    // Call everyone in both clusters who is online.
    for (const s of [c.sides.w!, c.sides.b!]) for (const m of s.members) for (const k of this.opts.connsOf(m.id)) this.attach(k, c);
    this.broadcast(c);
  }

  private async cancel(u: UserRow, code: string) {
    const c = this.clashes.get(code);
    if (!c || c.status !== 'waiting') return;
    if (c.sides.w?.kingId !== u.id) throw new Error('Only the King who made the challenge can cancel it.');
    c.status = 'aborted';
    await this.persist(c);
    this.broadcast(c);
    this.clashes.delete(code);
  }

  private async open(conn: ClashConn, code: string) {
    let c = this.clashes.get(code);
    if (!c) {
      const row = (await this.db.query<{ code: string; status: string; state: string }>('select code, status, state from clashes where code = $1', [code]))[0];
      if (!row) return conn.send({ t: 'error', message: 'No clash with that link.', code: 'missing' });
      c = this.fromState(row.code, JSON.parse(row.state));
      if (c.status === 'playing') {
        this.clashes.set(code, c);
        this.startTurn(c, c.turnEndsAt ?? undefined);
      }
    }
    this.attach(conn, c);
    this.broadcast(c);
  }

  private attach(conn: ClashConn, c: LiveClash) {
    c.conns.add(conn);
    conn.clashes.add(c.code);
  }

  /** Open challenges this King's cluster can accept, and clashes in play to watch. */
  async list(conn: ClashConn) {
    const mine = conn.user ? await this.clusters.mine(conn.user.id) : null;
    const open = [];
    const live = [];
    for (const c of this.clashes.values()) {
      if (c.status === 'waiting' && c.sides.w && (!c.target || c.target === mine?.clusterId) && c.sides.w.clusterId !== mine?.clusterId)
        open.push({ code: c.code, from: c.sides.w.name, fromRating: c.sides.w.rating, turnSecs: c.turnSecs, target: c.targetName });
      if (c.status === 'playing') live.push({ code: c.code, white: c.sides.w!.name, black: c.sides.b!.name, moves: c.game!.history.length });
    }
    conn.send({ t: 'clash-challenges', open, live });
  }

  /* ---------- playing ---------- */

  private sideOf(c: LiveClash, userId: number): Colour | null {
    for (const colour of ['w', 'b'] as const) if (c.sides[colour]?.members.some((m) => m.id === userId && m.status !== 'spectator')) return colour;
    return null;
  }

  private isKing(c: LiveClash, colour: Colour, userId: number) {
    return c.sides[colour]?.kingId === userId;
  }

  private turnOf(u: UserRow, code: string): { c: LiveClash; colour: Colour } {
    const c = this.clashes.get(code);
    if (!c || c.status !== 'playing' || !c.game) throw new Error('That clash is not in play.');
    const colour = this.sideOf(c, u.id);
    if (!colour) throw new Error('You are watching this clash.');
    return { c, colour };
  }

  private async propose(u: UserRow, code: string, ply: number, mv: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) {
    const { c, colour } = this.turnOf(u, code);
    const game = c.game!;
    if (ply !== game.history.length) return this.sendTo(u.id, c);
    if (game.turn !== colour) throw new Error('Wait for your cluster’s turn.');
    const id = game.tracker.at.get(mv.from as never);
    if (!id) throw new Error('There is no soldier there.');
    const king = this.isKing(c, colour, u.id);
    if (!king && c.owners.get(id) !== u.id) throw new Error('That soldier is commanded by someone else.');
    // Check legality without playing: try on a copy of the position.
    const probe = new KingdomGame({ fen: game.chess.fen });
    const r = probe.move(colour, { from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}) }, 0);
    if (!r.ok) throw new Error(r.reason);
    if (king) {
      // The King's own move is the cluster's decision.
      return this.commit(c, { from: mv.from, to: mv.to, promotion: mv.promotion }, `${this.name(c, colour, u.id)} (King) moved`);
    }
    // One proposal per member per turn: a new one replaces the old.
    c.proposals = c.proposals.filter((p) => p.by !== u.id).map((p) => ({ ...p, backers: p.backers.filter((b) => b !== u.id) }));
    c.proposals.push({ id: c.nextId++, by: u.id, byName: u.name, from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}), san: r.move.san, backers: [u.id] });
    this.broadcast(c);
  }

  private back(u: UserRow, code: string, id: number) {
    const { c, colour } = this.turnOf(u, code);
    if (c.game!.turn !== colour) throw new Error('Wait for your cluster’s turn.');
    const p = c.proposals.find((x) => x.id === id);
    if (!p) throw new Error('That proposal is gone.');
    const already = p.backers.includes(u.id);
    // One backing per member: moving your support takes it off the others.
    for (const q of c.proposals) q.backers = q.backers.filter((b) => b !== u.id);
    if (!already || p.by === u.id) p.backers.push(u.id);
    this.broadcast(c);
  }

  private async playProposal(u: UserRow, code: string, id: number) {
    const { c, colour } = this.turnOf(u, code);
    if (!this.isKing(c, colour, u.id)) throw new Error('Only the King decides. Back the move you like instead.');
    const p = c.proposals.find((x) => x.id === id);
    if (!p) throw new Error('That proposal is gone.');
    await this.commit(c, p, `${p.byName}'s move, chosen by the King`);
  }

  private async assign(u: UserRow, code: string, role: ClusterRole, to: number) {
    const { c, colour } = this.turnOf(u, code);
    if (!this.isKing(c, colour, u.id)) throw new Error('Only the King hands out soldiers.');
    if (!CLUSTER_ROLES.includes(role)) throw new Error('Unknown role.');
    const s = c.sides[colour]!;
    const target = s.members.find((m) => m.id === to && m.status !== 'spectator');
    if (!target) {
      // Someone who joined the cluster after the clash began.
      const fresh = await this.side(s.clusterId);
      const late = fresh.members.find((m) => m.id === to && m.status !== 'spectator' && m.status !== 'pending');
      if (!late) throw new Error('Only members and substitutes of your cluster can command a soldier.');
      s.members.push(late);
    }
    c.owners.set(rolePieceId(role, colour), to);
    // Their pending proposals with other pieces stay; proposals with this piece by someone else go.
    c.proposals = c.proposals.filter((p) => {
      const pid = c.game!.tracker.at.get(p.from as never);
      return !(pid === rolePieceId(role, colour) && p.by !== to);
    });
    this.broadcast(c);
  }

  private async resign(u: UserRow, code: string) {
    const { c, colour } = this.turnOf(u, code);
    if (!this.isKing(c, colour, u.id)) throw new Error('Only the King can surrender.');
    c.game!.resign(colour);
    await this.finish(c);
  }

  private async draw(u: UserRow, code: string) {
    const { c, colour } = this.turnOf(u, code);
    if (!this.isKing(c, colour, u.id)) throw new Error('Only the King can offer or accept a draw.');
    if (c.game!.offerDraw(colour)) return this.finish(c);
    c.drawOffer = c.game!.drawOffer;
    this.broadcast(c);
  }

  private name(c: LiveClash, colour: Colour, id: number) {
    return c.sides[colour]?.members.find((m) => m.id === id)?.name ?? 'Someone';
  }

  /** Play a move for the side to move and start the next turn. */
  private async commit(c: LiveClash, mv: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }, note: string) {
    const game = c.game!;
    const colour = game.turn;
    const pieceId = game.tracker.at.get(mv.from as never);
    const r = game.move(colour, { from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}) }, this.opts.now());
    if (!r.ok) {
      c.proposals = c.proposals.filter((p) => !(p.from === mv.from && p.to === mv.to));
      return this.broadcast(c);
    }
    const role = pieceId ? roleOfPieceId(pieceId) : null;
    c.lastNote = `${r.move.san}: ${note}${role ? ` · ${ROLE_TITLE[role]}` : ''}`;
    c.drawOffer = null;
    if (game.result) return this.finish(c);
    this.startTurn(c);
    await this.persist(c);
    this.broadcast(c);
  }

  private startTurn(c: LiveClash, endsAt?: number) {
    c.proposals = [];
    c.turnEndsAt = endsAt ?? this.opts.now() + c.turnSecs * 1000;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (this.opts.timers) c.timer = setTimeout(() => void this.timeUp(c.code), Math.max(20, c.turnEndsAt - this.opts.now()));
  }

  /** The turn timer ran out: the most-backed proposal plays, or the army acts on its own. */
  async timeUp(code: string) {
    const c = this.clashes.get(code);
    if (!c || c.status !== 'playing' || !c.game) return;
    if (c.turnEndsAt !== null && this.opts.now() < c.turnEndsAt) return this.startTurn(c, c.turnEndsAt);
    const best = [...c.proposals].sort((a, b) => b.backers.length - a.backers.length || a.id - b.id)[0];
    if (best) return this.commit(c, best, `${best.byName}'s move, backed by ${best.backers.length}`);
    const san = chooseKingdomMove(c.game.chess.fen, 'squire');
    const probe = new KingdomGame({ fen: c.game.chess.fen });
    const r = san ? probe.move(probe.turn, san, 0) : null;
    if (r?.ok) return this.commit(c, { from: r.move.from, to: r.move.to, ...(r.move.promotion ? { promotion: r.move.promotion as 'q' } : {}) }, 'nobody chose in time, so the army acted on its own');
  }

  private async finish(c: LiveClash) {
    const result = c.game!.result!;
    c.status = 'over';
    c.turnEndsAt = null;
    c.proposals = [];
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    const w = c.sides.w!;
    const b = c.sides.b!;
    const rw = await this.clusters.glicko(w.clusterId).catch(() => null);
    const rb = await this.clusters.glicko(b.clusterId).catch(() => null);
    if (rw && rb) {
      const s = result.winner === 'w' ? 1 : result.winner === 'b' ? 0 : 0.5;
      const nw = rate(rw, rb, s);
      const nb = rate(rb, rw, 1 - s);
      await this.clusters.saveResult(w.clusterId, nw, s === 1 ? 'wins' : s === 0 ? 'losses' : 'draws');
      await this.clusters.saveResult(b.clusterId, nb, s === 0 ? 'wins' : s === 1 ? 'losses' : 'draws');
      c.ratingChange = { w: { before: Math.round(rw.rating), after: Math.round(nw.rating) }, b: { before: Math.round(rb.rating), after: Math.round(nb.rating) } };
    }
    await this.persist(c);
    this.broadcast(c);
  }

  /* ---------- views and storage ---------- */

  view(c: LiveClash, viewer: UserRow | null): ClashView {
    const you = viewer ? this.sideOf(c, viewer.id) : null;
    const seats = new Set<number>();
    let watchers = 0;
    for (const k of c.conns) {
      if (k.user && this.sideOf(c, k.user.id)) seats.add(k.user.id);
      else watchers++;
    }
    const sides = (['w', 'b'] as const).map((col) => {
      const s = c.sides[col];
      return s ? { ...s, members: s.members.map((m) => ({ ...m, online: this.opts.connsOf(m.id).some((k) => k.clashes.has(c.code)) })) } : null;
    });
    return {
      code: c.code,
      status: c.status,
      turnSecs: c.turnSecs,
      target: c.targetName,
      white: sides[0]!,
      black: sides[1]!,
      moves: c.game?.history.map((m) => m.san) ?? [],
      owners: Object.fromEntries(c.owners),
      // Only your own cluster sees its proposals; the other side and spectators see the board.
      proposals: you && c.game && c.game.turn === you ? c.proposals : [],
      turnEndsAt: c.turnEndsAt,
      result: c.status === 'aborted' ? { winner: null, reason: 'cancelled' } : (c.game?.result ?? null),
      ...(c.ratingChange ? { ratingChange: c.ratingChange } : {}),
      drawOffer: c.drawOffer,
      you,
      youKing: !!(you && viewer && this.isKing(c, you, viewer.id)),
      watchers,
      lastNote: c.lastNote,
      serverNow: this.opts.now(),
    };
  }

  private broadcast(c: LiveClash) {
    for (const k of c.conns) k.send({ t: 'clash', clash: this.view(c, k.user) });
  }

  private sendTo(userId: number, c: LiveClash) {
    for (const k of c.conns) if (k.user?.id === userId) k.send({ t: 'clash', clash: this.view(c, k.user) });
  }

  private state(c: LiveClash) {
    return {
      status: c.status,
      turnSecs: c.turnSecs,
      target: c.target,
      targetName: c.targetName,
      sides: c.sides,
      moves: c.game?.history.map((m) => m.san) ?? [],
      owners: Object.fromEntries(c.owners),
      result: c.game?.result ?? null,
      ratingChange: c.ratingChange ?? null,
      lastNote: c.lastNote,
      createdAt: c.createdAt,
    };
  }

  private fromState(code: string, s: ReturnType<ClashHub['state']>): LiveClash {
    const c: LiveClash = {
      code,
      status: s.status,
      turnSecs: s.turnSecs,
      target: s.target,
      targetName: s.targetName,
      sides: s.sides,
      game: null,
      owners: new Map(Object.entries(s.owners).map(([k, v]) => [k, Number(v)])),
      proposals: [],
      nextId: 1,
      turnEndsAt: null,
      timer: null,
      conns: new Set(),
      drawOffer: null,
      lastNote: s.lastNote,
      createdAt: s.createdAt,
      ...(s.ratingChange ? { ratingChange: s.ratingChange } : {}),
    };
    if (s.status !== 'waiting') {
      const g = new KingdomGame();
      s.moves.forEach((san, i) => g.move(g.turn, san, i));
      if (s.result) g.result = s.result;
      c.game = g;
    }
    return c;
  }

  /** Bring back clashes that were open or in play when the server stopped. */
  async restore() {
    const rows = await this.db.query<{ code: string; state: string }>("select code, state from clashes where status in ('waiting','playing')");
    for (const r of rows) {
      try {
        const c = this.fromState(r.code, JSON.parse(r.state));
        this.clashes.set(c.code, c);
        if (c.status === 'playing') this.startTurn(c);
      } catch (e) {
        this.opts.log('could not restore clash', r.code, e);
      }
    }
  }

  private async persist(c: LiveClash) {
    const res = c.game?.result;
    await this.db
      .query(
        `insert into clashes(code, white, black, status, turn_secs, state, moves, winner, reason, white_before, white_after, black_before, black_after, ended_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (code) do update set white=$2, black=$3, status=$4, state=$6, moves=$7, winner=$8, reason=$9,
           white_before=$10, white_after=$11, black_before=$12, black_after=$13, ended_at=$14`,
        [
          c.code,
          c.sides.w?.clusterId ?? null,
          c.sides.b?.clusterId ?? null,
          c.status,
          c.turnSecs,
          JSON.stringify(this.state(c)),
          c.game?.history.map((m) => m.san).join(' ') ?? '',
          res ? (res.winner ?? 'draw') : null,
          res?.reason ?? null,
          c.ratingChange?.w.before ?? null,
          c.ratingChange?.w.after ?? null,
          c.ratingChange?.b.before ?? null,
          c.ratingChange?.b.after ?? null,
          c.status === 'over' || c.status === 'aborted' ? new Date(this.opts.now()) : null,
        ],
      )
      .catch((e) => this.opts.log('clash save failed', c.code, e));
  }
}
