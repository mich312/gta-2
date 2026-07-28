import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { openWater } from './helpers.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { isSolidTile, boxInSolid } from '../src/world/collide.js';
import { T_BRIDGE, T_BUILDING, T_WATER, TILE_SIZE } from '../src/world/types.js';
import { hashState } from '../src/net/hash.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
  traffic: { ...trafficJson, count: 0 },
});

const params = parseWorldgenParams(worldgenJson);
const map = generateCity(1234, params);

function countTiles(m: typeof map, tile: number): number {
  let n = 0;
  for (let i = 0; i < m.tiles.length; i++) if (m.tiles[i] === tile) n++;
  return n;
}

describe('the river', () => {
  it('is carved across every seed, and is bridged', () => {
    for (const seed of [1, 7, 42, 1234, 90210]) {
      const m = generateCity(seed, params);
      expect(countTiles(m, T_WATER)).toBeGreaterThan(200);
      // The road grid must get across it, or the city is cut in half.
      expect(countTiles(m, T_BRIDGE)).toBeGreaterThan(0);
    }
  });

  it('never has a building standing in it', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const m = generateCity(seed, params);
      for (const b of m.buildings) {
        for (let ty = b.y; ty < b.y + b.h; ty++) {
          for (let tx = b.x; tx < b.x + b.w; tx++) {
            if (tx < 0 || ty < 0 || tx >= m.widthTiles || ty >= m.heightTiles) continue;
            expect(m.tiles[ty * m.widthTiles + tx]).not.toBe(T_WATER);
          }
        }
      }
    }
  });

  it('places no amenity on the water', () => {
    const at = (x: number, y: number): number =>
      map.tiles[Math.floor(y / TILE_SIZE) * map.widthTiles + Math.floor(x / TILE_SIZE)] as number;
    for (const s of map.playerSpawns) expect(at(s.x, s.y)).not.toBe(T_WATER);
    for (const s of map.vehicleSpawns) expect(at(s.x, s.y)).not.toBe(T_WATER);
    for (const s of map.pedSpawns) expect(at(s.x, s.y)).not.toBe(T_WATER);
    for (const s of map.pickupSpawns) expect(at(s.x, s.y)).not.toBe(T_WATER);
  });

  it('is a pure function of the seed', () => {
    const again = generateCity(1234, params);
    expect(Array.from(again.tiles)).toEqual(Array.from(map.tiles));
    expect(again.boatSpawns).toEqual(map.boatSpawns);
  });

  it('bridges cross water; they never run along it or across the sea', () => {
    // Every bridge tile must belong to a genuine crossing: a run of
    // water-or-bridge no longer than maxBridgeSpan along SOME axis. A
    // causeway — a road laid lengthwise over a river — or a span across
    // open water fails this on both axes. The road is supposed to stop at
    // the bank there, and the boat is supposed to be the way across.
    const wet = (m: typeof map, tx: number, ty: number): boolean => {
      if (tx < 0 || ty < 0 || tx >= m.widthTiles || ty >= m.heightTiles) return false;
      const t = m.tiles[ty * m.widthTiles + tx];
      return t === T_WATER || t === T_BRIDGE;
    };
    const span = (m: typeof map, tx: number, ty: number, dx: number, dy: number): number => {
      let n = 1;
      for (let s = 1; wet(m, tx + dx * s, ty + dy * s); s++) n++;
      for (let s = 1; wet(m, tx - dx * s, ty - dy * s); s++) n++;
      return n;
    };
    const max = params.water.maxBridgeSpan;
    for (const seed of [1, 7, 42, 1234, 90210]) {
      const m = generateCity(seed, params);
      for (let ty = 0; ty < m.heightTiles; ty++) {
        for (let tx = 0; tx < m.widthTiles; tx++) {
          if (m.tiles[ty * m.widthTiles + tx] !== T_BRIDGE) continue;
          // Interior tiles only: at the window rim a run is cut short by
          // the edge, which reads as "short" — skip the ambiguity.
          if (tx < max || ty < max || tx >= m.widthTiles - max || ty >= m.heightTiles - max)
            continue;
          const ok = Math.min(span(m, tx, ty, 0, 1), span(m, tx, ty, 1, 0)) <= max;
          expect(ok, `seed ${seed}: causeway/sea bridge at (${tx}, ${ty})`).toBe(true);
        }
      }
    }
  });

  it('every bridge tile is open water underneath — boats go under, everywhere', () => {
    for (const seed of [1, 7, 1234]) {
      const m = generateCity(seed, params);
      let bridges = 0;
      for (let ty = 0; ty < m.heightTiles; ty++) {
        for (let tx = 0; tx < m.widthTiles; tx++) {
          if (m.tiles[ty * m.widthTiles + tx] !== T_BRIDGE) continue;
          bridges++;
          expect(isSolidTile(m, tx, ty, 'water'), `seed ${seed} bridge (${tx}, ${ty})`).toBe(false);
          expect(isSolidTile(m, tx, ty, 'land'), `seed ${seed} bridge (${tx}, ${ty})`).toBe(false);
        }
      }
      expect(bridges).toBeGreaterThan(0);
    }
  });
});

describe('media', () => {
  /** First water tile in the map, for direct collision probing. */
  function aWaterTile(): { tx: number; ty: number } {
    for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] === T_WATER) return { tx, ty };
      }
    }
    throw new Error('no water');
  }

  it('water blocks anything on land and carries anything afloat', () => {
    const { tx, ty } = aWaterTile();
    expect(isSolidTile(map, tx, ty, 'land')).toBe(true);
    expect(isSolidTile(map, tx, ty, 'water')).toBe(false);
  });

  it('dry land is exactly the other way round', () => {
    // A building is solid to both; a road carries land movers only.
    let road = { tx: -1, ty: -1 };
    let building = { tx: -1, ty: -1 };
    for (let ty = 0; ty < map.heightTiles && (road.tx < 0 || building.tx < 0); ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        const t = map.tiles[ty * map.widthTiles + tx];
        if (t === 1 && road.tx < 0) road = { tx, ty };
        if (t === T_BUILDING && building.tx < 0) building = { tx, ty };
      }
    }
    expect(isSolidTile(map, road.tx, road.ty, 'land')).toBe(false);
    expect(isSolidTile(map, road.tx, road.ty, 'water')).toBe(true);
    expect(isSolidTile(map, building.tx, building.ty, 'land')).toBe(true);
    expect(isSolidTile(map, building.tx, building.ty, 'water')).toBe(true);
  });

  it('a bridge carries both: road over the top, river underneath', () => {
    let bridge = { tx: -1, ty: -1 };
    outer: for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] === T_BRIDGE) {
          bridge = { tx, ty };
          break outer;
        }
      }
    }
    expect(bridge.tx).toBeGreaterThanOrEqual(0);
    expect(isSolidTile(map, bridge.tx, bridge.ty, 'land')).toBe(false);
    expect(isSolidTile(map, bridge.tx, bridge.ty, 'water')).toBe(false);
  });

  it('a player cannot walk into the river', () => {
    // A water tile with a WALKABLE bank above it: the first water tile in
    // row-major order can sit under a building's edge, and a walker starting
    // inside a wall proves nothing about the river.
    function approachableWater(): { tx: number; ty: number } {
      for (let ty = 3; ty < map.heightTiles; ty++) {
        for (let tx = 0; tx < map.widthTiles; tx++) {
          if (map.tiles[ty * map.widthTiles + tx] !== T_WATER) continue;
          if (isSolidTile(map, tx, ty - 1, 'land') || isSolidTile(map, tx, ty - 2, 'land')) continue;
          return { tx, ty };
        }
      }
      throw new Error('no approachable bank');
    }
    const { tx, ty } = approachableWater();
    // Start on the bank just above the water and walk straight at it.
    let state = createGameState(5);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const p = state.players.byId[1]!;
    p.pos = { x: (tx + 0.5) * TILE_SIZE, y: (ty - 2) * TILE_SIZE };
    for (let i = 0; i < 90; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, down: true } }, [], map);
    }
    const end = state.players.byId[1]!.pos;
    expect(boxInSolid(map, end, 6, 'land')).toBe(false);
  });
});

describe('boats', () => {
  it('the map moors boats on reachable water', () => {
    expect(map.boatSpawns.length).toBeGreaterThan(0);
    for (const s of map.boatSpawns) {
      const tx = Math.floor(s.x / TILE_SIZE);
      const ty = Math.floor(s.y / TILE_SIZE);
      expect(map.tiles[ty * map.widthTiles + tx]).toBe(T_WATER);
      expect(s.kind).toBe('boat');
    }
  });

  it('a boat drives on water and is stopped by the bank', () => {
    // A mooring with river ahead of it, not merely the first one on the map —
    // see test/helpers.ts.
    const mooring = openWater(map, 80);
    let state = createGameState(6);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'sailor' }], map);
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 30,
          kind: 'boat',
          x: mooring.x,
          y: mooring.y,
          heading: mooring.heading,
        },
      ],
      map,
    );
    // Put the sailor aboard and open the throttle.
    const p = state.players.byId[1]!;
    p.pos = { x: mooring.x, y: mooring.y };
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('driving');

    const from = { ...state.vehicles.byId[30]!.pos };
    for (let i = 0; i < 90; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i + 2, up: true } }, [], map);
    }
    const boat = state.vehicles.byId[30]!;
    expect(Math.hypot(boat.pos.x - from.x, boat.pos.y - from.y)).toBeGreaterThan(20);
    // Wherever it ended up, it is still afloat — never beached inland.
    expect(boxInSolid(map, boat.pos, 11, 'water')).toBe(false);
  });

  it('a car cannot be driven into the river', () => {
    const mooring = map.boatSpawns[0]!;
    let state = createGameState(8);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'd' }], map);
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 40, kind: 'car', x: mooring.x, y: mooring.y, heading: 0 }],
      map,
    );
    // A car spawned on water cannot move off its tile in any direction.
    const car = state.vehicles.byId[40]!;
    const from = { ...car.pos };
    for (let i = 0; i < 40; i++) {
      state.vehicles.byId[40]!.speed = 200;
      state = step(state, {}, [], map);
    }
    const after = state.vehicles.byId[40]!;
    expect(Math.hypot(after.pos.x - from.x, after.pos.y - from.y)).toBeLessThan(TILE_SIZE * 2);
  });

  it('the whole thing is deterministic', () => {
    const run = (): number => {
      let state = createGameState(11);
      state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
      const m = map.boatSpawns[0]!;
      state = step(
        state,
        {},
        [{ type: 'spawnVehicle', vehicleId: 50, kind: 'boat', x: m.x, y: m.y, heading: m.heading }],
        map,
      );
      for (let i = 0; i < 300; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
