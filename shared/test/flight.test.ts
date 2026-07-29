import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, createVehicle, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { roadLane } from './helpers.js';
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

/**
 * Landing, through the door the game uses.
 *
 * The tests above call `driveVehicle` directly, and that is exactly why they
 * missed two bugs that shipped: a helicopter you stepped out of hung at
 * cruise height for ever, and the pilot arrived on the ground unhurt from
 * eight storeys up. Neither is visible from inside `driveVehicle` — one lives
 * in the coasting path and the other in the exit path. These drive `step()`
 * with ordinary input, which is the only entry point that sees all of it.
 */
describe('landing (S2, through step)', () => {
  /** A player at the controls of a chopper, already at cruise height. */
  function aloft(seed: number): { state: GameState; lane: { x: number; y: number } } {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'pilot' }], map);
    const lane = roadLane(map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'chopper', x: lane.x, y: lane.y, heading: 0 }],
      map,
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    for (let i = 0; i < 150; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true } }, [], map);
    }
    return { state, lane };
  }

  it('a player can get into an aircraft and take off with the ordinary keys', () => {
    const { state } = aloft(30);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.vehicles.byId[2]!.z).toBeGreaterThan(0);
  });

  it('an aircraft nobody is flying comes down', () => {
    // It used to hang at cruise height for ever, because the altitude lived
    // in `driveVehicle` and a driverless vehicle never goes through it.
    const { state } = aloft(31);
    let s = state;
    const high = s.vehicles.byId[2]!.z;
    expect(high).toBeGreaterThan(0);
    s = step(s, { 1: { ...NULL_INPUT, seq: 900, tick: 900 } }, [], map);
    s = step(s, { 1: { ...NULL_INPUT, seq: 901, tick: 901, action: true } }, [], map);
    expect(s.players.byId[1]!.mode).toBe('foot');
    for (let i = 0; i < 300; i++) s = step(s, {}, [], map);
    expect(s.vehicles.byId[2]!.z).toBe(0);
  });

  it('stepping out at altitude is a fall, not a teleport', () => {
    // The player used to appear on the ground unhurt from cruise height,
    // which made bailing out the cheapest way to end a flight.
    const { state } = aloft(32);
    let s = state;
    s.players.byId[1]!.health = 100;
    const z = s.vehicles.byId[2]!.z;
    s = step(s, { 1: { ...NULL_INPUT, seq: 900, tick: 900 } }, [], map);
    s = step(s, { 1: { ...NULL_INPUT, seq: 901, tick: 901, action: true } }, [], map);
    const me = s.players.byId[1]!;
    expect(me.mode).toBe('foot');
    // Out of the aircraft AND still up there. Within a tick's worth of
    // descent of where it was: releasing the throttle to press the door key
    // costs one `climbRate * DT`.
    expect(me.z).toBeGreaterThan(z - 3);
    expect(me.z).toBeGreaterThan(0);

    let ticks = 0;
    for (; ticks < 300; ticks++) {
      s = step(s, {}, [], map);
      if (s.players.byId[1]!.z === 0) break;
    }
    // It took time to come down, and it cost something.
    expect(ticks).toBeGreaterThan(3);
    expect(s.players.byId[1]!.z).toBe(0);
    expect(s.players.byId[1]!.health).toBeLessThan(100);
  });

  it('a bail-out from cruise height is expensive, not fatal', () => {
    // The drop and the airspeed used to bill separately for the same jump:
    // fall damage from `stepStunts` plus `tryExitVehicle`'s road rash, which
    // left a full-health player on 3. Road rash is the ground taking your
    // speed off you and there is no ground up there, so only the fall pays.
    const { state } = aloft(35);
    let s = state;
    s.players.byId[1]!.health = 100;
    s = step(s, { 1: { ...NULL_INPUT, seq: 900, tick: 900 } }, [], map);
    s = step(s, { 1: { ...NULL_INPUT, seq: 901, tick: 901, action: true } }, [], map);
    for (let i = 0; i < 300; i++) {
      s = step(s, {}, [], map);
      if (s.players.byId[1]!.z === 0) break;
    }
    const health = s.players.byId[1]!.health;
    // Roughly a third left: enough to run, not enough to do it twice.
    expect(health).toBeGreaterThan(20);
    expect(health).toBeLessThan(50);
  });

  it('...and stepping out on the ground still does not', () => {
    // The fall must not tax an ordinary door. Same exit path, no altitude.
    let s = createGameState(33);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p' }], map);
    const lane = roadLane(map);
    s.players.byId[1]!.pos = { x: lane.x, y: lane.y };
    s = step(
      s,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: lane.x, y: lane.y, heading: 0 }],
      map,
    );
    s = step(s, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    s.players.byId[1]!.health = 100;
    // The door is edge-triggered — a held key is one press, not thirty a
    // second — so getting back out needs the key released in between.
    s = step(s, { 1: { ...NULL_INPUT, seq: 2, tick: 2 } }, [], map);
    s = step(s, { 1: { ...NULL_INPUT, seq: 3, tick: 3, action: true } }, [], map);
    expect(s.players.byId[1]!.mode).toBe('foot');
    expect(s.players.byId[1]!.z).toBe(0);
    expect(s.players.byId[1]!.health).toBe(100);
  });

  it('a landed aircraft is an ordinary vehicle again', () => {
    // Down means down: it collides with the city like anything else, rather
    // than sliding through it at z of nought-point-something.
    const { state } = aloft(34);
    let s = state;
    for (let i = 0; i < 400; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 500, tick: i + 500 } }, [], map);
      if (s.vehicles.byId[2]!.z === 0) break;
    }
    expect(s.vehicles.byId[2]!.z).toBe(0);
    expect(s.players.byId[1]!.mode).toBe('driving'); // still at the controls
  });
});
