/**
 * The ChessFront server: one HTTP port carrying
 *   - online chess play: the /api JSON routes and the /online socket (src/online);
 *   - the real-time battle mode's socket on every other path, one connection
 *     per player, JSON messages (packages/match/src/protocol.ts):
 *       ws://host:port/?room=ashen&mode=ai&difficulty=captain   play Sun against the Moon AI
 *       ws://host:port/?room=duel&mode=pvp                      two humans, Sun and Moon
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { startOnline, type Online, type OnlineOptions } from './online';
import type { HubOptions } from './online/hub';
import type { ClientMessage, ServerMessage } from '@cr/match';
import type { Difficulty, Side } from '@cr/game-core';
import { Room } from './room';

export interface ServerHandle {
  port: number;
  rooms: Map<string, Room>;
  online: Online | null;
  close: () => Promise<void>;
}

export interface ServerOptions {
  autoTick?: boolean;
  /** Turn on online chess (default true). */
  online?: boolean;
  /** Postgres URL; otherwise an embedded database in dataDir ('memory://' in tests). */
  dbUrl?: string;
  dataDir?: string;
  hub?: HubOptions;
  mailer?: OnlineOptions['mailer'];
  roundBreakMs?: number;
}

const DIFFS = new Set(['recruit', 'captain', 'warlord']);
const MAX_MESSAGE = 4096;

export async function startServer(port = 0, opts: ServerOptions = {}): Promise<ServerHandle> {
  const rooms = new Map<string, Room>();
  const http = createServer((req, res) => {
    if (online?.handleHttp(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ChessFront server. The game lives at https://chessfront.app\n');
  });
  const online = opts.online === false ? null : await startOnline(http, { dbUrl: opts.dbUrl, dataDir: opts.dataDir, hub: opts.hub, mailer: opts.mailer, roundBreakMs: opts.roundBreakMs });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '/').split('?')[0] === '/online' && online) return; // handled by online play
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const id = (url.searchParams.get('room') ?? 'ashen').slice(0, 40);
    const pvp = url.searchParams.get('mode') === 'pvp';
    const d = url.searchParams.get('difficulty') ?? 'captain';
    const difficulty = (DIFFS.has(d) ? d : 'captain') as Difficulty;
    let room = rooms.get(id);
    if (!room) {
      room = new Room(id, difficulty, !pvp);
      rooms.set(id, room);
      if (opts.autoTick !== false) room.start();
    }
    const send = (m: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    let side: Side | null = null;
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!side) {
        if (msg.t !== 'hello') return;
        side = room!.join(msg.want === 'sun' || msg.want === 'moon' ? msg.want : 'any', send);
        if (!side) {
          send({ t: 'full', reason: 'Both seats are taken' });
          ws.close();
        }
        return;
      }
      room!.receive(side, msg);
    });
    ws.on('close', () => {
      if (side) room!.leave(side);
      if (room!.seats.size === 0) {
        room!.stop();
        rooms.delete(id);
      }
    });
  });
  return new Promise((resolve) => {
    http.listen(port, () => {
      const addr = http.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        rooms,
        online,
        close: async () => {
          for (const room of rooms.values()) room.stop();
          for (const c of wss.clients) c.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          await online?.close();
          http.closeAllConnections();
          await new Promise<void>((r) => http.close(() => r()));
        },
      });
    });
  });
}
