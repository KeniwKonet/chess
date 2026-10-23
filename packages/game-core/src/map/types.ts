import type { Hex } from '../hex';

export type Side = 'sun' | 'moon';
export type Owner = Side | 'neutral';

export type Terrain = 'grass' | 'forest' | 'hill' | 'mountain' | 'field' | 'water';

export type BuildingType =
  | 'castle'
  | 'barracks'
  | 'archery'
  | 'stable'
  | 'farm'
  | 'mine'
  | 'lumber'
  | 'forge'
  | 'workshop'
  | 'tower'
  | 'site'
  | 'rubble'
  | 'watchtower'
  | 'village'
  | 'home'
  | 'market';

/** A model placed on a tile. `model` is a key in the asset kit (see apps/web asset manifest). */
export interface Prop {
  model: string;
  /** Offset from tile centre in world units. */
  dx: number;
  dz: number;
  rotY: number;
  scale: number;
}

export interface Cell extends Hex {
  terrain: Terrain;
  river: boolean;
  road: boolean;
  /** River cell with a bridge over it. */
  bridge: boolean;
  /** River cell shallow enough to wade. */
  ford: boolean;
  /** For bridges and fords: the edge the road leaves by (it enters by the opposite edge). */
  crossEdge?: number;
  /** Building occupying the tile, by id. */
  building?: string;
  /** Inner ground of a kingdom (castle grounds). Kept free of forest. */
  grounds?: Side;
  /** Decorative and blocking props (trees, rocks, hills). */
  props: Prop[];
  /** Resolved tile art for river/road cells: variant + rotation steps. */
  tile?: { kind: 'river' | 'road'; variant: string; steps: number; approximate: boolean };
}

export interface Building {
  id: string;
  side: Owner;
  type: BuildingType;
  name: string;
  q: number;
  r: number;
  /** Visual scale relative to one tile. */
  scale: number;
  rotY: number;
  maxHp: number;
  hp: number;
  /** Construction progress 0..100 for sites, otherwise undefined. */
  progress?: number;
  /** Capture point id if this building anchors one. */
  capture?: string;
}

export interface Place {
  id: string;
  name: string;
  q: number;
  r: number;
  kind: 'crossing' | 'capture' | 'region' | 'capital';
}

export interface CapturePoint {
  id: string;
  name: string;
  q: number;
  r: number;
  /** Radius in hexes. */
  radius: number;
  owner: Owner;
}

export interface Resources {
  gold: number;
  food: number;
  wood: number;
  iron: number;
}

export interface RealmMap {
  seed: number;
  cols: number;
  rows: number;
  /** Land cells only; anything not listed is open sea. */
  cells: Cell[];
  buildings: Building[];
  places: Place[];
  captures: CapturePoint[];
  /** World-space bounds of the land, for camera clamping. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}
