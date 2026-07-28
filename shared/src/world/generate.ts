import { assignTurf } from './turf.js';
import { deriveSeed, seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { classifyDistrict } from './districts.js';
import { makeFields, type CityFields } from './fields.js';
import { ARTERIAL_HORIZONTAL, ARTERIAL_VERTICAL, generateRoads } from './roads.js';
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
import { T_BANK, T_BRIDGE, T_FIELD, T_ROAD, T_WATER, TILE_SIZE, type CityMap } from './types.js';

/**
 * A WINDOW onto an unbounded world, as a pure function of (seed, params).
 * The server picks the seed, ships seed+params in the welcome message, and
 * the client regenerates the identical window locally — geometry never
 * crosses the wire.
 *
 * The world itself has no edges: fields (L0) and classification (L1) are
 * pure functions of global coordinates; roads are an infinite jittered
 * arterial lattice; and everything between arterials generates per CELL
 * from rng derived from hash(seed, cell index) — never from a shared
 * stream, never from the window. Two windows of the same seed therefore
 * agree tile-for-tile wherever they overlap (windows.test.ts holds this),
 * and params.windowX/windowY can open a session anywhere. CityMap stays in
 * window-local coordinates throughout, so the sim, the wire and the client
 * never learn the world grew.
 *
 * Window-scoped by design (session furniture, not world features): player
 * spawns, turf, and the amenity LISTS that mutate no tiles — parking, peds,
 * props, pickups, boats, cranes, payphones. Carving passes (shops,
 * landmarks, ramps) are cell-local or position-hashed because they DO
 * mutate tiles.
 */
export function generateCity(seed: number, params: WorldgenParams): CityMap {
  const stream = (pass: string): number => seedRng(deriveSeed(seed, `worldgen.${pass}`));

  const wx = params.windowX;
  const wy = params.windowY;
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

  const fields = makeFields(seed, params);
  const districtIdxAt = (gx: number, gy: number): number =>
    classifyDistrict(fields, params, gx, gy);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      map.district[ty * W + tx] = districtIdxAt(wx + tx, wy + ty);
    }
  }

  // Waterways go in first so roads carve over them and the bridge pass can
  // tell which crossings to keep.
  const waterMask = new Uint8Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (!fields.water(wx + tx, wy + ty)) continue;
      map.tiles[ty * W + tx] = T_WATER;
      waterMask[ty * W + tx] = 1;
    }
  }

  const roads = generateRoads(map.tiles, params, districtIdxAt, seed);
  map.blocks = roads.cells.flatMap((c) => c.blocks);

  // Where an ARTERIAL crosses water, that becomes a bridge: road on top,
  // navigable water underneath — but only where the crossing is SHORT
  // along the road's direction of travel. A road running lengthwise over a
  // river is not a crossing, it is a causeway that roofs the waterway
  // over; and a stretch of water wider than maxBridgeSpan is sea, where
  // the road stops at the bank and the boat is the way across. Everything
  // else the roads trampled goes back to being water. Spans are measured
  // on the water FIELD (global, pure), not on the window's arrays, so the
  // decision is identical from every viewport.
  const maxSpan = params.water.maxBridgeSpan;
  const crossingSpan = (fs: CityFields, gx: number, gy: number, dx: number, dy: number): number => {
    let n = 1;
    for (let s = 1; s <= maxSpan && fs.water(gx + dx * s, gy + dy * s); s++) n++;
    for (let s = 1; s <= maxSpan && fs.water(gx - dx * s, gy - dy * s); s++) n++;
    return n;
  };
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (waterMask[i] !== 1) continue;
      const axisBits = roads.arterialMask[i] as number;
      const gx = wx + tx;
      const gy = wy + ty;
      const bridged =
        map.tiles[i] === T_ROAD &&
        (((axisBits & ARTERIAL_VERTICAL) !== 0 && crossingSpan(fields, gx, gy, 0, 1) <= maxSpan) ||
          ((axisBits & ARTERIAL_HORIZONTAL) !== 0 &&
            crossingSpan(fields, gx, gy, 1, 0) <= maxSpan));
      map.tiles[i] = bridged ? T_BRIDGE : T_WATER;
    }
  }

  // Banks: every open tile beside waterway water becomes quay/embankment,
  // BEFORE blocks fill — so the fill passes treat the quay like water and
  // keep buildings, sidewalks and yards off it, and every waterfront gets
  // a walkable edge instead of a building sliced off by the river.
  // Neighbourhood is tested on the water FIELD (global, pure), so a bank
  // at the window rim agrees with every other viewport; roads keep their
  // tiles, which is what lets a drowned road end reach its own bank.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (map.tiles[i] !== T_FIELD) continue;
      const gx = wx + tx;
      const gy = wy + ty;
      if (
        fields.water(gx + 1, gy) ||
        fields.water(gx - 1, gy) ||
        fields.water(gx, gy + 1) ||
        fields.water(gx, gy - 1)
      ) {
        map.tiles[i] = T_BANK;
      }
    }
  }

  // Blocks fill per cell, each block from its own GLOBAL-coordinate-derived
  // stream, so a block half in this window lays out identically to the same
  // block whole in another.
  const cellBuildings: Array<{ cell: (typeof roads.cells)[number]; start: number; end: number }> =
    [];
  for (const cell of roads.cells) {
    const start = map.buildings.length;
    for (const block of cell.blocks) {
      const rng = seedRng(deriveSeed(seed, `block.${block.x + wx}.${block.y + wy}`));
      fillBlock(map.tiles, W, H, map.buildings, block, rng);
    }
    cellBuildings.push({ cell, start, end: map.buildings.length });
  }

  // Landmarks first: they stamp big footprints, and shops pick doorways from
  // the building list afterwards. Both are cell-local.
  placeLandmarks(map, params, roads.cells, seed);
  placeShops(map, params, cellBuildings, seed);
  registerClinics(map);
  placeVehicleSpawns(map, params, stream('vehicles'));
  placePlayerSpawns(map, params, stream('playerSpawns'));
  placeParking(map);
  placePedSpawns(map);
  placeProps(map);
  placePickups(map);
  placeBoatSpawns(map);
  placeRamps(map, params, seed);
  placeCranes(map);
  placePayphones(map);
  assignTurf(map, params);

  return map;
}
