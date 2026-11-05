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
  record?: { games: number; wins: number; losses: number; draws: number; streak: number; bestStreak: number };
  bio?: string;
  /** ISO 3166 two-letter country code, or ''. */
  country?: string;
  /** Path of the profile picture on the server, or null. */
  avatar?: string | null;
  admin?: boolean;
  joined?: number;
  /** Only in your own account. */
  email?: string | null;
}

export interface Notification {
  id: number;
  kind: 'friend-request' | 'friend' | 'challenge' | 'cluster' | 'tournament' | 'announcement' | 'account';
  text: string;
  /** What the notification links to, e.g. { code } for a game or { tournament } for a tournament. */
  data: Record<string, unknown>;
  read: boolean;
  at: number;
}

export interface FriendInfo {
  id: number;
  name: string;
  /** friend, or a request you sent / received. */
  status: 'friend' | 'sent' | 'received';
  online: boolean;
  rating: number;
  avatar: string | null;
  /** Your score against them. */
  h2h: HeadToHead;
}

export interface HeadToHead {
  wins: number;
  losses: number;
  draws: number;
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

/* ---------------------------------------------------------------- table talk */

/** Emoji the two players can throw at each other during a game (a fixed set, so nothing needs moderating). */
export const REACTIONS = ['👍', '👏', '😂', '😮', '😅', '🔥', '🧠', '😤', '🤝', '👑'] as const;
export type Reaction = (typeof REACTIONS)[number];

/**
 * Voice chat between the two players: the server only relays these, the
 * audio itself goes straight between the browsers (WebRTC). White makes the
 * offer once both have switched voice on; the descriptions carry all their
 * network candidates, so one offer and one answer are enough.
 */
export type VoiceSignal =
  | { kind: 'on'; on: boolean; muted?: boolean }
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string };

/* Browser -> server */
export type ClientMsg =
  | ClashMsg
  | { t: 'react'; code: string; emoji: string }
  | { t: 'voice'; code: string; signal: VoiceSignal }
  | { t: 'auth'; token: string }
  | { t: 'challenge'; to: string; tc: OnlineTc; colour: Colour | 'random'; rated: boolean }
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
  | ClashServerMsg
  | { t: 'ready'; user: PublicUser; unread?: number }
  | { t: 'notify'; note: Notification }
  | { t: 'tournament-game'; tournament: string; code: string }
  | { t: 'invited'; code: string }
  | { t: 'seeking'; tc: OnlineTc; rated: boolean; waiting: number }
  | { t: 'cancelled' }
  | { t: 'game'; game: GameView }
  | { t: 'move'; code: string; ply: number; san: string; clocks: Record<Colour, number> | null; running: Colour | null; serverNow: number }
  | {
      t: 'end';
      code: string;
      result: { winner: Colour | null; reason: string };
      status: GameStatus;
      ratingChange?: Record<Colour, { before: number; after: number }>;
      /** Each player's win streak after this game. */
      streaks?: Record<Colour, number>;
      /** All finished games between these two, from White's side. */
      h2h?: HeadToHead;
    }
  | { t: 'offer'; code: string; drawOffer: Colour | null }
  | { t: 'presence'; code: string; presence: Presence }
  | { t: 'rematch'; code: string; by: Colour | null; next?: string }
  | { t: 'react'; code: string; by: Colour; emoji: Reaction }
  | { t: 'voice'; code: string; from: Colour; signal: VoiceSignal }
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

/* ---------------------------------------------------------------- clusters */

/**
 * A cluster is a team that fights as one army: each member holds a chess role
 * and moves that piece in a Clash of Clusters. Sixteen roles make a full army.
 */
export const CLUSTER_ROLES = ['k', 'q', 'r1', 'r2', 'b1', 'b2', 'n1', 'n2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const;
export type ClusterRole = (typeof CLUSTER_ROLES)[number];
export type MemberStatus = 'member' | 'sub' | 'spectator' | 'pending';

const ROLE_FILE: Record<ClusterRole, string> = {
  k: 'e', q: 'd', r1: 'a', r2: 'h', b1: 'c', b2: 'f', n1: 'b', n2: 'g',
  p1: 'a', p2: 'b', p3: 'c', p4: 'd', p5: 'e', p6: 'f', p7: 'g', p8: 'h',
};

/** Starting square of a role's piece for a side. */
export const roleSquare = (role: ClusterRole, colour: Colour): string => `${ROLE_FILE[role]}${role.startsWith('p') ? (colour === 'w' ? 2 : 7) : colour === 'w' ? 1 : 8}`;

/** The PieceTracker id of a role's piece (stable through the game, even after promotion). */
export const rolePieceId = (role: ClusterRole, colour: Colour): string => `${colour}-${role[0] === 'k' ? 'k' : role[0]}-${roleSquare(role, colour)}`;

/** The role whose piece has this tracker id. */
export const roleOfPieceId = (id: string): ClusterRole | null => {
  const [, , sq] = id.split('-');
  if (!sq) return null;
  return CLUSTER_ROLES.find((r) => roleSquare(r, id[0] as Colour) === sq) ?? null;
};

export const ROLE_TITLE: Record<ClusterRole, string> = {
  k: 'King', q: 'Sorceress', r1: 'Siege Tower (a)', r2: 'Siege Tower (h)', b1: 'Ranger (c)', b2: 'Ranger (f)', n1: 'Raider (b)', n2: 'Raider (g)',
  p1: 'Footman (a)', p2: 'Footman (b)', p3: 'Footman (c)', p4: 'Footman (d)', p5: 'Footman (e)', p6: 'Footman (f)', p7: 'Footman (g)', p8: 'Footman (h)',
};

export interface ClusterMember {
  id: number;
  name: string;
  status: MemberStatus;
  role: ClusterRole | null;
  /** Best of the member's Blitz and Rapid ratings. */
  rating: number;
  online?: boolean;
}

export interface ClusterSummary {
  id: number;
  name: string;
  motto: string;
  king: string;
  members: number;
  /** Joint power: the sum of the members' ratings. */
  power: number;
  rating: number;
  provisional: boolean;
  record: { clashes: number; wins: number; losses: number; draws: number };
}

export interface ClusterDetail extends ClusterSummary {
  roster: ClusterMember[];
  /** Your place in this cluster, if any. */
  you: { status: MemberStatus; role: ClusterRole | null; king: boolean } | null;
  recent: ClashRecord[];
}

export interface ClashRecord {
  code: string;
  white: string | null;
  black: string | null;
  winner: Colour | 'draw' | null;
  reason: string | null;
  moves: number;
  endedAt: number | null;
}

/* ---------------------------------------------------------------- Clash of Clusters */

export const CLASH_TURN_SECS = [30, 60, 120] as const;

export interface ClashSide {
  clusterId: number;
  name: string;
  kingId: number;
  rating: number;
  members: ClusterMember[];
}

export interface ClashProposal {
  id: number;
  by: number;
  byName: string;
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
  san: string;
  /** User ids backing this move (the proposer backs it). */
  backers: number[];
}

export interface ClashView {
  code: string;
  status: 'waiting' | 'playing' | 'over' | 'aborted';
  turnSecs: number;
  /** The cluster this challenge is for (while waiting), or null if any cluster may accept. */
  target: string | null;
  white: ClashSide | null;
  black: ClashSide | null;
  moves: string[];
  /** Who moves each piece: tracker id -> user id. */
  owners: Record<string, number>;
  proposals: ClashProposal[];
  /** When the side to move must have chosen (server ms). */
  turnEndsAt: number | null;
  result: { winner: Colour | null; reason: string } | null;
  ratingChange?: Record<Colour, { before: number; after: number }>;
  drawOffer: Colour | null;
  /** Your side, if you are in one of the clusters. */
  you: Colour | null;
  youKing: boolean;
  watchers: number;
  /** A note on the last move ("Ada's Raider, chosen by the King"). */
  lastNote: string | null;
  serverNow: number;
}

export type ClashMsg =
  | { t: 'clash-create'; turnSecs: number; target?: string }
  | { t: 'clash-accept'; code: string }
  | { t: 'clash-open'; code: string }
  | { t: 'clash-propose'; code: string; ply: number; move: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } }
  | { t: 'clash-back'; code: string; id: number }
  | { t: 'clash-play'; code: string; id: number }
  | { t: 'clash-assign'; code: string; role: ClusterRole; to: number }
  | { t: 'clash-resign'; code: string }
  | { t: 'clash-draw'; code: string }
  | { t: 'clash-cancel'; code: string }
  | { t: 'clash-list' };

export type ClashServerMsg =
  | { t: 'clash'; clash: ClashView }
  | { t: 'clash-created'; code: string }
  | { t: 'clash-challenges'; open: { code: string; from: string; fromRating: number; turnSecs: number; target: string | null }[]; live: { code: string; white: string; black: string; moves: number }[] };

/* ---------------------------------------------------------------- tournaments */

export type TournamentKind = 'swiss' | 'knockout';
export type TournamentStatus = 'open' | 'running' | 'finished' | 'cancelled';

export interface TournamentSummary {
  slug: string;
  name: string;
  kind: TournamentKind;
  tc: OnlineTc;
  rated: boolean;
  status: TournamentStatus;
  players: number;
  maxPlayers: number;
  rounds: number;
  currentRound: number;
  startsAt: number | null;
  createdBy: string | null;
  featured: boolean;
  winner: string | null;
}

export interface StandingRow {
  rank: number;
  id: number;
  name: string;
  rating: number;
  score: number;
  /** Sum of opponents' scores (Swiss tiebreak). */
  buchholz: number;
  /** Sonneborn-Berger tiebreak. */
  sb: number;
  wins: number;
  played: number;
  withdrawn: boolean;
  eliminated: boolean;
}

export interface TournamentGame {
  board: number;
  /** 0 for the game itself; 1, 2 … for replays after a draw in a knockout. */
  replay: number;
  white: { id: number; name: string } | null;
  black: { id: number; name: string } | null;
  /** '1-0', '0-1', '1/2', 'bye', or null while in play. */
  result: string | null;
  reason: string | null;
  code: string | null;
}

export interface TournamentDetail extends TournamentSummary {
  description: string;
  standings: StandingRow[];
  /** Every round's games. */
  schedule: { round: number; games: TournamentGame[] }[];
  you: { joined: boolean; creator: boolean; admin: boolean; game: string | null } | null;
}
