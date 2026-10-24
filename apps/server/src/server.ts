/**
 * WebSocket front door: one connection per player, JSON messages
 * (packages/match/src/protocol.ts). Rooms are created on demand by name.
 *
 *   ws://host:port/?room=ashen&mode=ai&difficulty=captain   play Sun against the Moon AI
 *   ws://host:port/?room=duel&mode=pvp                      two humans, Sun and Moon
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@cr/match';
import type { Difficulty, Side } from '@cr/game-core';
import { Room } from './room';

export interface ServerHandle {
  port: number;
  rooms: Map<string, Room>;
  close: () => Promise<void>;
}

const DIFFS = new Set(['recruit', 'captain', 'warlord']);
const MAX_MESSAGE = 4096;

export function startServer(port = 0, opts: { autoTick?: boolean } = {}): Promise<ServerHandle> {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE });
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
    wss.on('listening', () => {
      const addr = wss.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        rooms,
        close: () =>
          new Promise<void>((r) => {
            for (const room of rooms.values()) room.stop();
            for (const c of wss.clients) c.terminate();
            wss.close(() => r());
          }),
      });
    });
  });
}
