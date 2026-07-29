import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import {
  createGameState,
  createPlayer,
  createVehicle,
  type GameState,
  type VehicleState,
} from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { roadLane } from './helpers.js';
import { insertEntity } from '../src/sim/entities.js';
import {
  canTakeOff,
  driveVehicle,
  stepVehicleCoasting,
  stepVehicleDriving,
} from '../src/sim/vehicle.js';
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

/**
 * The west end of a runway, and enough of it ahead to build up speed on.
 *
 * `runwayTile` answers "is there any runway at all", which is a question about
 * worldgen. Taking off is a question about a RUN, and a plane pointed east off
 * the first tile of a north-south strip is on grass by the time it is fast
 * enough — so this finds a tile with a genuine eastward run in front of it.
 */
function runwayRunEast(m: CityMap, needTiles = 8): { x: number; y: number } | null {
  const at = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < m.widthTiles && ty < m.heightTiles &&
    m.tiles[ty * m.widthTiles + tx] === T_RUNWAY;
  for (let ty = 0; ty < m.heightTiles; ty++) {
    for (let tx = 0; tx < m.widthTiles; tx++) {
      if (!at(tx, ty)) continue;
      let run = 0;
      while (at(tx + run, ty)) run++;
      if (run >= needTiles) return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
    }
  }
  return null;
}

/**
 * One vehicle, under power, for N ticks, with the pilot reaching for the
 * take-off latch on every one of them.
 *
 * Held rather than tapped, and that is the point of the shape: the latch is
 * edge-triggered, so holding it presses it exactly once — which is also what
 * stops a leant-on key toggling thirty times a second in a real session. The
 * press lands on the first tick, when a wing is still standing still, so a
 * plane has to be given its run-up separately; see `rollThenLift`.
 */
function fly(kind: string, at: { x: number; y: number }, ticks: number): GameState {
  const state = createGameState(3);
  const v = createVehicle(1, kind, at, 0);
  v.driverId = 1;
  insertEntity(state.vehicles, v);
  const lift = { ...NULL_INPUT, up: true, lift: true };
  for (let i = 0; i < ticks; i++) {
    stepVehicleDriving(v, lift, map, state, state, []);
  }
  return state;
}

/**
 * A wing: roll first, then ask for the air. Two phases because that IS the
 * rule — a plane that has not built up speed on a runway will refuse, and the
 * refusal is the whole reason the airstrip is a destination.
 */
function rollThenLift(
  kind: string,
  at: { x: number; y: number },
  rollTicks: number,
  climbTicks: number,
): GameState {
  const state = createGameState(3);
  const v = createVehicle(1, kind, at, 0);
  v.driverId = 1;
  insertEntity(state.vehicles, v);
  const roll = { ...NULL_INPUT, up: true };
  for (let i = 0; i < rollTicks; i++) stepVehicleDriving(v, roll, map, state, state, []);
  const lift = { ...roll, lift: true };
  for (let i = 0; i < climbTicks; i++) stepVehicleDriving(v, lift, map, state, state, []);
  return state;
}

describe('flight (S2)', () => {
  it('the city has an airstrip, and it is made of runway', () => {
    expect(strip).toBeDefined();
    expect(runwayTile(map)).not.toBeNull();
  });

  it('a plane needs a runway: a field is not one', () => {
    // The rule that makes the airstrip a destination rather than scenery.
    const rw = runwayRunEast(map)!;
    expect(rw).not.toBeNull();
    // Long enough a run to pass `takeoffSpeed`, short enough to still be on
    // the strip when the key goes down.
    const onStrip = rollThenLift('plane', rw, 45, 100);
    expect(onStrip.vehicles.byId[1]!.z).toBeGreaterThan(0);

    // The same aeroplane, same run-up, same key, on a road: rolls and stays
    // rolling. The latch refuses rather than lifting it out of a side street.
    const road = map.vehicleSpawns[0]!;
    const onRoad = rollThenLift('plane', { x: road.x, y: road.y }, 45, 100);
    expect(onRoad.vehicles.byId[1]!.z).toBe(0);
  });

  it('the take-off key is what leaves the ground, not the throttle', () => {
    // The whole of the control change. Full throttle, never touching the
    // latch: a helicopter that used to be at cruise height inside two seconds
    // now stays exactly where it is, and the throttle means airspeed.
    const road = map.vehicleSpawns[0]!;
    const state = createGameState(9);
    const v = createVehicle(1, 'chopper', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    insertEntity(state.vehicles, v);
    for (let i = 0; i < 150; i++) {
      stepVehicleDriving(v, { ...NULL_INPUT, up: true }, map, state, state, []);
    }
    expect(v.z).toBe(0);
    expect(v.climb).toBe(false);
  });

  it('the same key puts it down again', () => {
    // Landing is a decision too, and it must not require cutting the engine:
    // the throttle stays hard down through the descent here.
    const road = map.vehicleSpawns[0]!;
    const state = createGameState(10);
    const v = createVehicle(1, 'chopper', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    insertEntity(state.vehicles, v);
    const lift = { ...NULL_INPUT, up: true, lift: true };
    const cruise = { ...NULL_INPUT, up: true };
    for (let i = 0; i < 120; i++) stepVehicleDriving(v, lift, map, state, state, []);
    expect(v.z).toBeGreaterThan(0);
    // Release, press again: the second edge is the landing.
    stepVehicleDriving(v, cruise, map, state, state, []);
    stepVehicleDriving(v, lift, map, state, state, []);
    expect(v.climb).toBe(false);
    for (let i = 0; i < 200; i++) stepVehicleDriving(v, cruise, map, state, state, []);
    expect(v.z).toBe(0);
  });

  it('a landing is never refused, wherever it is', () => {
    // `canTakeOff` gates going up. Nothing gates coming down — a control that
    // can refuse to land is a control that can strand you over the sea.
    const road = map.vehicleSpawns[0]!;
    const state = createGameState(11);
    const v = createVehicle(1, 'plane', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    v.climb = true;
    v.z = getVehicleTuning('plane').cruiseZ;
    insertEntity(state.vehicles, v);
    // Over an ordinary street, where taking off would be refused outright.
    expect(canTakeOff({ ...v, z: 0, speed: 0 }, map)).toBe(false);
    stepVehicleDriving(v, { ...NULL_INPUT, lift: true }, map, state, state, []);
    expect(v.climb).toBe(false);
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
    const lift = { ...NULL_INPUT, up: true, lift: true };
    for (let i = 0; i < 120; i++) stepVehicleDriving(v, lift, map, state, state, []);
    expect(v.z).toBeGreaterThan(0);
    const before = v.pos.x;
    for (let i = 0; i < 120; i++) stepVehicleDriving(v, lift, map, state, state, []);
    // Went straight past where the wall is.
    expect(v.pos.x).toBeGreaterThan(before + 100);
  });

  it('...and comes down when the latch is dropped', () => {
    const road = map.vehicleSpawns[0]!;
    const state = createGameState(5);
    const v = createVehicle(1, 'chopper', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    insertEntity(state.vehicles, v);
    const lift = { ...NULL_INPUT, up: true, lift: true };
    for (let i = 0; i < 120; i++) stepVehicleDriving(v, lift, map, state, state, []);
    const high = v.z;
    expect(high).toBeGreaterThan(0);
    v.climb = false;
    for (let i = 0; i < 200; i++) driveVehicle(v, 0, 0, map, state, state, []);
    expect(v.z).toBe(0);
  });

  it('nothing with wheels ever leaves the ground by itself', () => {
    // `stepAltitude` runs for every vehicle in the game; `medium` is what
    // keeps it one comparison and out for all but two of them.
    const road = map.vehicleSpawns[0]!;
    for (const kind of ['car', 'bus', 'moto', 'tank', 'boat']) {
      expect(getVehicleTuning(kind).medium, kind).not.toBe('air');
      // Mashing the take-off key in a bus does nothing at all, which is the
      // other half of "one comparison and out".
      const s = fly(kind, { x: road.x, y: road.y }, 120);
      expect(s.vehicles.byId[1]!.z, kind).toBe(0);
      expect(s.vehicles.byId[1]!.climb, kind).toBe(false);
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
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true, lift: true } },
        [],
        map,
      );
    }
    return { state, lane };
  }

  it('a player can get into an aircraft and take off with the take-off key', () => {
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
    // Ask to come down: release the key, then press it again. A latch does not
    // fall open when you stop holding it — that is the whole point of it.
    s = step(s, { 1: { ...NULL_INPUT, seq: 400, tick: 400 } }, [], map);
    s = step(s, { 1: { ...NULL_INPUT, seq: 401, tick: 401, lift: true } }, [], map);
    expect(s.vehicles.byId[2]!.climb).toBe(false);
    for (let i = 0; i < 400; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: i + 500, tick: i + 500 } }, [], map);
      if (s.vehicles.byId[2]!.z === 0) break;
    }
    expect(s.vehicles.byId[2]!.z).toBe(0);
    expect(s.players.byId[1]!.mode).toBe('driving'); // still at the controls
  });
});

/**
 * Ways to stop being the pilot, and what happens to the aircraft.
 *
 * The latch is a fact about the vehicle, not about the person, so every path
 * that empties a cockpit has to bring it down — and there are several: the
 * door, a disconnect, dying, and the fire. Any one of them forgetting leaves a
 * helicopter hovering at cruise height for the rest of the session, where
 * nobody can reach it and nothing can clear it.
 */
describe('an aircraft nobody is flying comes down, however it was emptied', () => {
  /** A chopper at cruise height with a player at the controls. */
  function flying(seed: number): { state: GameState; v: VehicleState } {
    const state = createGameState(seed);
    const road = map.vehicleSpawns[0]!;
    const p = createPlayer(1, 'pilot', { x: road.x, y: road.y });
    p.mode = 'driving';
    p.vehicleId = 2;
    insertEntity(state.players, p);
    const v = createVehicle(2, 'chopper', { x: road.x, y: road.y }, 0);
    v.driverId = 1;
    v.climb = true;
    v.z = getVehicleTuning('chopper').cruiseZ;
    insertEntity(state.vehicles, v);
    return { state, v };
  }

  /** Coast it for a while and report the altitude it settles at. */
  function settle(state: GameState, v: VehicleState, ticks = 200): number {
    for (let i = 0; i < ticks; i++) stepVehicleCoasting(v, map, state, state, []);
    return v.z;
  }

  it('the pilot simply vanishing — a disconnect — is enough', () => {
    // `despawnPlayer` clears `driverId` and nothing else. It does not know
    // about flight and should not have to.
    const { state, v } = flying(60);
    v.driverId = null;
    expect(v.climb).toBe(true); // the latch is untouched: this is the point
    expect(settle(state, v)).toBe(0);
  });

  it('...and a burning one comes down with the latch still set', () => {
    const { state, v } = flying(61);
    v.condition = 'burning';
    expect(settle(state, v)).toBe(0);
  });

  it('...and a wreck does not hover', () => {
    const { state, v } = flying(62);
    v.condition = 'wreck';
    expect(settle(state, v)).toBe(0);
  });

  it('but a pilot who is still aboard stays up', () => {
    // The control case. Without it the three above pass on an aircraft that
    // can no longer fly at all.
    const { state, v } = flying(63);
    expect(settle(state, v)).toBe(getVehicleTuning('chopper').cruiseZ);
  });
});
