/**
 * Online play: the server owns the match; this mirrors its snapshots into a
 * local Sim so the renderer, HUD and minimap work unchanged. Orders and War
 * Table moves are sent to the server instead of applied locally.
 *
 * Open the game with ?server=ws://host:8787/?room=ashen%26mode=ai to play
 * against the server's Moon AI, or mode=pvp for two players.
 */
import { Sim, type Command, type Side, type SimEvent } from '@cr/game-core';
import { Match, PROTOCOL_VERSION, applySnapshot, type ClientMessage, type ServerMessage, type Snapshot, type TableEntry } from '@cr/match';
import { realm } from '../game';

export type ConnState = 'connecting' | 'open' | 'closed' | 'full';

export class RemoteMatch {
  readonly sim = new Sim(realm, []);
  /** Local replica of the War Table (board + bonds), kept in step with the server's move list. */
  private readonly replica = new Match({ realm, moonAi: false });
  side: Side = 'sun';
  state: ConnState = 'connecting';
  difficulty = 'captain';
  vsAi = true;
  readonly commander = null;
  tableMoves = [];
  lastSnapAt = 0;
  latestHash: string | undefined;
  private ws: WebSocket;
  private seq = 1;
  private thinking: number | null = null;
  /** Orders and War Table moves awaiting the server's ack. */
  private pending = new Map<number, { cmd?: Command; chess?: true }>();
  onSnapshot?: (s: Snapshot, prevTick: number) => void;
  /** Field-log events reconstructed on the client (the server sends state, not events). */
  onEvents?: (events: SimEvent[]) => void;
  /** New War Table moves, as replayed on the local board. */
  onTable?: (entry: TableEntry) => void;
  onWelcome?: () => void;
  onClose?: (reason: string) => void;

  constructor(readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.send({ t: 'hello', v: PROTOCOL_VERSION, want: 'any' });
    this.ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage);
    this.ws.onclose = () => {
      if (this.state !== 'full') this.state = 'closed';
      this.onClose?.(this.state === 'full' ? 'The battle is full' : 'Disconnected from the server');
    };
  }

  private send(m: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private receive(m: ServerMessage) {
    if (m.t === 'welcome') {
      this.side = m.side;
      this.difficulty = m.difficulty;
      this.vsAi = m.vsAi;
      this.state = 'open';
      this.onWelcome?.();
    } else if (m.t === 'full') {
      this.state = 'full';
    } else if (m.t === 'ack') {
      const p = this.pending.get(m.seq);
      this.pending.delete(m.seq);
      if (!p) return;
      const tick = this.sim.tick;
      if (!m.ok) this.onEvents?.([{ kind: 'rejected', tick, side: this.side, reason: p.chess ? `War Table: ${m.reason ?? 'move refused'}` : (m.reason ?? 'Order refused') }]);
      else if (p.cmd?.kind === 'move') this.onEvents?.([{ kind: 'order', tick, side: this.side, order: 0, ids: p.cmd.ids, x: p.cmd.x, z: p.cmd.z, attack: !!p.cmd.attack }]);
      else if (p.cmd?.kind === 'attack') this.onEvents?.([{ kind: 'attackOrder', tick, side: this.side, ids: p.cmd.ids, target: p.cmd.target }]);
      else if (p.cmd?.kind === 'stop') this.onEvents?.([{ kind: 'stopped', tick, side: this.side, ids: p.cmd.ids }]);
    } else if (m.t === 'snap') {
      const prevTick = this.sim.tick;
      // Remember what we knew, to report what changed (captures, ruins, deaths).
      const owners = new Map(this.sim.captures.map((c) => [c.id, c.owner]));
      const standing = new Set(this.sim.buildings.filter((b) => !b.destroyed).map((b) => b.id));
      const alive = new Map(this.sim.units.filter((u) => u.hp > 0).map((u) => [u.id, u]));
      const first = prevTick === 0 && !this.sim.units.length;
      applySnapshot(this.sim, m, this.side);
      if (!first) {
        const events: SimEvent[] = [];
        const tick = this.sim.tick;
        for (const c of this.sim.captures) if (owners.has(c.id) && owners.get(c.id) !== c.owner) events.push({ kind: 'captured', tick, side: c.owner, captureId: c.id });
        for (const b of this.sim.buildings) if (b.destroyed && standing.has(b.id)) events.push({ kind: 'destroyed', tick, side: b.side, buildingId: b.id, by: b.side === 'sun' ? 'moon' : 'sun' });
        for (const [id, before] of alive) {
          const now = this.sim.unit(id);
          // Our own soldiers are always sent, so a missing one died; enemies only count if seen falling.
          if ((now && now.hp <= 0) || (!now && before.side === this.side)) {
            events.push({ kind: 'killed', tick, side: before.side, id, type: before.type, by: before.side === 'sun' ? 'moon' : 'sun', x: before.x, z: before.z });
          }
        }
        if (events.length) this.onEvents?.(events);
      }
      this.thinking = m.table.thinking;
      if (m.hash) this.latestHash = m.hash;
      // Replay any new War Table moves on the local board so piece identities stay in step.
      const wt = this.replica.warTable;
      for (const e of m.table.log.slice(wt.log.length)) {
        const r = wt.play(e.side, e.san);
        if (r.ok) this.onTable?.(r.entry);
      }
      this.lastSnapAt = performance.now();
      this.onSnapshot?.(m, prevTick);
    }
  }

  /** Orders go to the server; it stamps them with our side. */
  issue(cmd: Command) {
    const { side: _ignored, ...rest } = cmd as Command & { side: Side };
    void _ignored;
    const seq = this.seq++;
    this.pending.set(seq, { cmd });
    this.send({ t: 'cmd', seq, cmd: rest as never });
  }

  step() {
    return [];
  }

  playChess(_side: Side, move: string | { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }) {
    const seq = this.seq++;
    this.pending.set(seq, { chess: true });
    this.send({ t: 'chess', seq, move });
    return { ok: false as const, reason: 'Sent to the server' };
  }

  /** War Table view for the HUD: the replica's board and bonds, liveness from the mirror. */
  get warTable() {
    const wt = this.replica.warTable;
    const sim = this.sim;
    const thinking = this.thinking;
    return {
      game: wt.game,
      bonds: wt.bonds,
      log: wt.log,
      live: {
        unitAlive: (id: number) => (sim.unit(id)?.hp ?? 1) > 0, // unseen enemy soldiers are assumed alive
        buildingStanding: (id: string) => !sim.building(id)?.destroyed,
      },
      get turn() {
        return wt.turn;
      },
      get over() {
        return wt.game.outcome().over || !!sim.winner;
      },
      targets: (from: string) => wt.targets(from),
      thinkingLeft: () => thinking,
      summary: () => wt.summary(),
    };
  }

  close() {
    this.ws.close();
  }
}

/** The server URL from ?server=..., if the page was opened for online play. */
export function serverUrlFromPage(): string | null {
  if (typeof location === 'undefined') return null;
  const s = new URLSearchParams(location.search).get('server');
  return s && /^wss?:\/\//.test(s) ? s : null;
}
