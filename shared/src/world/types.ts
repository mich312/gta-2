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
/** River/harbour. Solid to anything on land, the only thing a boat can cross. */
export const T_WATER = 6;
/** Road carried over water. Passable on land AND by boats underneath. */
export const T_BRIDGE = 7;
/** Stunt ramp: drivable, and launches a fast car off the ground. */
export const T_RAMP = 8;
/** Shop interior floor: inside a building, walkable, open to the sky. */
export const T_FLOOR = 9;
/**
 * Embankment/quay: the walkable stone strip where land meets a waterway.
 * Open to feet and wheels, solid to boats — it is the wall a hull moors
 * against. The transition band of the water ladder (WORLDGEN.md §9.4):
 * nothing is built on it, so every waterfront reads as deliberate edge
 * rather than a building sliced off by the river.
 */
export const T_BANK = 10;

/**
 * Where a signal head stands: the road tile just outside a junction on one of
 * its arms, and the cardinal approaching traffic is travelling. See
 * sim/signals.ts.
 */
export interface SignalHead {
  x: number;
  y: number;
  dirIdx: number;
  junctionId: number;
}

/** Junction labelling and signal heads; see sim/signals.ts. */
export interface JunctionMap {
  /** Junction index per tile, row-major; -1 where there is no junction. */
  idOf: Int16Array;
  count: number;
  heads: SignalHead[];
}

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

/** Crate kinds worldgen scatters. Frenzies are placed by their own pass. */
export type PickupSpawnKind =
  | 'health'
  | 'armour'
  | 'ammo'
  | 'bribe'
  | 'jailcard'
  | 'damage'
  | 'invis'
  | 'reload';

export const LANDMARK_KINDS = ['stadium', 'power', 'tower', 'hospital', 'police'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export interface Landmark {
  kind: LandmarkKind;
  name: string;
  /** Tile rect of the structure. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Door/approach point in world px. */
  doorX: number;
  doorY: number;
}

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  district: DistrictType;
}

export type ShopKind = 'gun' | 'clothing' | 'spray' | 'clinic';

export interface Shop {
  kind: ShopKind;
  /** Sidewalk tile of the doorway zone: stand here + action to shop. */
  doorX: number;
  doorY: number;
  buildingIndex: number;
  /** The room behind the door, in tiles: walkable floor, open to the sky. */
  interior: { x: number; y: number; w: number; h: number };
  /** Tile where the doorway is punched through the shopfront wall. */
  entryX: number;
  entryY: number;
}

export interface VehicleSpawn {
  /** World px, centre. */
  x: number;
  y: number;
  heading: number;
  kind: string;
  /** Whose car it is, or 0 for anybody's. See amenities.placeParking. */
  gangId?: number;
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
  /** Kerbside points cars are spawned FROM: ambient traffic, cops, roadblocks. */
  vehicleSpawns: VehicleSpawn[];
  /** Where cars are left standing: at the kerb, out of the way of traffic. */
  parkingSpots: VehicleSpawn[];
  playerSpawns: Vec2[];
  /** Dense sidewalk points for pedestrian spawning (phase 7). */
  pedSpawns: Vec2[];
  /** Street furniture: lamp posts, bins, fences (phase 8). */
  propSpawns: Array<{ kind: string; x: number; y: number; orient: number }>;
  /** Health/armour/ammo crates (roadmap A3). */
  pickupSpawns: Array<{ kind: PickupSpawnKind; x: number; y: number }>;
  /** Moorings: open water within reach of the bank. */
  boatSpawns: VehicleSpawn[];
  /** Oversized, named buildings you can navigate by. */
  landmarks: Landmark[];
  /** Where the dead wake up. */
  hospitals: Vec2[];
  /** Where the arrested are let out. Being busted is not being killed. */
  policeStations: Vec2[];
  /** Car crushers: drive one in, leave on foot and better off. */
  cranes: Vec2[];
  /**
   * Hidden packages. Positions only — finding one is a per-ACCOUNT fact held
   * server-side, never a sim pickup, because a one-time find in a city with
   * thirty people in it is dead by the second hour. The world is shared; the
   * finding is personal. See server/src/economy/secrets.ts.
   */
  packages: Vec2[];
  /** Ringing phones: the city's way of offering you work. */
  payphones: Vec2[];
  /** Gang id per turf cell, row-major. 0 = nobody's. */
  /**
   * Junction labels, one per tile, -1 where there is none. Derived from the
   * tiles at generation time and never sent: the client generates its own
   * map from the seed, so both ends compute the same table for free.
   */
  junctions: JunctionMap;
  /**
   * Seconds in an in-game day, copied here from the worldgen params so the
   * renderer can read the clock from the map it already has rather than
   * threading a second parameter through every frame.
   */
  dayLengthSec: number;
  turfCells: Uint8Array;
  turfCellsWide: number;
  /** Turf cell size in tiles, so `gangAt` needs no tuning. */
  turfCellTiles: number;
  /** Each gang's centre of gravity, for the radar and for spawning. */
  turfHomes: Array<{ x: number; y: number; gang: number }>;
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
