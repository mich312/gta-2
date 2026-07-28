import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, createVehicle, type GameState } from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { driveVehicle } from '../src/sim/vehicle.js';
import { T_BUILDING, T_RUNWAY, TILE_SIZE, type CityMap } from '../src/world/types.js';

initTuning({ player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson });

const params = parseWorldgenParams(worldgenJson);
/** A seed whose window contains an airstrip. */
const map: CityMap = generateCity(1, params);
const strip = map.landmarks.find((l) => l.kind === 'airstrip');

function runwayTile(m: CityMap): { x: number; y: number } | null {
  for (let ty = 0; ty < m.heightTiles; ty++) {
    for (let tx = 0; tx < m.widthTiles; tx++) {
      if (m.tiles[ty * m.widthTiles + tx] === T_RUNWAY) {
        return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
      }
    }
  }
  return null;
}

/** One vehicle, under power, for N ticks. */
function fly(kind: string, at: { x: number; y: number }, ticks: number): GameState {
  const state = createGameState(3);
  const v = createVehicle(1, kind, at, 0);
  v.driverId = 1;
  insertEntity(state.vehicles, v);
  for (let i = 0; i < ticks; i++) {
    driveVehicle(v, 1, 0, map, state, state, []);
  }
  return state;
}

describe('flight (S2)', () => {
  it('the city has an airstrip, and it is made of runway', () => {
    expect(strip).toBeDefined();
    expect(runwayTile(map)).not.toBeNull();
  });

  it('a plane needs a runway: a field is not one', () => {
    // The rule that makes the airstrip a destination rather than scenery.
    const rw = runwayTile(map)!;
    const onStrip = fly('plane', rw, 200);
    expect(onStrip.vehicles.byId[1]!.z).toBeGreaterThan(0);

    // The same aeroplane, same throttle, on a road: rolls and stays rolling.
    const road = map.vehicleSpawns[0]!;
    const onRoad = fly('plane', { x: road.x, y: road.y }, 200);
    expect(onRoad.vehicles.byId[1]!.z).toBe(0);
  });

  it('a helicopter lifts from wherever it is standing', () => {
    // No runway, which is what keeps "there is an aircraft near you" true in
    // a window with no countryside in it — see vehicleHomes.test.ts.
    const road = map.vehicleSpawns[0]!;
    const up = fly('chopper', { x: road.x, y: road.y }, 120);
    expect(up.vehicles.byId[1]!.z).toBeGreaterThan(0);
    expect(getVehicleTuning('chopper').verticalTakeoff).toBe(true);
  });

  it('an aircraft in the air is over the city, not in it', () => {
    // Above the ground it stops colliding with tiles: it flies over the
    // buildings it would otherwise be stopped by. Same code path a stunt
    // jump uses — being over the city is one idea, not two.
    let solid: { x: number; y: number } | null = null;
    outer: for (let ty = 4; ty < map.heightTiles - 4; ty++) {
      for (let tx = 4; tx < map.widthTiles - 4; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] === T_BUILDING) {
          solid = { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
          break outer;
        }
      }
    }
    expect(solid).not.toBeNull();

    const state = createGameState(4);
    const v = createVehicle(1, 'chopper', { x: solid!.x - 200, y: solid!.y }, 0);
    v.driverId = 1;
    insertEntity(state.vehicles, v);
    // Get it up first, then fly it at the building.
    for (let i = 0; i < 120; i++) driveVehicle(v, 1, 0, map, state, state, []);
    expect(v.z).toBeGreaterThan(0);
    const before = v.pos.x;
    for (let i = 0; i < 120; i++) driveVehicle(v, 1, 0, map, state, state, []);
    // Went straight past where the wall is.
    expect(v.pos.x).toBeGreaterThan(before + 100);
  });

  it('...and comes down when the power comes off', () => {
    const road = map.vehicleSpawns[0]!;
    const state = createGameState(5);
    const v = createVehicle(1, 'chopper', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    insertEntity(state.vehicles, v);
    for (let i = 0; i < 120; i++) driveVehicle(v, 1, 0, map, state, state, []);
    const high = v.z;
    expect(high).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) driveVehicle(v, 0, 0, map, state, state, []);
    expect(v.z).toBe(0);
  });

  it('nothing with wheels ever leaves the ground by itself', () => {
    // `stepAltitude` runs for every vehicle in the game; `medium` is what
    // keeps it one comparison and out for all but two of them.
    const road = map.vehicleSpawns[0]!;
    for (const kind of ['car', 'bus', 'moto', 'tank', 'boat']) {
      expect(getVehicleTuning(kind).medium, kind).not.toBe('air');
      const s = fly(kind, { x: road.x, y: road.y }, 120);
      expect(s.vehicles.byId[1]!.z, kind).toBe(0);
    }
  });
});
