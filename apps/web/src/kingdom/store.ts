/** UI state for Chess Kingdom (the game itself lives in controller.ts, outside React). */
import { create } from 'zustand';
import type { AiLevel, Colour, KingdomResult, Role } from '@cr/chess-core';

export type Opponent = 'ai' | 'local' | 'online' | 'clash';
export type AnimSpeed = 'cinematic' | 'quick' | 'off';

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('cr-kingdom') ?? '{}') as Partial<KState>;
  } catch {
    return {};
  }
})();

export interface KState {
  screen: 'home' | 'setup' | 'online' | 'community' | 'clusters' | 'tournaments' | 'admin' | 'playing';
  opponent: Opponent;
  aiLevel: AiLevel;
  side: Colour | 'random';
  tc: string;
  flipEachTurn: boolean;
  /** Coach tips: warn when one of your soldiers can be taken (games on this device). */
  coach: boolean;
  animSpeed: AnimSpeed;
  icons: boolean;
  sound: boolean;
  /** Bumped whenever the game changes, so the HUD re-reads it. */
  rev: number;
  selected: string | null;
  targets: string[];
  promotion: { from: string; to: string } | null;
  result: KingdomResult | null;
  showResult: boolean;
  thinking: boolean;
  viewFrom: Colour;
  toast: { text: string; tone: 'info' | 'warn' | 'good'; id: number } | null;
  showMoves: boolean;
  showMenu: boolean;
  showHelp: boolean;
  /** The role whose card is shown (tapped piece or help). */
  card: { role: Role; colour: Colour } | null;
  /** The computer is working out a hint. */
  hinting: boolean;
  /** Hints used this game. */
  hints: number;
}

export const useKingdom = create<KState>(() => ({
  screen: 'home',
  opponent: 'ai',
  aiLevel: saved.aiLevel ?? 'knight',
  side: saved.side ?? 'w',
  tc: saved.tc ?? 'untimed',
  flipEachTurn: saved.flipEachTurn ?? true,
  coach: saved.coach ?? true,
  animSpeed: saved.animSpeed ?? 'cinematic',
  icons: saved.icons ?? true,
  sound: saved.sound ?? true,
  rev: 0,
  selected: null,
  targets: [],
  promotion: null,
  result: null,
  showResult: false,
  thinking: false,
  viewFrom: 'w',
  toast: null,
  showMoves: false,
  showMenu: false,
  showHelp: false,
  card: null,
  hinting: false,
  hints: 0,
}));

/** Remember preferences between visits. */
useKingdom.subscribe((s) => {
  try {
    const { aiLevel, side, tc, flipEachTurn, coach, animSpeed, icons, sound } = s;
    localStorage.setItem('cr-kingdom', JSON.stringify({ aiLevel, side, tc, flipEachTurn, coach, animSpeed, icons, sound }));
  } catch {
    /* private mode: preferences just aren't kept */
  }
});

let toastId = 0;
export function toast(text: string, tone: 'info' | 'warn' | 'good' = 'info') {
  useKingdom.setState({ toast: { text, tone, id: ++toastId } });
}
