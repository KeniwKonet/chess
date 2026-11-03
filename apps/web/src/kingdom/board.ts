/**
 * Chess Kingdom battlefield geometry: an 8x8 stone plaza centred on the
 * origin. Rank 1 (the Sun, White) is nearest +z, rank 8 (the Moon) toward -z.
 * Characters face +z in their model space; yaw rotates about Y.
 */
import type { Role } from '@cr/chess-core';

/** Width of one square, world units. */
export const SQ = 1.7;
/** Height of the plaza's top surface. */
export const BOARD_Y = 0.32;
export const FILES = 'abcdefgh';

export interface P2 {
  x: number;
  z: number;
}

export function squarePos(sq: string): P2 {
  const f = FILES.indexOf(sq[0]!);
  const r = Number(sq[1]) - 1;
  return { x: (f - 3.5) * SQ, z: (3.5 - r) * SQ };
}

/** Square under a world point, or null off the board. */
export function squareAt(x: number, z: number): string | null {
  const f = Math.floor(x / SQ + 4);
  const r = Math.floor(4 - z / SQ);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return `${FILES[f]}${r + 1}`;
}

export const isLight = (sq: string) => (FILES.indexOf(sq[0]!) + Number(sq[1])) % 2 === 1;

/** Yaw that faces from a to b. */
export const yawTo = (a: P2, b: P2) => Math.atan2(b.x - a.x, b.z - a.z);
/** Resting yaw: each army faces the other. */
export const homeYaw = (colour: 'w' | 'b') => (colour === 'w' ? Math.PI : 0);

/** Character model for each chess role (rooks are siege towers, not characters). */
export type PieceModel = 'footman' | 'raider' | 'ranger' | 'sorceress' | 'king';
export const MODEL_OF: Record<Exclude<Role, 'r'>, PieceModel> = { p: 'footman', n: 'raider', b: 'ranger', q: 'sorceress', k: 'king' };
/** Standing height of each character, world units (the king stands tallest). */
export const HEIGHT: Record<PieceModel, number> = { footman: 1.22, raider: 1.38, ranger: 1.3, sorceress: 1.38, king: 1.55 };
/** Texture (team-coloured, assets/units/<tex>_<side>.png) for each character. */
export const TEXTURE_OF: Record<PieceModel, string> = { footman: 'knight', raider: 'barbarian', ranger: 'rogue', sorceress: 'mage', king: 'knight' };

/** Game clip -> clip in pieces.glb, per character. */
export type ClipKey = 'idle' | 'walk' | 'run' | 'attack' | 'hit' | 'death' | 'cheer' | 'block' | 'leap';
const COMMON = { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', hit: 'Hit_A', death: 'Death_A', cheer: 'Cheer', block: 'Block' };
export const CLIPS: Record<PieceModel, Partial<Record<ClipKey, string>> & { idle: string }> = {
  footman: { ...COMMON, attack: '1H_Melee_Attack_Stab' },
  raider: { ...COMMON, attack: '2H_Melee_Attack_Chop', leap: 'Jump_Full_Long' },
  ranger: { ...COMMON, attack: '2H_Ranged_Shoot' },
  sorceress: { ...COMMON, attack: 'Spellcast_Shoot' },
  king: { ...COMMON, attack: '2H_Melee_Attack_Slice', walk: 'Walking_B' },
};

export const GLYPH: Record<Role, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
