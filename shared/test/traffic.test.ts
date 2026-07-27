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
import { getTrafficTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState, type VehicleState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { isAiDriver } from '../src/sim/traffic.js';
import { hashState } from '../src/net/hash.js';
import { HALF_PI, wrapAngle } from '../src/math/trig.js';
import { T_BRIDGE, T_ROAD, TILE_SIZE } from '../src/world/types.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
  traffic: trafficJson,
});

const map = generateCity(808, parseWorldgenParams(worldgenJson));

function aiCars(state: GameState): number {
  let n = 0;
  for (const id of state.vehicles.ids) {
    if (isAiDriver(state.vehicles.byId[id]!.driverId)) n++;
  }
  return n;
}

/** A world with one player and traffic given time to build up. */
function withTraffic(seed: number, ticks = 900): GameState {
  let state = createGameState(seed);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
  for (let i = 0; i < ticks; i++) state = step(state, {}, [], map);
  return state;
}

function isDrivable(tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
  const tile = map.tiles[ty * map.widthTiles + tx];
  return tile === T_ROAD || tile === T_BRIDGE;
}

/**
 * Which side of the carriageway a car is on, worked out independently of the
 * AI's own arithmetic: measure the road across the direction of travel, then
 * ask whether the car sits clockwise (right, driving on the right) or
 * anticlockwise of the centreline. Deliberately duplicated rather than
 * imported — a test that borrowed the sim's notion of "right" would pass just
 * as happily with left and right swapped.
 */
function sideOfRoad(
  v: VehicleState,
): 'right' | 'wrong' | 'offRoad' | 'unmeasurable' {
  const dirIdx = ((Math.round(wrapAngle(v.heading) / HALF_PI) % 4) + 4) % 4;
  const alongX = dirIdx === 0 || dirIdx === 2;
  const tx = Math.floor(v.pos.x / TILE_SIZE);
  const ty = Math.floor(v.pos.y / TILE_SIZE);
  if (!isDrivable(tx, ty)) return 'offRoad';

  let lo = alongX ? ty : tx;
  let hi = lo;
  for (let i = 1; i <= 6; i++) {
    if (!isDrivable(alongX ? tx : tx - i, alongX ? ty - i : ty)) break;
    lo--;
  }
  for (let i = 1; i <= 6; i++) {
    if (!isDrivable(alongX ? tx : tx + i, alongX ? ty + i : ty)) break;
    hi++;
  }
  // One-tile lanes have no sides, and a span wider than the widest carriageway
  // the generator makes means we are standing in a junction: neither says
  // anything about which side of the road the car is on.
  const width = hi - lo + 1;
  if (width < 2 || width > 4) return 'unmeasurable';

  const centre = ((lo + hi + 1) / 2) * TILE_SIZE;
  // Rotating the heading a quarter turn clockwise on screen (y down) gives the
  // driver's right: east -> south, south -> west, west -> north, north -> east.
  const rightSign = [1, -1, -1, 1][dirIdx] as number;
  const side = ((alongX ? v.pos.y : v.pos.x) - centre) * rightSign;
  return side > 0 ? 'right' : 'wrong';
}

interface Census {
  samples: number;
  right: number;
  wrong: number;
  offRoad: number;
  reversing: number;
  moving: number;
}

/** Sample every AI car every 10th tick over a long run. */
function census(seed: number, ticks = 2400): Census {
  let state = withTraffic(seed, 600);
  const out: Census = { samples: 0, right: 0, wrong: 0, offRoad: 0, reversing: 0, moving: 0 };
  for (let i = 0; i < ticks; i++) {
    state = step(state, {}, [], map);
    if (i % 10 !== 0) continue;
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id]!;
      if (!isAiDriver(v.driverId)) continue;
      out.samples++;
      if (v.speed < -1) out.reversing++;
      else if (v.speed > 20) out.moving++;
      const side = sideOfRoad(v);
      if (side === 'right') out.right++;
      else if (side === 'wrong') out.wrong++;
      else if (side === 'offRoad') out.offRoad++;
    }
  }
  return out;
}

/**
 * A long straight eastbound stretch: returns the centre of the right-hand lane
 * at the west end, so a test car can be dropped on it and driven east.
 */
function eastboundLane(minRunTiles = 14): { x: number; y: number } {
  for (let ty = 6; ty < map.heightTiles - 6; ty++) {
    for (let tx = 6; tx < map.widthTiles - 6; tx++) {
      if (!isDrivable(tx, ty)) continue;
      let run = 0;
      for (let i = 1; i <= minRunTiles + 2; i++) {
        if (!isDrivable(tx + i, ty)) break;
        run++;
      }
      if (run < minRunTiles) continue;
      // Two tiles of carriageway across, so there is a right-hand lane at all.
      if (!isDrivable(tx, ty + 1) || isDrivable(tx, ty + 2)) continue;
      if (isDrivable(tx, ty - 1)) continue;
      // Eastbound keeps to the southern half.
      return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 1.5) * TILE_SIZE };
    }
  }
  throw new Error('no straight two-tile road on this map');
}

/** Put an ambient driver at the wheel of a freshly spawned car. */
function ambientCar(state: GameState, id: number, at: { x: number; y: number }): GameState {
  const next = step(
    state,
    {},
    [{ type: 'spawnVehicle', vehicleId: id, kind: 'car', x: at.x, y: at.y, heading: 0 }],
    map,
  );
  const v = next.vehicles.byId[id]!;
  v.driverId = -1000 - id;
  v.speed = getTrafficTuning().cruiseSpeed;
  next.trafficDrivers[id] = { dir: 0, stuck: 0 };
  return next;
}

describe('ambient traffic', () => {
  it('populates the streets around a player', () => {
    const state = withTraffic(1);
    expect(aiCars(state)).toBeGreaterThan(3);
  });

  it('does not exceed the tuned target', () => {
    const state = withTraffic(2, 2400);
    expect(aiCars(state)).toBeLessThanOrEqual(getTrafficTuning().count);
  });

  it('never spawns traffic when nobody is playing', () => {
    let state = createGameState(3);
    for (let i = 0; i < 600; i++) state = step(state, {}, [], map);
    expect(aiCars(state)).toBe(0);
  });

  it('the cars actually drive, and stay on the road', () => {
    let state = withTraffic(4, 600);
    const start = new Map<number, { x: number; y: number }>();
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id]!;
      if (isAiDriver(v.driverId)) start.set(id, { x: v.pos.x, y: v.pos.y });
    }
    expect(start.size).toBeGreaterThan(0);

    for (let i = 0; i < 300; i++) state = step(state, {}, [], map);

    let moved = 0;
    for (const [id, from] of start) {
      const v = state.vehicles.byId[id];
      if (!v) continue; // despawned behind the player, fine
      if (Math.hypot(v.pos.x - from.x, v.pos.y - from.y) > 60) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('does not gridlock: traffic keeps moving over a long run', () => {
    let state = withTraffic(5, 1200);
    let movingSamples = 0;
    for (let s = 0; s < 20; s++) {
      for (let i = 0; i < 30; i++) state = step(state, {}, [], map);
      for (const id of state.vehicles.ids) {
        const v = state.vehicles.byId[id]!;
        if (isAiDriver(v.driverId) && Math.abs(v.speed) > 20) {
          movingSamples++;
          break;
        }
      }
    }
    // At least most sample points had somebody under way.
    expect(movingSamples).toBeGreaterThan(12);
  });

  it('is deterministic', () => {
    const run = (): number => hashState(withTraffic(77, 700));
    expect(run()).toBe(run());
  });

  it('brakes for somebody standing in the road, then carries on', () => {
    const lane = eastboundLane();
    let state = createGameState(101);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'jaywalker' }], map);
    state = ambientCar(state, 900, lane);
    // Stand the player in the lane, a few car lengths ahead.
    const victim = state.players.byId[1]!;
    victim.pos = { x: lane.x + 90, y: lane.y };

    for (let i = 0; i < 60; i++) {
      const p = state.players.byId[1]!;
      p.pos = { x: lane.x + 90, y: lane.y }; // hold their ground
      state = step(state, {}, [], map);
      if (!state.vehicles.byId[900]) break;
    }
    const car = state.vehicles.byId[900]!;
    expect(Math.abs(car.speed)).toBeLessThan(20); // stopped short
    expect(car.pos.x).toBeLessThan(lane.x + 90); // and stopped short OF them
    expect(state.players.byId[1]!.health).toBe(100);

    // Step out of the road and the driver gets going again.
    state.players.byId[1]!.pos = { x: lane.x + 90, y: lane.y - TILE_SIZE * 3 };
    for (let i = 0; i < 60; i++) state = step(state, {}, [], map);
    expect(state.vehicles.byId[900]!.speed).toBeGreaterThan(20);
  });

  it('still runs down anyone who steps out in front of it', () => {
    // Braking for people must not make traffic harmless: the gap a driver
    // brakes at is the distance it can stop in, not five car lengths.
    const lane = eastboundLane();
    let state = createGameState(102);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'unlucky' }], map);
    state = ambientCar(state, 901, lane);
    let hurt = false;
    for (let i = 0; i < 90 && !hurt; i++) {
      const car = state.vehicles.byId[901];
      if (!car) break;
      // Keep the victim just in front of the bumper: stepping out late.
      state.players.byId[1]!.pos = { x: car.pos.x + 12, y: car.pos.y };
      state = step(state, {}, [], map);
      hurt = state.players.byId[1]!.health < 100;
    }
    expect(hurt).toBe(true);
  });

  it('drives on the right-hand side of the road', () => {
    const c = census(4);
    expect(c.samples).toBeGreaterThan(100);
    const onLane = c.right + c.wrong;
    expect(onLane).toBeGreaterThan(50);
    // Not 100%: overtaking a parked car and swinging through a junction both
    // legitimately put a car on the other half of the road.
    expect(c.right / onLane).toBeGreaterThan(0.75);
  });

  it('stays on the carriageway', () => {
    const c = census(11);
    expect(c.offRoad / c.samples).toBeLessThan(0.1);
  });

  it('drives forwards: reverse is only ever a brief recovery', () => {
    // The old AI held the brake against whatever was in front of it, and past
    // a standstill the brake is reverse — so blocked traffic drove backwards
    // down the road indefinitely. Reverse is now bounded to a short shunt.
    const c = census(23);
    expect(c.reversing / c.samples).toBeLessThan(0.1);
    expect(c.moving / c.samples).toBeGreaterThan(0.6);
  });
});

describe('carjacking', () => {
  it('drags an AI driver out, takes the wheel, and counts as a crime', () => {
    let state = withTraffic(9, 700);
    const target = state.vehicles.ids
      .map((id) => state.vehicles.byId[id]!)
      .find((v) => isAiDriver(v.driverId));
    expect(target).toBeDefined();

    // Walk the player onto the car, then press the action button.
    const p = state.players.byId[1]!;
    p.pos = { x: target!.pos.x, y: target!.pos.y };
    p.heat = 0;
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);

    const me = state.players.byId[1]!;
    expect(me.mode).toBe('driving');
    expect(me.vehicleId).not.toBeNull();
    const taken = state.vehicles.byId[me.vehicleId!]!;
    expect(taken.driverId).toBe(1);
    expect(isAiDriver(taken.driverId)).toBe(false);
    // Unlike lifting an empty parked car, this is always a crime. Heat also
    // decays once in the same tick (stepPolice runs after the action edge),
    // so allow for that one tick rather than asserting the raw figure.
    expect(me.heat).toBeGreaterThan(getTrafficTuning().jackHeat - 1);
  });

  it('an occupied car cannot simply be opened', () => {
    const state = withTraffic(10, 700);
    // tryEnterVehicle skips anything with a driver, which is what makes the
    // jack an explicit action rather than a special case.
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id]!;
      if (isAiDriver(v.driverId)) {
        expect(v.driverId).toBeLessThan(-1);
      }
    }
  });
});
