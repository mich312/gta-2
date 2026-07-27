import type { Vec2 } from '../math/vec.js';

/** World-unit size of one tile (px). */
export const TILE_SIZE = 16;

// Tile types (Uint8Array values).
export const T_FIELD = 0;
export const T_ROAD = 1;
export const T_SIDEWALK = 2;
export const T_BUILDING = 3;
export const T_PARK = 4;
/** Industrial yard: concrete, walkable. */
export const T_LOT = 5;

export const DISTRICT_TYPES = [
  'downtown',
  'residential',
  'industrial',
  'commercial',
  'park',
] as const;
export type DistrictType = (typeof DISTRICT_TYPES)[number];

export interface BlockRect {
  x: number;
  y: number;
  w: number;
  h: number;
  district: DistrictType;
}

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  district: DistrictType;
}

export type ShopKind = 'gun' | 'clothing';

export interface Shop {
  kind: ShopKind;
  /** Sidewalk tile of the doorway zone: stand here + action to shop. */
  doorX: number;
  doorY: number;
  buildingIndex: number;
}

export interface VehicleSpawn {
  /** World px, centre. */
  x: number;
  y: number;
  heading: number;
  kind: string;
}

/**
 * The generated city: a pure function of (seed, params), regenerated
 * identically on server and client. Never transmitted, never mutated.
 */
export interface CityMap {
  seed: number;
  widthTiles: number;
  heightTiles: number;
  widthPx: number;
  heightPx: number;
  /** Tile type per cell, row-major. */
  tiles: Uint8Array;
  /** District index (into DISTRICT_TYPES) per cell, row-major. */
  district: Uint8Array;
  blocks: BlockRect[];
  buildings: Building[];
  shops: Shop[];
  vehicleSpawns: VehicleSpawn[];
  playerSpawns: Vec2[];
  /** Dense sidewalk points for pedestrian spawning (phase 7). */
  pedSpawns: Vec2[];
  /** Street furniture: lamp posts, bins, fences (phase 8). */
  propSpawns: Array<{ kind: string; x: number; y: number; orient: number }>;
  /** Health/armour/ammo crates (roadmap A3). */
  pickupSpawns: Array<{ kind: 'health' | 'armour' | 'ammo'; x: number; y: number }>;
}

export function tileIndex(map: CityMap, tx: number, ty: number): number {
  return ty * map.widthTiles + tx;
}

export function tileAt(map: CityMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return T_BUILDING;
  return map.tiles[ty * map.widthTiles + tx] as number;
}

export function districtAt(map: CityMap, tx: number, ty: number): DistrictType {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return 'downtown';
  return DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as DistrictType;
}
