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
 * Forest canopy: countryside tree cover. Solid to everything on land, like
 * a building — woods are obstacles you drive around and lanes thread
 * through — and painted as canopy rather than wall.
 */
export const T_TREES = 11;
/**
 * Beach: where land meets water outside the city. Walkable, drivable,
 * solid to hulls; the countryside's answer to the urban quay.
 */
export const T_SAND = 12;
/**
 * Runway: the one surface an aeroplane can leave the ground from.
 *
 * Drivable like a lot, and deliberately its own type rather than a marked-up
 * `T_LOT` — "is this ground built for taking off" is a question the sim asks
 * every tick a plane is rolling, and answering it by looking for paint would
 * be a rule about the renderer.
 */
export const T_RUNWAY = 13;

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
  /**
   * Open country: lane-scale subdivision, no sidewalk ring, meadow-and-forest
   * fill instead of an urban block interior.
   */
  rural?: boolean;
  /**
   * How solidly this block's borough is built up, 0..1. Drives how often the
   * street frontage is allowed to break — a downtown wall barely does, a
   * suburb is mostly gaps.
   */
  density?: number;
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

export const LANDMARK_KINDS = [
  'stadium',
  'power',
  'tower',
  'hospital',
  'police',
  // Rural destinations (WORLDGEN.md §11.1 A3): the countryside's reasons
  // to drive through it, named and on the radar like any landmark.
  'farm',
  'campground',
  'lighthouse',
  'quarry',
  /**
   * A strip of tarmac in open country with something parked on it. The one
   * place on the map an aeroplane can leave the ground from, which is what
   * makes it a destination rather than scenery. See GTA.md S2.
   */
  'airstrip',
  /**
   * Deliberate plazas (WORLDGEN.md §13.6 step 7). The signal pass already
   * refuses to signalise a big patch of junction and calls it a plaza;
   * these are the plazas made ON PURPOSE — named, navigated by, fought
   * over. `square` is paved, `green` is grass, and `circus` stands a
   * monument in the ring road's median for the traffic to swing around.
   * Streets are allowed to flow straight through all three: that is what
   * makes a square a square rather than a courtyard.
   */
  'square',
  'green',
  'circus',
] as const;
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

export type ShopKind =
  | 'gun'
  | 'clothing'
  | 'spray'
  | 'clinic'
  /**
   * The proving ground: a debug room that hands out vehicles and kit for
   * nothing. Only ever present when `WorldgenParams.provingGround` is on.
   */
  | 'depot';

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
  /**
   * Which of the ten body colours this one wears, or undefined for "whatever
   * the entity id says". Set for kerbside parking, where the colour is a fact
   * about the place and has to survive the window moving — see
   * `amenities.placeParking`.
   */
  paint?: number;
  /**
   * The kerb's guess about the street direction cannot be trusted here — a
   * stair step of a curved arterial, where a car parked by that guess sits
   * crosswise in the middle of the carriageway. The spot stays in the list
   * so that everything keyed to spot COUNT and ORDER (the parked-fleet
   * ranking, the police wave staging) is undisturbed; the session simply
   * does not stand a car on it. See `amenities.axisCarriageway`.
   */
  crosswise?: boolean;
}

/**
 * The city, loaded from the baked plan and dressed for one session. The
 * ground is identical on every host because it is the same bytes; only the
 * furniture (parked cars, crates, packages, turf) is a function of the seed.
 * Never transmitted.
 */
export interface CityMap {
  seed: number;
  /** What the city is called. Authored in the plan. */
  name: string;
  widthTiles: number;
  heightTiles: number;
  widthPx: number;
  heightPx: number;
  /** Tile type per cell, row-major. */
  tiles: Uint8Array;
  /** District index (into DISTRICT_TYPES) per cell, row-major. */
  district: Uint8Array;
  /**
   * The street grid's bearing per cell, in degrees 0..179, row-major; 0 for
   * the screen axes. Baked from the plan's per-borough `street.angle`
   * (WORLDGEN.md §13.4), so a pass that stands a car at a kerb or walks "the
   * way the street runs" can ask the ground for the exact angle instead of
   * estimating it from tarmac and being wrong at every junction. Optional
   * because a fixture that builds a bare CityMap has no boroughs to speak of.
   */
  bearing?: Uint8Array;
  /**
   * Half-tile bevel per cell, row-major — `BEV_*` codes from `bevel.ts`, 0
   * for the whole-tile default. Where set, the coded half of the tile is
   * made of the corner neighbours' material instead of the tile's own: the
   * diagonal shoreline. Derived from the finished tiles in `generateCity`
   * (after the last pass that carves one), never baked and never sent —
   * both hosts compute the identical plane from the identical tiles.
   * Optional because bare test fixtures predate it; absent means square.
   */
  bevel?: Uint8Array;
  /**
   * The authored roads' centrelines in tile units, from the bake — the
   * curves the tile bands rasterise, for the renderer to stroke as one
   * continuous line (WORLDGEN.md §16). Structurally `StreetCourse[]`
   * (layout.ts); typed loosely here because types.ts sits below layout in
   * the import order. Optional: bare fixtures and pre-course bakes have
   * none, and every consumer treats absence as "no curves to draw".
   */
  courses?: Array<{
    points: Array<readonly [number, number]>;
    width: number;
    kind: string;
  }>;
  /**
   * The coastline as closed polylines in tile units — the curve the water
   * tiles are a rasterisation of, for the renderer to shade against instead
   * of the tile edge (WORLDGEN.md §18). Structurally `ShoreLoop[]`
   * (shoreline.ts); typed loosely here for the same reason `courses` is.
   *
   * Derived from the finished tiles in `generateCity`, like the bevel plane
   * and unlike the courses: a shore has no authored source to keep, the
   * tiles ARE its definition, so recovering it costs no bake and no wire.
   * Optional; absent means the square shoreline the tiles draw themselves.
   */
  shores?: Array<{ points: Array<readonly [number, number]>; land: boolean }>;
  blocks: BlockRect[];
  buildings: Building[];
  shops: Shop[];
  /** Kerbside points cars are spawned FROM: ambient traffic, cops, roadblocks. */
  vehicleSpawns: VehicleSpawn[];
  /** Where cars are left standing: at the kerb, out of the way of traffic. */
  parkingSpots: VehicleSpawn[];
  /**
   * Where a given KIND of vehicle can reliably be found: the ambulance at the
   * hospital, the digger at the quarry, the tank behind the station.
   *
   * A list of its own rather than more `parkingSpots`, for two reasons that
   * are both bugs waiting to happen. The session samples parking by a stride
   * (`length / MAX_VEHICLES`) and keeps roughly one spot in six — `placeTank`
   * already had to be special-cased back in because of it — and `markGangCars`
   * rewrites the kind of every seventh parking spot, so a fire station whose
   * engine turned into a gang car one seed in seven is not a home.
   *
   * Homes are spawned in full and never rewritten. See GTA.md R3.
   */
  vehicleHomes: VehicleSpawn[];
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
