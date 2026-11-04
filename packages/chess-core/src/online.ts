/**
 * Online play: the messages between the game in the browser and the ChessFront
 * server (apps/server/src/online). The server referees every game: it checks
 * each move with KingdomGame, runs the clocks and records the result, so a
 * modified browser cannot cheat the rules or the time.
 *
 * HTTP (JSON, `Authorization: Bearer <token>`) handles accounts and lists;
 * one WebSocket at /online carries everything about games.
 */
import type { Colour } from './index';

export type RatingCategory = 'blitz' | 'rapid';

/** Time controls offered online. Untimed games are always casual. */
export const ONLINE_TIME_CONTROLS = ['3+2', '5+3', '10+5', '15+10', 'untimed'] as const;
export type OnlineTc = (typeof ONLINE_TIME_CONTROLS)[number];

export const ratingCategory = (tc: string): RatingCategory | null =>
  tc === '3+2' || tc === '5+3' ? 'blitz' : tc === '10+5' || tc === '15+10' ? 'rapid' : null;

/** Rules for names people choose. */
export const NAME_RULE = /^[A-Za-z0-9_-]{3,20}$/;
export const PASSWORD_MIN = 8;

/** Online timings (ms). */
export const ONLINE_TIMING = {
  /** Each side must make its first move within this, or the game is called off. */
  firstMove: 30_000,
  /** After a player has been away this long, the opponent may claim the win (or the game is called off if nobody has moved twice). */
  abandon: 60_000,
  /** An unanswered invite link stays open this long. */
  inviteTtl: 24 * 60 * 60_000,
} as const;

export interface Rating {
  rating: number;
  /** Rating deviation: how sure the rating is (high = provisional). */
  rd: number;
  games: number;
}

export interface PublicUser {
  id: number;
  name: string;
  guest: boolean;
  ratings: Record<RatingCategory, Rating>;
  /** Games, wins, losses, draws (all finished online games). */
  record?: { games: number; wins: number; losses: number; draws: number };
}

export interface SeatInfo {
  id: number;
  name: string;
  guest: boolean;
  /** Rating for this game's category (rounded); null in untimed games. */
  rating: number | null;
  provisional: boolean;
}

export type GameStatus = 'waiting' | 'playing' | 'over' | 'aborted';

export interface GameView {
  code: string;
  tc: OnlineTc;
  rated: boolean;
  status: GameStatus;
  white: SeatInfo | null;
  black: SeatInfo | null;
  /** Who made the game and the colour they chose (while waiting for an opponent). */
  creator?: SeatInfo;
  creatorColour?: Colour | 'random';
  /** Moves so far, in SAN. */
  moves: string[];
  /** Time left (ms) for each side at the moment of sending; null when untimed. */
  clocks: Record<Colour, number> | null;
  /** Whose clock is running, if any. */
  running: Colour | null;
  result: { winner: Colour | null; reason: string } | null;
  drawOffer: Colour | null;
  /** Your seat in this game, or null when watching. */
  you: Colour | null;
  presence: Presence;
  /** Rating changes, once a rated game ends. */
  ratingChange?: Record<Colour, { before: number; after: number }>;
  /** Code of the rematch, once both agreed. */
  rematchOf?: string;
  rematchOffer?: Colour | null;
  /** Server time (ms since epoch) this was sent. */
  serverNow: number;
}

export interface Presence {
  w: boolean;
  b: boolean;
  watchers: number;
  /** When a player left (server ms), while they are away. */
  awaySince: Partial<Record<Colour, number>>;
}

export interface LiveGame {
  code: string;
  tc: OnlineTc;
  rated: boolean;
  white: SeatInfo;
  black: SeatInfo;
  moves: number;
  watchers: number;
}

export interface GameRecord {
  code: string;
  tc: OnlineTc;
  rated: boolean;
  status: GameStatus;
  white: SeatInfo | null;
  black: SeatInfo | null;
  moves: string[];
  result: { winner: Colour | null; reason: string } | null;
  ratingChange?: Record<Colour, { before: number; after: number }>;
  endedAt: number | null;
}

/* Browser -> server */
export type ClientMsg =
  | { t: 'auth'; token: string }
  | { t: 'invite'; tc: OnlineTc; colour: Colour | 'random'; rated: boolean }
  | { t: 'seek'; tc: OnlineTc; rated: boolean }
  | { t: 'cancel' }
  | { t: 'join'; code: string }
  | { t: 'watch'; code: string }
  | { t: 'leave'; code: string }
  | { t: 'move'; code: string; ply: number; move: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } }
  | { t: 'resign'; code: string }
  | { t: 'draw'; code: string }
  | { t: 'decline'; code: string }
  | { t: 'abort'; code: string }
  | { t: 'claim'; code: string }
  | { t: 'rematch'; code: string }
  | { t: 'ping'; at: number };

/* Server -> browser */
export type ServerMsg =
  | { t: 'ready'; user: PublicUser }
  | { t: 'invited'; code: string }
  | { t: 'seeking'; tc: OnlineTc; rated: boolean; waiting: number }
  | { t: 'cancelled' }
  | { t: 'game'; game: GameView }
  | { t: 'move'; code: string; ply: number; san: string; clocks: Record<Colour, number> | null; running: Colour | null; serverNow: number }
  | { t: 'end'; code: string; result: { winner: Colour | null; reason: string }; status: GameStatus; ratingChange?: Record<Colour, { before: number; after: number }> }
  | { t: 'offer'; code: string; drawOffer: Colour | null }
  | { t: 'presence'; code: string; presence: Presence }
  | { t: 'rematch'; code: string; by: Colour | null; next?: string }
  | { t: 'error'; message: string; code?: string }
  | { t: 'pong'; at: number; serverNow: number };

export const onlineResultText = (reason: string, winner: Colour | null, names: Record<Colour, string>, status: GameStatus = 'over'): string => {
  if (status === 'aborted') return 'Game called off. No result, no rating change.';
  const w = winner ? names[winner] : '';
  const l = winner ? names[winner === 'w' ? 'b' : 'w'] : '';
  switch (reason) {
    case 'checkmate':
      return `Checkmate. ${w} wins.`;
    case 'resignation':
      return `${l} resigned. ${w} wins.`;
    case 'timeout':
      return `${l} ran out of time. ${w} wins.`;
    case 'abandoned':
      return `${l} left the battle. ${w} wins.`;
    case 'stalemate':
      return 'Stalemate. A draw.';
    case 'insufficient':
      return 'Neither side can checkmate. A draw.';
    case 'threefold':
      return 'The same position three times. A draw.';
    case 'fifty-move':
      return 'Fifty moves without a capture or a Footman move. A draw.';
    case 'agreement':
      return 'Draw agreed.';
    default:
      return winner ? `${w} wins.` : 'A draw.';
  }
};
