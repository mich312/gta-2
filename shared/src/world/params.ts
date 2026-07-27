import { DISTRICT_TYPES, type DistrictType } from './types.js';

/**
 * Generation parameters. Live in shared/data/worldgen.json; the server loads
 * the file and ships the parsed params to clients in the welcome message, so
 * both sides always generate from identical numbers even if the server's
 * JSON was tuned after the client bundle was built.
 */
export interface WorldgenParams {
  widthTiles: number;
  heightTiles: number;
  arterialsX: number;
  arterialsY: number;
  arterialWidth: number;
  secondaryWidth: number;
  /** Per-district [min, max] target block extent in tiles. */
  blockSize: Record<DistrictType, [number, number]>;
  /** How many Voronoi seeds each district type gets. */
  districtSeeds: Record<DistrictType, number>;
  /** Roughly one parked car every N road-edge tiles (district-independent for now). */
  parkedCarSpacing: number;
  shopQuota: { gun: number; clothing: number; spray: number };
  playerSpawnCount: number;
  playerSpawnMinDist: number;
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

export function parseWorldgenParams(raw: unknown): WorldgenParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const blockSizeRaw = (r['blockSize'] ?? {}) as Record<string, unknown>;
  const seedsRaw = (r['districtSeeds'] ?? {}) as Record<string, unknown>;
  const blockSize = {} as Record<DistrictType, [number, number]>;
  const districtSeeds = {} as Record<DistrictType, number>;
  for (const d of DISTRICT_TYPES) {
    blockSize[d] = pair(blockSizeRaw[d], `blockSize.${d}`);
    districtSeeds[d] = num(seedsRaw[d], `districtSeeds.${d}`);
  }
  const quotaRaw = (r['shopQuota'] ?? {}) as Record<string, unknown>;
  return {
    widthTiles: num(r['widthTiles'], 'widthTiles'),
    heightTiles: num(r['heightTiles'], 'heightTiles'),
    arterialsX: num(r['arterialsX'], 'arterialsX'),
    arterialsY: num(r['arterialsY'], 'arterialsY'),
    arterialWidth: num(r['arterialWidth'], 'arterialWidth'),
    secondaryWidth: num(r['secondaryWidth'], 'secondaryWidth'),
    blockSize,
    districtSeeds,
    parkedCarSpacing: num(r['parkedCarSpacing'], 'parkedCarSpacing'),
    shopQuota: {
      gun: num(quotaRaw['gun'], 'shopQuota.gun'),
      clothing: num(quotaRaw['clothing'], 'shopQuota.clothing'),
      spray: num(quotaRaw['spray'], 'shopQuota.spray'),
    },
    playerSpawnCount: num(r['playerSpawnCount'], 'playerSpawnCount'),
    playerSpawnMinDist: num(r['playerSpawnMinDist'], 'playerSpawnMinDist'),
  };
}
