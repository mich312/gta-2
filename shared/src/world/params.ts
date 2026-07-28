import { DISTRICT_TYPES, type DistrictType } from './types.js';

/**
 * Generation parameters. Live in shared/data/worldgen.json; the server loads
 * the file and ships the parsed params to clients in the welcome message, so
 * both sides always generate from identical numbers even if the server's
 * JSON was tuned after the client bundle was built.
 */
export interface WorldgenParams {
  /**
   * The world is unbounded: every pass is a pure function of (seed, global
   * tile coordinate). A session materialises a WINDOW of it — this origin
   * and size, in global tiles. Two windows of the same seed agree tile-for-
   * tile wherever they overlap (see windows.test.ts), so "the map" is
   * really a viewport that could be opened anywhere, of any affordable
   * size. CityMap consumers keep window-local coordinates throughout.
   */
  windowX: number;
  windowY: number;
  widthTiles: number;
  heightTiles: number;
  /** Arterial lattice pitch in tiles — arterials run forever, every ~this. */
  arterialSpacing: number;
  arterialWidth: number;
  secondaryWidth: number;
  /** Per-district [min, max] target block extent in tiles. */
  blockSize: Record<DistrictType, [number, number]>;
  /**
   * The L0 field layer (WORLDGEN.md §9.2). Districts are classified by
   * scoring these fields, not placed as Voronoi seeds: `downtown`,
   * `commercial` and `residential` are descending thresholds on the
   * density field; below them the rim splits industrial/residential on
   * the grit field, and `parkWildness` cuts green pockets anywhere
   * outside the core.
   */
  fields: {
    /** Base noise wavelength, in tiles. */
    noiseTiles: number;
    /** Noise amplitude added to radial density (fraction of full scale). */
    densityNoise: number;
    /** City-core lattice pitch in tiles: one core per cell, forever. */
    citySpacing: number;
    /** Radius at which a core's density reaches 0, fraction of citySpacing. */
    coreRadius: number;
    downtown: number;
    commercial: number;
    residential: number;
    parkWildness: number;
    grit: number;
  };
  /**
   * Waterways: noise-contour bands. `scale` = wavelength in tiles, `width` =
   * half-band in field units. `maxBridgeSpan` = the longest water crossing
   * (tiles, along the road's direction) an arterial will bridge — anything
   * wider is sea, and the road stops at the bank.
   */
  water: { scale: number; width: number; maxBridgeSpan: number };
  /** Roughly one parked car every N road-edge tiles (district-independent for now). */
  parkedCarSpacing: number;
  shopQuota: { gun: number; clothing: number; spray: number };
  playerSpawnCount: number;
  playerSpawnMinDist: number;
  /** River width in tiles. */
  /**
   * Gang territory. Lives here rather than in gangs.json because worldgen
   * must not depend on runtime tuning being initialised — several tests
   * generate a city at module scope, before any initTuning() has run. The
   * gangs' names, colours and rivalries stay in gangs.json, where the sim
   * reads them.
   */
  turf: { cellTiles: number; gangCount: number };
  /**
   * Seconds in an in-game day. Here rather than in a tuning file for the same
   * reason as `turf`: it ships in the welcome message alongside the seed, so
   * the client's clock and the server's are the same function of the tick
   * without a second thing to keep in step.
   */
  dayLengthSec: number;
  /** How much of the daytime crowd is out at the dead of night. */
  nightCrowdScale: number;
  /** Hidden packages per city. See amenities.placePackages. */
  packageCount: number;
}

function parseTurf(raw: unknown): { cellTiles: number; gangCount: number } {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    cellTiles: num(r['cellTiles'], 'turf.cellTiles'),
    gangCount: num(r['gangCount'], 'turf.gangCount'),
  };
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`worldgen: ${name} must be a positive finite number`);
  }
  return v;
}

function pair(v: unknown, name: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`worldgen: ${name} must be [min,max]`);
  const min = num(v[0], `${name}[0]`);
  const max = num(v[1], `${name}[1]`);
  if (min > max) throw new Error(`worldgen: ${name} min > max`);
  return [min, max];
}

function parseFields(raw: unknown): WorldgenParams['fields'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    noiseTiles: num(r['noiseTiles'], 'fields.noiseTiles'),
    densityNoise: num(r['densityNoise'], 'fields.densityNoise'),
    citySpacing: num(r['citySpacing'], 'fields.citySpacing'),
    coreRadius: num(r['coreRadius'], 'fields.coreRadius'),
    downtown: num(r['downtown'], 'fields.downtown'),
    commercial: num(r['commercial'], 'fields.commercial'),
    residential: num(r['residential'], 'fields.residential'),
    parkWildness: num(r['parkWildness'], 'fields.parkWildness'),
    grit: num(r['grit'], 'fields.grit'),
  };
}

/**
 * Window origin: the one worldgen number allowed to be zero or negative —
 * a viewport can open anywhere in the unbounded world.
 */
function coord(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`worldgen: ${name} must be a finite integer`);
  }
  return v;
}

export function parseWorldgenParams(raw: unknown): WorldgenParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const blockSizeRaw = (r['blockSize'] ?? {}) as Record<string, unknown>;
  const blockSize = {} as Record<DistrictType, [number, number]>;
  for (const d of DISTRICT_TYPES) {
    blockSize[d] = pair(blockSizeRaw[d], `blockSize.${d}`);
  }
  const quotaRaw = (r['shopQuota'] ?? {}) as Record<string, unknown>;
  const waterRaw = (r['water'] ?? {}) as Record<string, unknown>;
  return {
    windowX: coord(r['windowX'], 'windowX'),
    windowY: coord(r['windowY'], 'windowY'),
    widthTiles: num(r['widthTiles'], 'widthTiles'),
    heightTiles: num(r['heightTiles'], 'heightTiles'),
    arterialSpacing: num(r['arterialSpacing'], 'arterialSpacing'),
    arterialWidth: num(r['arterialWidth'], 'arterialWidth'),
    secondaryWidth: num(r['secondaryWidth'], 'secondaryWidth'),
    blockSize,
    fields: parseFields(r['fields']),
    water: {
      scale: num(waterRaw['scale'], 'water.scale'),
      width: num(waterRaw['width'], 'water.width'),
      maxBridgeSpan: num(waterRaw['maxBridgeSpan'], 'water.maxBridgeSpan'),
    },
    parkedCarSpacing: num(r['parkedCarSpacing'], 'parkedCarSpacing'),
    turf: parseTurf(r['turf']),
    // Defaulted rather than required: an older worldgen block (a replay
    // header, a saved config) must still parse, and a city with no clock is
    // simply the fixed-dusk city this one used to be.
    dayLengthSec: typeof r['dayLengthSec'] === 'number' && r['dayLengthSec'] > 0
      ? r['dayLengthSec']
      : 1440,
    nightCrowdScale:
      typeof r['nightCrowdScale'] === 'number' &&
      r['nightCrowdScale'] > 0 &&
      r['nightCrowdScale'] <= 1
        ? r['nightCrowdScale']
        : 0.55,
    packageCount:
      typeof r['packageCount'] === 'number' && r['packageCount'] >= 0 ? r['packageCount'] : 100,
    shopQuota: {
      gun: num(quotaRaw['gun'], 'shopQuota.gun'),
      clothing: num(quotaRaw['clothing'], 'shopQuota.clothing'),
      spray: num(quotaRaw['spray'], 'shopQuota.spray'),
    },
    playerSpawnCount: num(r['playerSpawnCount'], 'playerSpawnCount'),
    playerSpawnMinDist: num(r['playerSpawnMinDist'], 'playerSpawnMinDist'),
  };
}
