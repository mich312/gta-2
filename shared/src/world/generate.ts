import { seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { placeDistrictSeeds, districtLookup } from './districts.js';
import { generateRoads } from './roads.js';
import { fillBlock } from './buildings.js';
import { placePedSpawns, placePlayerSpawns, placeShops, placeVehicleSpawns } from './amenities.js';
import { TILE_SIZE, type CityMap } from './types.js';

/**
 * The city as a pure function of (seed, params). The server picks the seed,
 * ships seed+params in the welcome message, and the client regenerates the
 * identical map locally — geometry never crosses the wire.
 *
 * Generation order (fixed): district seeds → road graph (arterials +
 * subdivision) → blocks → sidewalks + building footprints → shops →
 * parking/vehicle spawns → player spawns. One rng consumed in fixed order.
 */
export function generateCity(seed: number, params: WorldgenParams): CityMap {
  // Offset the seed stream so the sim (which starts from seedRng(seed))
  // and worldgen never share a sequence.
  let rng = seedRng(seed ^ 0x5f3759df);

  const W = params.widthTiles;
  const H = params.heightTiles;
  const map: CityMap = {
    seed,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles: new Uint8Array(W * H),
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    playerSpawns: [],
    pedSpawns: [],
  };

  let seeds;
  [seeds, rng] = placeDistrictSeeds(params, rng);
  const districtIdxAt = districtLookup(seeds);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      map.district[ty * W + tx] = districtIdxAt(tx, ty);
    }
  }

  const roads = generateRoads(map.tiles, params, districtIdxAt, rng);
  rng = roads.rng;
  map.blocks = roads.blocks;

  for (const block of map.blocks) {
    rng = fillBlock(map.tiles, W, H, map.buildings, block, rng);
  }

  rng = placeShops(map, params, rng);
  rng = placeVehicleSpawns(map, params, rng);
  rng = placePlayerSpawns(map, params, rng);
  placePedSpawns(map);

  return map;
}
