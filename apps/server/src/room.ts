/**
 * One battle on the server: the authoritative Match plus its connected
 * players. The server alone advances the simulation; clients only send
 * intents, which are stamped with their own side before the sim sees them.
 */
import { Match, PROTOCOL_VERSION, snapshotFor, type ClientMessage, type ServerMessage } from '@cr/match';
import { TICK_HZ, type Command, type Difficulty, type Side } from '@cr/game-core';

export interface Seat {
  side: Side;
  send: (m: ServerMessage) => void;
  /** Commands accepted in the current one-second window (rate limit). */
  window: { start: number; count: number };
}

/** Most intents a client may send per second; extra ones are refused. */
export const RATE_LIMIT = 20;

export class Room {
  readonly match: Match;
  readonly seats = new Map<Side, Seat>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly log: { tick: number; side: Side; msg: ClientMessage }[] = [];

  constructor(
    readonly id: string,
    readonly difficulty: Difficulty = 'captain',
    /** Fill an empty Moon seat with the AI (single human). */
    readonly vsAi = true,
  ) {
    this.match = new Match({ difficulty, moonAi: vsAi });
  }

  /** Seat a client; returns its side, or null if the room is full. */
  join(want: Side | 'any', send: Seat['send']): Side | null {
    const free: Side[] = this.vsAi ? ['sun'] : ['sun', 'moon'];
    const side = want !== 'any' && free.includes(want) && !this.seats.has(want) ? want : free.find((s) => !this.seats.has(s));
    if (!side) return null;
    this.seats.set(side, { side, send, window: { start: 0, count: 0 } });
    send({ t: 'welcome', v: PROTOCOL_VERSION, side, room: this.id, difficulty: this.difficulty, vsAi: this.vsAi });
    send(snapshotFor(this.match, side));
    return side;
  }

  leave(side: Side) {
    this.seats.delete(side);
  }

  /** Handle one message from the client in `side`'s seat. Never trusts the client's idea of its side. */
  receive(side: Side, msg: ClientMessage, now = Date.now()) {
    const seat = this.seats.get(side);
    if (!seat) return;
    if (msg.t === 'ping') return seat.send({ t: 'pong', n: msg.n });
    if (msg.t === 'hello') return;
    if (now - seat.window.start >= 1000) seat.window = { start: now, count: 0 };
    if (++seat.window.count > RATE_LIMIT) return seat.send({ t: 'ack', seq: msg.seq, ok: false, reason: 'Too many orders: slow down' });
    this.log.push({ tick: this.match.sim.tick, side, msg });
    if (msg.t === 'cmd') {
      if (!isCommand(msg.cmd)) return seat.send({ t: 'ack', seq: msg.seq, ok: false, reason: 'Malformed order' });
      // The side always comes from the seat, never from the client.
      this.match.issue({ ...msg.cmd, side } as Command);
      return seat.send({ t: 'ack', seq: msg.seq, ok: true });
    }
    if (msg.t === 'chess') {
      const r = this.match.playChess(side, msg.move);
      return seat.send(r.ok ? { t: 'ack', seq: msg.seq, ok: true } : { t: 'ack', seq: msg.seq, ok: false, reason: r.reason });
    }
  }

  /** Advance one tick and send each seat its fog-filtered snapshot. */
  tick() {
    this.match.step();
    for (const seat of this.seats.values()) seat.send(snapshotFor(this.match, seat.side));
  }

  start() {
    this.timer ??= setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Shape check for client commands (the sim re-validates ownership and targets). */
function isCommand(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  const ids = Array.isArray(o.ids) && o.ids.length <= 64 && o.ids.every((n) => Number.isInteger(n));
  switch (o.kind) {
    case 'move':
      return ids && Number.isFinite(o.x) && Number.isFinite(o.z);
    case 'stop':
      return ids;
    case 'attack': {
      const t = o.target as Record<string, unknown> | undefined;
      return ids && !!t && ((t.kind === 'unit' && Number.isInteger(t.id)) || (t.kind === 'building' && typeof t.id === 'string'));
    }
    default:
      // 'effect' commands come only from the War Table on the server, never from clients.
      return false;
  }
}
