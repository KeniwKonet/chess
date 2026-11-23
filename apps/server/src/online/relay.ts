/**
 * The live connection over plain HTTP, for hosts that don't pass WebSockets
 * through. A browser opens a session, then keeps one long request waiting for
 * messages (`poll`) and posts its own messages (`send`). To the hub it is a
 * connection like any other.
 *
 *   POST /api/rt/open                 -> { id }
 *   GET  /api/rt/poll?id=…&after=N    -> { msgs: [{ n, m }] }  (waits up to HOLD_MS)
 *   POST /api/rt/send?id=…            body { msgs: ClientMsg[] }
 *   POST /api/rt/close?id=…
 *
 * Every message carries a number `n`; the browser sends back the last one it
 * got as `after`, and only then is it dropped, so a lost response loses nothing.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ClientMsg, ServerMsg } from '@cr/chess-core';

export const HOLD_MS = 20_000;
const IDLE_MS = 45_000; // no poll for this long: the browser has gone
const MAX_QUEUE = 1000;
export const MAX_SEND = 25;

interface HubLike<C> {
  connect(send: (m: ServerMsg) => void): C;
  receive(c: C, msg: ClientMsg): Promise<void>;
  disconnect(c: C): void | Promise<void>;
}

interface Session<C> {
  conn: C;
  queue: { n: number; m: ServerMsg }[];
  next: number;
  waiter: { res: ServerResponse; timer: NodeJS.Timeout } | null;
  seen: number;
  chain: Promise<void>;
  closed: boolean;
}

export class Relay<C> {
  readonly sessions = new Map<string, Session<C>>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private hub: HubLike<C>,
    private reply: (res: ServerResponse, body: unknown) => void,
    private onError: (e: unknown) => void,
    private now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  open(): string {
    const id = randomBytes(18).toString('base64url');
    const s: Session<C> = { conn: null as unknown as C, queue: [], next: 1, waiter: null, seen: this.now(), chain: Promise.resolve(), closed: false };
    s.conn = this.hub.connect((m) => {
      if (s.closed) return;
      s.queue.push({ n: s.next++, m });
      if (s.queue.length > MAX_QUEUE) return this.close(id); // the browser stopped reading
      this.flush(s);
    });
    this.sessions.set(id, s);
    return id;
  }

  /** Answers now if messages are waiting, else holds the response until some arrive. Returns false for an unknown session. */
  poll(id: string, after: number, res: ServerResponse): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.seen = this.now();
    s.queue = s.queue.filter((q) => q.n > after);
    if (s.waiter) this.answer(s); // one waiting request per session: the newer one wins
    if (s.queue.length) {
      this.reply(res, { msgs: s.queue });
      return true;
    }
    const timer = setTimeout(() => this.answer(s), HOLD_MS);
    s.waiter = { res, timer };
    res.on('close', () => {
      if (s.waiter?.res === res) {
        clearTimeout(s.waiter.timer);
        s.waiter = null;
      }
    });
    return true;
  }

  send(id: string, msgs: ClientMsg[]): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.seen = this.now();
    for (const msg of msgs.slice(0, MAX_SEND)) {
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') continue;
      s.chain = s.chain.then(() => (s.closed ? undefined : this.hub.receive(s.conn, msg))).catch(this.onError);
    }
    return true;
  }

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.closed = true;
    if (s.waiter) this.answer(s);
    s.chain = s.chain.then(() => this.hub.disconnect(s.conn)).catch(this.onError);
  }

  sweep() {
    const now = this.now();
    for (const [id, s] of this.sessions) if (!s.waiter && now - s.seen > IDLE_MS) this.close(id);
  }

  stop() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private flush(s: Session<C>) {
    if (s.waiter) setImmediate(() => s.waiter && this.answer(s)); // gather messages sent in the same tick
  }

  private answer(s: Session<C>) {
    const w = s.waiter;
    if (!w) return;
    s.waiter = null;
    clearTimeout(w.timer);
    s.seen = this.now();
    this.reply(w.res, { msgs: s.queue, ...(s.closed ? { closed: true } : {}) });
  }
}
