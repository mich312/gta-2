import { labelJunctions } from '../sim/signals.js';
import { assignTurf, markGangCars } from './turf.js';
import { deriveSeed, seedRng } from '../rng/prng.js';
import { decodeBakedCity, type BakedCity } from './bake.js';
import { CITY_DATA } from './city.data.js';
import type { WorldgenParams } from './params.js';
import {
  placeParking,
  placePackages,
  placeVehicleHomes,
  placePedSpawns,
  placePlayerSpawns,
  placeProps,
  placeBoatSpawns,
  placePickups,
  placeCranes,
  placeProvingGround,
  registerClinics,
  placePayphones,
  placeRamps,
  placeVehicleSpawns,
} from './amenities.js';
import { TILE_SIZE, type CityMap } from './types.js';

/**
 * The one city, loaded.
 *
 * What used to be here was a generator: fields sampled from noise, districts
 * scored off them, an infinite jittered arterial lattice, and a WINDOW onto
 * all of it that the session dragged around as players walked. It made a
 * different city per seed and no city in particular — grids that went on
 * until the noise put a river through them, boroughs with no shape, streets
 * that ran into the sea because nothing in the pipeline knew what a coast was
 * for.
 *
 * Now there is one city, drawn by hand (`shared/data/city-plan.json`), baked
 * once (`pnpm citybake`) and shipped as `city.data.ts` beside this file. This
 * function decodes that and dresses it:
 *
 *  - GROUND — tiles, districts, blocks, buildings, landmarks and shopfronts —
 *    is baked. It is identical on the server, in the client and in a replay
 *    because it is the same bytes, not the same algorithm run twice.
 *  - FURNITURE — parked cars, pedestrians, props, crates, moorings, ramps,
 *    payphones, gang turf, hidden packages — is derived here from the ground
 *    and the session seed. Two sessions of the same city can still differ in
 *    what is standing at the kerb, which is worth keeping and costs nothing.
 *
 * The city has edges. Where the map stops there is sea, which is the reason
 * the edge needs no other explanation.
 */

const baked: BakedCity = decodeBakedCity(JSON.parse(CITY_DATA));

export function generateCity(seed: number, params: WorldgenParams): CityMap {
  const stream = (pass: string): number => seedRng(deriveSeed(seed, `worldgen.${pass}`));

  const W = baked.widthTiles;
  const H = baked.heightTiles;
  const map: CityMap = {
    seed,
    name: baked.name,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    // Copied, not shared: the passes below carve ramps and, when asked, a
    // proving ground, and a session must not scribble on the baked city that
    // the next one will load.
    tiles: baked.tiles.slice(),
    district: baked.district.slice(),
    bearing: baked.bearing,
    blocks: baked.blocks,
    buildings: baked.buildings.slice(),
    shops: baked.shops.map((s) => ({ ...s })),
    landmarks: baked.landmarks,
    vehicleSpawns: [],
    parkingSpots: [],
    vehicleHomes: [],
    playerSpawns: [],
    pedSpawns: [],
    propSpawns: [],
    pickupSpawns: [],
    boatSpawns: [],
    hospitals: [],
    policeStations: [],
    cranes: [],
    payphones: [],
    junctions: { idOf: new Int16Array(0), count: 0, heads: [] },
    dayLengthSec: params.dayLengthSec,
    packages: [],
    turfCells: new Uint8Array(0),
    turfCellsWide: 0,
    turfCellTiles: 1,
    turfHomes: [],
  };

  registerClinics(map);
  placeVehicleSpawns(map, params, stream('vehicles'));
  placePlayerSpawns(map, params, stream('playerSpawns'));
  placeParking(map, params);
  placeVehicleHomes(map);
  placePedSpawns(map);
  placeProps(map);
  placePickups(map);
  placeBoatSpawns(map);
  placeRamps(map, params, seed);
  placeCranes(map);
  placePayphones(map);
  assignTurf(map, params);
  markGangCars(map, params);
  placePackages(map, params);
  // Dead last of the placement passes, and only when asked for: see
  // placeProvingGround on why it must not run before anything else.
  if (params.provingGround) placeProvingGround(map);
  // Last, and after every pass that can carve or close a road: the labels are
  // derived from the finished tile grid, so anything that moves a road tile
  // afterwards would leave a junction labelled where there is none.
  map.junctions = labelJunctions(map);

  return map;
}
