/**
 * The live connection over plain HTTP, for when a host or network blocks
 * WebSockets. It behaves like the part of WebSocket that online.ts uses
 * (readyState, send, close, onopen/onmessage/onclose), so the rest of the
 * game doesn't know the difference. Server side: apps/server/src/online/relay.ts.
 */
export interface LiveSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

const SEND_BATCH = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PollSocket implements LiveSocket {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private id = '';
  private after = 0;
  private out: unknown[] = [];
  private sending = false;
  private stopped = false;
  private polling: AbortController | null = null;

  constructor(private base: string) {
    void this.start();
  }

  private async start() {
    try {
      const r = await fetch(`${this.base}/api/rt/open`, { method: 'POST', cache: 'no-store' });
      const j = (await r.json()) as { id?: string };
      if (!r.ok || !j.id) throw new Error('no session');
      if (this.stopped) return;
      this.id = j.id;
      this.readyState = 1; // OPEN
      this.onopen?.();
      void this.flush();
      void this.loop();
    } catch {
      this.end();
    }
  }

  private async loop() {
    let fails = 0;
    while (!this.stopped) {
      this.polling = new AbortController();
      const timer = setTimeout(() => this.polling?.abort(), 35_000);
      try {
        const r = await fetch(`${this.base}/api/rt/poll?id=${encodeURIComponent(this.id)}&after=${this.after}`, { cache: 'no-store', signal: this.polling.signal });
        if (r.status === 404) return this.end();
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { msgs?: { n: number; m: unknown }[]; closed?: boolean };
        for (const x of j.msgs ?? []) {
          if (x.n <= this.after) continue;
          this.after = x.n;
          if (this.stopped) return;
          this.onmessage?.({ data: JSON.stringify(x.m) });
        }
        if (j.closed) return this.end();
        fails = 0;
      } catch {
        if (this.stopped) return;
        if (++fails >= 3) return this.end();
        await sleep(1000 * fails);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    this.out.push(JSON.parse(data));
    void this.flush();
  }

  private async flush() {
    if (this.sending || !this.out.length || !this.id || this.stopped) return;
    this.sending = true;
    const batch = this.out.splice(0, SEND_BATCH);
    try {
      const r = await fetch(`${this.base}/api/rt/send?id=${encodeURIComponent(this.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgs: batch }),
      });
      if (r.status === 404) return this.end();
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      // Couldn't send: the connection is treated as dropped, and the game reconnects and catches up.
      return this.end();
    } finally {
      this.sending = false;
    }
    if (this.out.length) void this.flush();
  }

  close() {
    if (this.stopped) return;
    if (this.id) void fetch(`${this.base}/api/rt/close?id=${encodeURIComponent(this.id)}`, { method: 'POST', keepalive: true }).catch(() => {});
    this.end();
  }

  private end() {
    if (this.readyState === 3) return;
    this.stopped = true;
    this.readyState = 3; // CLOSED
    this.polling?.abort();
    this.onclose?.();
  }
}
