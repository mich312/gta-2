import { assignTurf } from './turf.js';
import { deriveSeed, seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { districtClassifier } from './districts.js';
import { carveRiver, generateRoads } from './roads.js';
import { fillBlock } from './buildings.js';
import {
  placeParking,
  placePedSpawns,
  placePlayerSpawns,
  placeProps,
  placeBoatSpawns,
  placeLandmarks,
  placePickups,
  placeCranes,
  registerClinics,
  placePayphones,
  placeRamps,
  placeShops,
  placeVehicleSpawns,
} from './amenities.js';
import { T_BRIDGE, T_ROAD, T_WATER, TILE_SIZE, type CityMap } from './types.js';

/**
 * The city as a pure function of (seed, params). The server picks the seed,
 * ships seed+params in the welcome message, and the client regenerates the
 * identical map locally — geometry never crosses the wire.
 *
 * Generation order (fixed): fields/classification → river → road graph
 * (arterials + subdivision) → blocks → sidewalks + building footprints →
 * landmarks → shops → parking/vehicle spawns → player spawns.
 *
 * Randomness is hierarchically seeded (WORLDGEN.md §9.3): every pass draws
 * from its own stream, derived from (seed, pass name). Adding a draw to one
 * pass therefore never shifts what any other pass generates — pass order
 * stays load-bearing for data dependencies only, and the sim (which seeds
 * from the bare seed) can never collide with a worldgen stream.
 */
export function generateCity(seed: number, params: WorldgenParams): CityMap {
  const stream = (pass: string): number => seedRng(deriveSeed(seed, `worldgen.${pass}`));

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
    parkingSpots: [],
    playerSpawns: [],
    pedSpawns: [],
    propSpawns: [],
    pickupSpawns: [],
    boatSpawns: [],
    landmarks: [],
    hospitals: [],
    policeStations: [],
    cranes: [],
    payphones: [],
    turfCells: new Uint8Array(0),
    turfCellsWide: 0,
    turfCellTiles: 1,
    turfHomes: [],
  };

  const districtIdxAt = districtClassifier(seed, params);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      map.district[ty * W + tx] = districtIdxAt(tx, ty);
    }
  }

  // The river goes in first so the road generator lays its grid around it.
  const river = carveRiver(map.tiles, W, H, params.waterWidth, stream('river'));

  const roads = generateRoads(map.tiles, params, districtIdxAt, stream('roads'));
  map.blocks = roads.blocks;

  // Where an ARTERIAL was carved straight over the river, that becomes a
  // bridge: road on top, navigable water underneath. Everything else the
  // roads trampled goes back to being river, so the crossings stay few and
  // the river stays a real barrier.
  for (let i = 0; i < map.tiles.length; i++) {
    if (river.mask[i] !== 1) continue;
    const bridged = map.tiles[i] === T_ROAD && roads.arterialMask[i] === 1;
    map.tiles[i] = bridged ? T_BRIDGE : T_WATER;
  }

  let blockRng = stream('blocks');
  for (const block of map.blocks) {
    blockRng = fillBlock(map.tiles, W, H, map.buildings, block, blockRng);
  }

  // Landmarks first: they stamp big footprints, and shops pick doorways from
  // the building list afterwards.
  placeLandmarks(map, stream('landmarks'));
  placeShops(map, params, stream('shops'));
  registerClinics(map);
  placeVehicleSpawns(map, params, stream('vehicles'));
  placePlayerSpawns(map, params, stream('playerSpawns'));
  placeParking(map);
  placePedSpawns(map);
  placeProps(map);
  placePickups(map);
  placeBoatSpawns(map);
  placeRamps(map);
  placeCranes(map);
  placePayphones(map);
  assignTurf(map, params);

  return map;
}
