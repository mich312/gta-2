import { labelJunctions } from '../sim/signals.js';
import { assignTurf, markGangCars } from './turf.js';
import { seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { placeDistrictSeeds, districtLookup } from './districts.js';
import { carveRiver, generateRoads } from './roads.js';
import { fillBlock } from './buildings.js';
import {
  placeParking,
  placeTank,
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
    junctions: { idOf: new Int16Array(0), count: 0, heads: [] },
    dayLengthSec: params.dayLengthSec,
    turfCells: new Uint8Array(0),
    turfCellsWide: 0,
    turfCellTiles: 1,
    turfHomes: [],
  };

  let seeds;
  [seeds, rng] = placeDistrictSeeds(params, rng);
  const districtIdxAt = districtLookup(seeds);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      map.district[ty * W + tx] = districtIdxAt(tx, ty);
    }
  }

  // The river goes in first so the road generator lays its grid around it.
  const river = carveRiver(map.tiles, W, H, params.waterWidth, rng);
  rng = river.rng;

  const roads = generateRoads(map.tiles, params, districtIdxAt, rng);
  rng = roads.rng;
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

  for (const block of map.blocks) {
    rng = fillBlock(map.tiles, W, H, map.buildings, block, rng);
  }

  // Landmarks first: they stamp big footprints, and shops pick doorways from
  // the building list afterwards.
  rng = placeLandmarks(map, rng);
  rng = placeShops(map, params, rng);
  registerClinics(map);
  rng = placeVehicleSpawns(map, params, rng);
  rng = placePlayerSpawns(map, params, rng);
  placeParking(map);
  placeTank(map);
  placePedSpawns(map);
  placeProps(map);
  placePickups(map);
  placeBoatSpawns(map);
  placeRamps(map);
  placeCranes(map);
  placePayphones(map);
  assignTurf(map, params);
  markGangCars(map);
  // Last, and after every pass that can carve or close a road: the labels are
  // derived from the finished tile grid, so anything that moves a road tile
  // afterwards would leave a junction labelled where there is none.
  map.junctions = labelJunctions(map);

  return map;
}
