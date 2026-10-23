/**
 * Low-frequency UI state only. Camera motion, hover tracking and per-frame
 * values never go through this store, so moving the camera does not re-render
 * React.
 */
import { create } from 'zustand';
import type { Pick } from '../game';

export type Quality = 'low' | 'medium' | 'high';

export interface LogEntry {
  id: number;
  t: number;
  text: string;
  tone: 'info' | 'sun' | 'moon' | 'system';
}

interface UiState {
  selected: Pick;
  hovered: Pick;
  quality: Quality;
  showPerf: boolean;
  showHelp: boolean;
  showLabels: boolean;
  edgeScroll: boolean;
  assetsFailed: boolean;
  log: LogEntry[];
  select: (p: Pick) => void;
  hover: (p: Pick) => void;
  setQuality: (q: Quality) => void;
  toggle: (k: 'showPerf' | 'showHelp' | 'showLabels' | 'edgeScroll') => void;
  setAssetsFailed: (v: boolean) => void;
  addLog: (text: string, tone?: LogEntry['tone']) => void;
}

const isMobile = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 760);

let nextId = 1;
const start = typeof performance !== 'undefined' ? performance.now() : 0;
const same = (a: Pick, b: Pick) =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind === 'building' ? a.id === (b as typeof a).id : a.key === (b as { key: string }).key));

export const useUi = create<UiState>((set) => ({
  selected: null,
  hovered: null,
  quality: isMobile ? 'medium' : 'high',
  showPerf: false,
  showHelp: false,
  showLabels: true,
  edgeScroll: false,
  assetsFailed: false,
  log: [],
  select: (p) => set((s) => (same(s.selected, p) ? s : { selected: p })),
  hover: (p) => set((s) => (same(s.hovered, p) ? s : { hovered: p })),
  setQuality: (quality) => set({ quality }),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<UiState>),
  setAssetsFailed: (assetsFailed) => set({ assetsFailed }),
  addLog: (text, tone = 'info') =>
    set((s) => ({ log: [{ id: nextId++, t: (performance.now() - start) / 1000, text, tone }, ...s.log].slice(0, 40) })),
}));

export const IS_MOBILE = isMobile;
