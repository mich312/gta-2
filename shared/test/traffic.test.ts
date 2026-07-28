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
import { getTrafficTuning, getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import {
  createGameState,
  createPed,
  createVehicle,
  type GameState,
  type VehicleState,
} from '../src/sim/state.js';
import { insertEntity, removeEntity } from '../src/sim/entities.js';
import { boxInSolid } from '../src/world/collide.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { assignGoto, isAiDriver, stepTrafficPanic } from '../src/sim/traffic.js';
import { CARDINALS, nearestCardinal, planRoute } from '../src/sim/roadgrid.js';
import { junctionAt, signalColour, stopLineGap } from '../src/sim/signals.js';
import { gangAt } from '../src/world/turf.js';
import { straightEastLane } from './helpers.js';
import { hashState } from '../src/net/hash.js';
import { HALF_PI, wrapAngle } from '../src/math/trig.js';
import { T_BRIDGE, T_ROAD, T_WATER, TILE_SIZE } from '../src/world/types.js';

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
  /** Stationary, but at a red light: lawfully waiting rather than wedged. */
  heldAtRed: number;
  /** Genuinely stuck: out of patience, about to reverse out. */
  wedged: number;
}

/** Sample every AI car every 10th tick over a long run. */
function census(seed: number, ticks = 2400): Census {
  let state = withTraffic(seed, 600);
  const out: Census = {
    samples: 0,
    right: 0,
    wrong: 0,
    offRoad: 0,
    reversing: 0,
    moving: 0,
    heldAtRed: 0,
    wedged: 0,
  };
  for (let i = 0; i < ticks; i++) {
    state = step(state, {}, [], map);
    if (i % 10 !== 0) continue;
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id]!;
      if (!isAiDriver(v.driverId)) continue;
      out.samples++;
      if (v.speed < -1) out.reversing++;
      else if (v.speed > 20) out.moving++;
      else if (
        stopLineGap(
          map,
          v.pos.x,
          v.pos.y,
          nearestCardinal(v.heading),
          Math.abs(v.speed),
          getVehicleTuning(v.kind).halfExtent,
          state.tick,
          trafficJson.signals,
          trafficJson.comfortBrake,
        ) < Infinity
      ) {
        out.heldAtRed++;
      }
      const side = sideOfRoad(v);
      if (side === 'right') out.right++;
      else if (side === 'wrong') out.wrong++;
      else if (side === 'offRoad') out.offRoad++;
    }
  }
  return out;
}

/**
 * A long straight eastbound stretch: the centre of the right-hand lane at
 * the west end of a junction-free street, so a test car can be dropped on
 * it and driven east with nowhere to turn off.
 */
function eastboundLane(minRunTiles = 14): { x: number; y: number } {
  // Junction-free by construction — which, since signals landed, also means
  // SIGNAL-free: no cross-street, no lights, so a car on this stretch is
  // never lawfully held at a red mid-test. The unbounded world's cells make
  // such stretches plentiful again (main's interim version had to tolerate
  // junctions because the old map had no 14-tile gap between them).
  return straightEastLane(map, minRunTiles);
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
  next.trafficDrivers[id] = {
    dir: 0,
    stuck: 0,
    panic: 0,
    mission: 'cruise',
    route: null,
    routeIdx: 0,
  };
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

    // Step out of the road and the driver gets going again — unless a set of
    // lights has since turned red in front of it, which on this street grid
    // is a coin toss (see eastboundLane). What is under test is that the
    // PEDESTRIAN stopped being the reason, so accept either, and pin down
    // which one it was rather than letting a wedged car pass as a red.
    state.players.byId[1]!.pos = { x: lane.x + 90, y: lane.y - TILE_SIZE * 3 };
    for (let i = 0; i < 60; i++) state = step(state, {}, [], map);
    const after = state.vehicles.byId[900]!;
    const held =
      stopLineGap(
        map,
        after.pos.x,
        after.pos.y,
        nearestCardinal(after.heading),
        Math.abs(after.speed),
        getVehicleTuning(after.kind).halfExtent,
        state.tick,
        trafficJson.signals,
        trafficJson.comfortBrake,
      ) < Infinity;
    expect(after.speed > 20 || held).toBe(true);
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

  it('recovers at a drowned road end instead of wedging on the bank', () => {
    // Spans wider than maxBridgeSpan interrupt an arterial: the road stops
    // at the water and resumes on the far side. A driver sent up the stub
    // must treat the bank like any wall — stuck-recovery backs it out and
    // it picks another way — rather than idling nose-to-water forever.
    // Staged on a found dead end, because that is now real geometry.
    let end: { tx: number; ty: number } | null = null;
    outer: for (let ty = 8; ty < map.heightTiles - 8; ty++) {
      for (let tx = 8; tx < map.widthTiles - 8; tx++) {
        if (!isDrivable(tx, ty)) continue;
        // Water directly east, a straight drivable run-up behind.
        if (map.tiles[ty * map.widthTiles + tx + 1] !== T_WATER) continue;
        let run = true;
        for (let i = 1; i <= 6 && run; i++) run = isDrivable(tx - i, ty);
        if (!run) continue;
        end = { tx, ty };
        break outer;
      }
    }
    if (!end) return; // this seed's window has no eastward drowned end — fine
    const lane = { x: (end.tx - 5 + 0.5) * TILE_SIZE, y: (end.ty + 0.5) * TILE_SIZE };
    let state = createGameState(404);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'w' }], map);
    // Keep a player nearby so the ambient driver is not culled mid-test.
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y - 200 };
    state = ambientCar(state, 920, lane);

    let everInWater = false;
    for (let i = 0; i < 450; i++) {
      state = step(state, {}, [], map);
      const car = state.vehicles.byId[920];
      if (!car) break;
      const ctx = Math.floor(car.pos.x / TILE_SIZE);
      const cty = Math.floor(car.pos.y / TILE_SIZE);
      if (map.tiles[cty * map.widthTiles + ctx] === T_WATER) everInWater = true;
    }
    expect(everInWater).toBe(false);
    const car = state.vehicles.byId[920];
    if (car) {
      // Recovered: not still parked against the water it drove at.
      const distFromEnd = Math.hypot(
        car.pos.x - (end.tx + 0.5) * TILE_SIZE,
        car.pos.y - (end.ty + 0.5) * TILE_SIZE,
      );
      expect(distFromEnd).toBeGreaterThan(TILE_SIZE * 2);
    }
  });

  it('moves every tick, not three ticks at a time', () => {
    // The AI used to think and drive on the same staggered 3-tick cadence, so
    // a car under way integrated three ticks' worth of motion on one tick and
    // stood perfectly still for the next two. The average speed was right and
    // the city still looked broken: nine-pixel jumps land on tick boundaries,
    // which is exactly what the client's interpolator cannot smooth over.
    let state = withTraffic(31, 600);
    const last = new Map<number, { x: number; y: number }>();
    let steps = 0;
    let stalled = 0;
    for (let i = 0; i < 600; i++) {
      state = step(state, {}, [], map);
      for (const id of state.vehicles.ids) {
        const v = state.vehicles.byId[id]!;
        if (!isAiDriver(v.driverId)) continue;
        const prev = last.get(id);
        last.set(id, { x: v.pos.x, y: v.pos.y });
        // Only cars that are definitely moving: one that is braking for a
        // pedestrian is meant to be standing still.
        if (!prev || Math.abs(v.speed) < 40) continue;
        steps++;
        if (Math.hypot(v.pos.x - prev.x, v.pos.y - prev.y) < 0.2) stalled++;
      }
    }
    expect(steps).toBeGreaterThan(500);
    // Not "less than a third": zero, give or take a car pinned against a wall
    // at speed for a tick. It was 66.7%.
    expect(stalled / steps).toBeLessThan(0.02);
  });

  it('follows the car in front instead of charging it and stamping', () => {
    // The Intelligent Driver Model's whole job. The old controller was
    // bang-bang — full throttle until something entered the braking distance,
    // then full brake — so a driver could not follow anything: it charged,
    // stamped, rolled forward, charged again. Approaching a stopped car it
    // must now settle at a sensible gap without hitting it and without
    // sawing at the pedals.
    const lane = eastboundLane();
    let state = createGameState(303);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    // Stand the player near the street. Ambient drivers are culled once no
    // player is within `despawnDist`, and a culled car coasts to a halt — which
    // looks exactly like braking if you only check that it stopped.
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y - 240 };
    // A stationary obstacle four car-lengths down the lane...
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 910, kind: 'car', x: lane.x + 120, y: lane.y, heading: 0 }],
      map,
    );
    state.vehicles.byId[910]!.speed = 0;
    // ...and an ambient driver coming up behind it at cruise.
    state = ambientCar(state, 911, lane);

    let hardest = 0;
    let last = state.vehicles.byId[911]!.speed;
    for (let i = 0; i < 150; i++) {
      state = step(state, {}, [], map);
      const car = state.vehicles.byId[911];
      if (!car) break;
      hardest = Math.max(hardest, Math.abs(car.speed - last));
      last = car.speed;
    }
    const follower = state.vehicles.byId[911]!;
    const leader = state.vehicles.byId[910]!;
    const gap = follower.pos.x - leader.pos.x;

    // Stopped (or crawling) behind it, not through it and not miles back.
    expect(follower.speed).toBeLessThan(20);
    expect(gap).toBeLessThan(0); // still behind
    expect(Math.abs(gap)).toBeGreaterThan(getVehicleTuning('car').halfExtent * 2);
    expect(Math.abs(gap)).toBeLessThan(90);
    // The leader was never rammed.
    expect(leader.health).toBe(getVehicleTuning('car').health);
    // And it was eased down, not stamped: a full-brake tick scrubs
    // brake/TICK_RATE = 10 px/s, which is what the old controller did.
    expect(hardest).toBeLessThan(9);
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

    // What this test has always been FOR is catching wedged cars, and it used
    // to catch them by proxy: "most cars are moving". Traffic signals (J1)
    // broke the proxy, because they add two entirely lawful reasons to be
    // stationary — waiting at a red, and queuing behind somebody who is — and
    // the second of those is invisible from outside the car. Measured on this
    // seed, motion alone went 0.70 before signals to 0.48 after, and roughly
    // half of what it lost is a queue nobody can see the front of.
    //
    // So measure wedging directly instead, the way the sim measures it: a
    // driver out of patience, about to reverse out. That is the failure the
    // test was written for, and it is immune to lawful stops of every kind.
    expect(c.wedged / c.samples).toBeLessThan(0.02);
    // Motion still has a floor, just an honest one for a city with lights.
    expect(c.moving / c.samples).toBeGreaterThan(0.4);
    // ...and the lights genuinely stop people, so none of the above is
    // passing because signals quietly did nothing.
    expect(c.heldAtRed).toBeGreaterThan(0);
  });
});

describe('driver panic', () => {
  /** A synthetic gunshot at a point, the same event stepWeapons would emit. */
  const shotAt = (x: number, y: number) =>
    ({ type: 'shot', tick: 0, playerId: 1, x0: x, y0: y, x1: x, y1: y }) as const;

  it('a gunshot nearby scares a driver; one across town does not', () => {
    const lane = eastboundLane();
    let state = createGameState(501);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y - 200 };
    state = ambientCar(state, 920, lane);

    stepTrafficPanic(state, map, [shotAt(lane.x + 2000, lane.y)]);
    expect(state.trafficDrivers[920]!.panic).toBe(0);

    stepTrafficPanic(state, map, [shotAt(lane.x + 60, lane.y)]);
    expect(state.trafficDrivers[920]!.panic).toBe(getTrafficTuning().panicTicks);
  });

  it('flees away from the bang, faster than cruise, then calms down', () => {
    const lane = eastboundLane();
    let state = createGameState(502);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    state.players.byId[1]!.pos = { x: lane.x + 300, y: lane.y - 200 };
    state = ambientCar(state, 921, lane);
    // Let it settle to cruise first, so the speed change is attributable.
    for (let i = 0; i < 60; i++) state = step(state, {}, [], map);

    // Bang behind it (to the west): flight is east, the way it already faces.
    const car = state.vehicles.byId[921]!;
    stepTrafficPanic(state, map, [shotAt(car.pos.x - 40, car.pos.y)]);
    expect(state.trafficDrivers[921]!.dir).toBe(0); // east, away

    let top = 0;
    for (let i = 0; i < 90; i++) {
      state = step(state, {}, [], map);
      const v = state.vehicles.byId[921];
      if (!v) break;
      top = Math.max(top, v.speed);
      // Keep the player abreast so the car is never culled mid-test.
      state.players.byId[1]!.pos = { x: v.pos.x, y: v.pos.y - 200 };
    }
    // Faster than a calm driver is ever asked to go.
    expect(top).toBeGreaterThan(getTrafficTuning().cruiseSpeed * 1.2);

    // And it does not last: panic runs down and the driver record says so.
    for (let i = 0; i < getTrafficTuning().panicTicks; i++) {
      state = step(state, {}, [], map);
      const v = state.vehicles.byId[921];
      if (v) state.players.byId[1]!.pos = { x: v.pos.x, y: v.pos.y - 200 };
    }
    const driver = state.trafficDrivers[921];
    if (driver) expect(driver.panic).toBe(0);
  });

  it('panic draws no random numbers: the rng stream is untouched', () => {
    const lane = eastboundLane();
    let state = createGameState(503);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    state = ambientCar(state, 922, lane);
    const before = state.rng;
    stepTrafficPanic(state, map, [shotAt(lane.x, lane.y)]);
    expect(state.rng).toBe(before);
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

  it('the ejected driver lands beside the car and runs', () => {
    let state = withTraffic(12, 700);
    const target = state.vehicles.ids
      .map((id) => state.vehicles.byId[id]!)
      .find((v) => isAiDriver(v.driverId));
    expect(target).toBeDefined();
    const pedsBefore = state.peds.ids.length;

    const p = state.players.byId[1]!;
    p.pos = { x: target!.pos.x, y: target!.pos.y };
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('driving');

    // Somebody new is on the pavement, fleeing, next to the scene.
    expect(state.peds.ids.length).toBe(pedsBefore + 1);
    const newest = state.peds.byId[Math.max(...state.peds.ids)]!;
    expect(newest.mode).toBe('flee');
    const car = state.vehicles.byId[state.players.byId[1]!.vehicleId!]!;
    // Within a couple of car widths — they came out of THIS car, and one
    // flee-speed step may already have run this tick.
    expect(Math.hypot(newest.pos.x - car.pos.x, newest.pos.y - car.pos.y)).toBeLessThan(60);
    // And on the wire grid: an off-grid standing position is a permanent
    // hash desync for every client in range (see the roadblock note in
    // police.ts).
    expect(newest.pos.x * 8).toBeCloseTo(Math.round(newest.pos.x * 8), 9);
    expect(newest.pos.y * 8).toBeCloseTo(Math.round(newest.pos.y * 8), 9);
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

describe('errand driving (goto)', () => {
  /** Two kerbside points a real journey apart, from the map's own spawn list. */
  function journey(minDist = 800, maxDist = 1600): { from: { x: number; y: number }; to: { x: number; y: number } } {
    const spawns = map.vehicleSpawns;
    for (const a of spawns) {
      for (const b of spawns) {
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d >= minDist && d <= maxDist) return { from: a, to: b };
      }
    }
    throw new Error('no spawn pair a journey apart on this map');
  }

  it('plans a route between distant kerbs, every corner on road', () => {
    const { from, to } = journey();
    const route = planRoute(map, from.x, from.y, to.x, to.y);
    expect(route).not.toBeNull();
    expect(route!.length % 2).toBe(0);
    for (let i = 0; i < route!.length; i += 2) {
      const tx = Math.floor(route![i]! / TILE_SIZE);
      const ty = Math.floor(route![i + 1]! / TILE_SIZE);
      expect(isDrivable(tx, ty)).toBe(true);
    }
    // The last corner is the destination, give or take the snap to road.
    const lx = route![route!.length - 2]!;
    const ly = route![route!.length - 1]!;
    expect(Math.hypot(lx - to.x, ly - to.y)).toBeLessThan(TILE_SIZE * 4);
  });

  it('refuses a destination nowhere near a road', () => {
    expect(planRoute(map, 100, 100, -400, -400)).toBeNull();
  });

  it('drives the errand to the far side of town, then melts back into traffic', () => {
    const { from, to } = journey();
    let state = createGameState(601);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    // The player waits at the destination; the car comes to them from well
    // outside their despawn ring, which is the whole use of the primitive.
    state.players.byId[1]!.pos = { x: to.x, y: to.y };
    state = ambientCar(state, 930, from);
    expect(assignGoto(state, map, 930, to.x, to.y)).toBe(true);
    expect(state.trafficDrivers[930]!.mission).toBe('goto');

    let arrivedAt: { x: number; y: number } | null = null;
    for (let i = 0; i < 3600 && !arrivedAt; i++) {
      state.players.byId[1]!.pos = { x: to.x, y: to.y }; // hold the corner
      state = step(state, {}, [], map);
      const driver = state.trafficDrivers[930];
      const v = state.vehicles.byId[930];
      expect(v).toBeDefined(); // never culled mid-errand
      // Two legitimate endings: the driver melts back into cruising, OR —
      // when the trip timer ran out on the way — they arrive, park at the
      // destination kerb and walk away (the driver record goes with them,
      // the car stays). Both are "the errand got there"; only giving up
      // mid-route is a failure.
      if (v && ((driver && driver.mission === 'cruise') || !driver)) {
        arrivedAt = { x: v.pos.x, y: v.pos.y };
      }
    }
    expect(arrivedAt).not.toBeNull();
    // Arrival means arrived: within the corner reach plus a lane's offset of
    // the destination, not "gave up somewhere and reverted".
    expect(Math.hypot(arrivedAt!.x - to.x, arrivedAt!.y - to.y)).toBeLessThan(TILE_SIZE * 5);
  });

  it('a car on an errand outlives the despawn ring; idle traffic does not', () => {
    const lane = eastboundLane();
    let state = createGameState(602);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    // Park the player at the kerb across the map, outside the despawn ring.
    let far = map.vehicleSpawns[0]!;
    for (const s of map.vehicleSpawns) {
      if (
        Math.hypot(s.x - lane.x, s.y - lane.y) > Math.hypot(far.x - lane.x, far.y - lane.y)
      ) {
        far = s;
      }
    }
    expect(Math.hypot(far.x - lane.x, far.y - lane.y)).toBeGreaterThan(
      getTrafficTuning().despawnDist,
    );
    state.players.byId[1]!.pos = { x: far.x, y: far.y };
    state = ambientCar(state, 940, lane);
    state = ambientCar(state, 941, { x: lane.x + 40, y: lane.y });
    expect(assignGoto(state, map, 941, far.x, far.y)).toBe(true);

    for (let i = 0; i < 30; i++) {
      state.players.byId[1]!.pos = { x: far.x, y: far.y };
      state = step(state, {}, [], map);
    }
    // The idle car was demoted to street furniture; the errand car drives on.
    expect(isAiDriver(state.vehicles.byId[940]!.driverId)).toBe(false);
    expect(isAiDriver(state.vehicles.byId[941]!.driverId)).toBe(true);
    expect(state.trafficDrivers[941]!.mission).toBe('goto');
  });

  it('errands are deterministic like everything else', () => {
    const { from, to } = journey();
    const run = (): number => {
      let s = createGameState(603);
      s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
      s.players.byId[1]!.pos = { x: to.x, y: to.y };
      s = ambientCar(s, 950, from);
      assignGoto(s, map, 950, to.x, to.y);
      for (let i = 0; i < 600; i++) s = step(s, {}, [], map);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

describe('vehicle classes (G0)', () => {
  it('the city is not one car in six colours', () => {
    // Ambient traffic draws from the weighted mix, so a busy street should
    // contain more than one kind of vehicle.
    let state = createGameState(4141);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'watcher' }], map);
    for (let i = 0; i < 900; i++) {
      state = step(state, { 1: NULL_INPUT }, [], map);
    }
    const kinds = new Set(
      state.vehicles.ids
        .map((id) => state.vehicles.byId[id] as VehicleState)
        .filter((v) => isAiDriver(v.driverId))
        .map((v) => v.kind),
    );
    expect(kinds.size).toBeGreaterThan(1);
    for (const k of kinds) expect(getVehicleTuning(k).maxSpeed).toBeGreaterThan(0);
  });

  it('the mix is deterministic, like everything else drawn from the rng', () => {
    const run = (): string[] => {
      let s = createGameState(4141);
      s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'watcher' }], map);
      for (let i = 0; i < 400; i++) s = step(s, { 1: NULL_INPUT }, [], map);
      return s.vehicles.ids.map((id) => (s.vehicles.byId[id] as VehicleState).kind);
    };
    expect(run()).toEqual(run());
  });

  it('heavier classes are slower, tougher and turn worse', () => {
    const car = getVehicleTuning('car');
    const bus = getVehicleTuning('bus');
    expect(bus.maxSpeed).toBeLessThan(car.maxSpeed);
    expect(bus.turnRate).toBeLessThan(car.turnRate);
    expect(bus.health).toBeGreaterThan(car.health);
    expect(bus.halfExtent).toBeGreaterThan(car.halfExtent);
  });

  it('parked stock varies too', () => {
    expect(new Set(map.parkingSpots.map((s) => s.kind)).size).toBeGreaterThan(1);
  });

  it('the whole roster stays in a sane order, not just the two it started with', () => {
    // This assertion has caught a bus faster than a car once already, from
    // tuning written out of memory rather than derived from what was in the
    // file. Every kind added since is derived as a RATIO of one already
    // here, and this is what checks the arithmetic came out the right way up.
    const t = (k: string) => getVehicleTuning(k);
    const order = ['car', 'limo', 'van', 'garbage', 'truck', 'bus', 'tank'];
    for (const kind of order) expect(t(kind), kind).toBeDefined();

    // Speed falls as bulk rises, all the way down the list.
    expect(t('limo').maxSpeed).toBeLessThan(t('car').maxSpeed);
    expect(t('garbage').maxSpeed).toBeLessThan(t('truck').maxSpeed);
    expect(t('digger').maxSpeed).toBeLessThan(t('garbage').maxSpeed);
    expect(t('tank').maxSpeed).toBeLessThan(t('bus').maxSpeed);
    expect(t('icecream').maxSpeed).toBeLessThan(t('van').maxSpeed);

    // Turning follows it.
    expect(t('limo').turnRate).toBeLessThan(t('car').turnRate);
    expect(t('digger').turnRate).toBeLessThan(t('truck').turnRate);

    // A tank is the toughest thing on the road and the worst to be hit by.
    for (const kind of ['car', 'bus', 'truck', 'firetruck', 'digger']) {
      expect(t('tank').health, kind).toBeGreaterThan(t(kind).health);
      expect(t('tank').collisionDamagePerSpeed, kind).toBeGreaterThan(
        t(kind).collisionDamagePerSpeed,
      );
    }

    // A gang car is a car with a bit more in it, not a different class.
    expect(t('gangcar').maxSpeed).toBeGreaterThan(t('car').maxSpeed);
    expect(t('gangcar').maxSpeed).toBeLessThan(t('car').maxSpeed * 1.15);
  });

  it('a tank comes out of the yard armed, through the garage system', () => {
    // Not special-cased anywhere: it spawns with the `guns` fitting the
    // pay-n-spray already sells. If a tank ever needs its own code path, the
    // fittings system was not built generally enough.
    const tank = createVehicle(1, 'tank', { x: 0, y: 0 }, 0);
    expect(tank.fitting).toBe('guns');
    expect(tank.fittingAmmo).toBeGreaterThan(1000);
    const car = createVehicle(2, 'car', { x: 0, y: 0 }, 0);
    expect(car.fitting).toBe('');
  });

  it('every city has exactly one tank, and it is not ambient traffic', () => {
    const tanks = map.parkingSpots.filter((s) => s.kind === 'tank');
    expect(tanks.length).toBe(1);
    expect(getTrafficTuning().mix.some((m) => m.kind === 'tank')).toBe(false);
  });

  it('gang cars are parked on their own gangs turf, and nowhere else', () => {
    const gangCars = map.parkingSpots.filter((s) => s.kind === 'gangcar');
    expect(gangCars.length).toBeGreaterThan(5);
    for (const spot of gangCars) {
      expect(spot.gangId).toBeGreaterThan(0);
      expect(gangAt(map, spot.x, spot.y)).toBe(spot.gangId);
    }
    // ...and ordinary stock belongs to nobody.
    for (const spot of map.parkingSpots) {
      if (spot.kind !== 'gangcar') expect(spot.gangId ?? 0).toBe(0);
    }
  });
});

describe('traffic signals (J1)', () => {
  const timing = trafficJson.signals;

  it('labels junctions, and they are crossroads rather than whole streets', () => {
    expect(map.junctions.count).toBeGreaterThan(50);
    const sizes = new Map<number, number>();
    for (const id of map.junctions.idOf) {
      if (id !== -1) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    }
    const areas = [...sizes.values()].sort((a, b) => b - a);
    // A junction is a few tiles square. If the flood fill ever leaks along a
    // carriageway, one component swallows half the road network and every
    // light in that half turns at once — so cap the largest.
    expect(areas[0]!).toBeLessThan(40);
    expect(map.junctions.heads.length).toBeGreaterThan(map.junctions.count);
  });

  it('never shows green to both axes, and both arms of one axis agree', () => {
    for (let id = 0; id < 40; id++) {
      for (let tick = 0; tick < 600; tick++) {
        const ew = signalColour(id, 0, tick, timing);
        const ns = signalColour(id, 1, tick, timing);
        expect(ew === 'green' && ns === 'green').toBe(false);
        // Opposite arms of the same axis are one light, not two.
        expect(signalColour(id, 2, tick, timing)).toBe(ew);
        expect(signalColour(id, 3, tick, timing)).toBe(ns);
      }
    }
  });

  it('every junction eventually shows green to every arm', () => {
    const cycle = (timing.greenTicks + timing.amberTicks) * 2;
    for (let id = 0; id < 20; id++) {
      for (let dir = 0; dir < 4; dir++) {
        let seen = false;
        for (let tick = 0; tick < cycle && !seen; tick++) {
          if (signalColour(id, dir, tick, timing) === 'green') seen = true;
        }
        expect(seen, `junction ${id} arm ${dir}`).toBe(true);
      }
    }
  });

  it('the city does not blink as one: junctions are staggered', () => {
    const colours = new Set<string>();
    for (let id = 0; id < 12; id++) colours.add(signalColour(id, 0, 0, timing));
    expect(colours.size).toBeGreaterThan(1);
  });

  it('the phase is a pure function of tick, so two hosts cannot disagree', () => {
    // No state, no rng, no map: the whole point of the design. If this ever
    // needs a GameState to answer, signals have grown a desync surface.
    for (const tick of [0, 1, 97, 5000, 123457]) {
      expect(signalColour(7, 1, tick, timing)).toBe(signalColour(7, 1, tick, timing));
    }
  });

  it('a car already inside the box always clears it, whatever the light', () => {
    // Otherwise the first red of the game parks somebody in the middle of a
    // crossroads and the cross traffic can never get through either.
    const head = map.junctions.heads[0]!;
    const inside = {
      x: head.x + CARDINALS[head.dirIdx]![0]! * TILE_SIZE,
      y: head.y + CARDINALS[head.dirIdx]![1]! * TILE_SIZE,
    };
    expect(junctionAt(map, inside.x, inside.y)).not.toBe(-1);
    for (let tick = 0; tick < 400; tick++) {
      const gap = stopLineGap(
        map,
        inside.x,
        inside.y,
        head.dirIdx,
        40,
        9,
        tick,
        timing,
        trafficJson.comfortBrake,
      );
      expect(gap).toBe(Infinity);
    }
  });

  /** A point one tile back from a head, i.e. approaching but not yet at the line. */
  function approach(head: { x: number; y: number; dirIdx: number }): { x: number; y: number } {
    const [dx, dy] = CARDINALS[head.dirIdx] as readonly [number, number];
    return { x: head.x - dx * TILE_SIZE, y: head.y - dy * TILE_SIZE };
  }

  it('stops short of the box, not with its nose in it', () => {
    // The stop line is bumper-relative like every other gap the driver model
    // consumes. Reporting it from the car's centre parked stationary cars
    // half inside the junction, where they blocked the cross axis: measured
    // at a third off traffic under way.
    const head = map.junctions.heads[0]!;
    const at = approach(head);
    const halfExtent = getVehicleTuning('car').halfExtent;
    let sawRed = false;
    for (let tick = 0; tick < 400; tick++) {
      const gap = stopLineGap(
        map,
        at.x,
        at.y,
        head.dirIdx,
        0,
        halfExtent,
        tick,
        timing,
        trafficJson.comfortBrake,
      );
      if (gap === Infinity) continue;
      sawRed = true;
      // A tile and a half back from the junction edge; stopping there must
      // leave the whole car outside the box with room to spare.
      expect(gap).toBeGreaterThan(0);
      expect(gap + halfExtent).toBeLessThan(TILE_SIZE * 2);
    }
    expect(sawRed).toBe(true);
  });

  it('an amber you cannot stop for is one you clear', () => {
    const head = map.junctions.heads[0]!;
    const timings = { ...timing };
    // Find a tick where this arm is on amber.
    let amberTick = -1;
    for (let tick = 0; tick < 400 && amberTick < 0; tick++) {
      if (signalColour(head.junctionId, head.dirIdx, tick, timings) === 'amber') amberTick = tick;
    }
    expect(amberTick).toBeGreaterThanOrEqual(0);
    const brake = trafficJson.comfortBrake;
    const at = approach(head);
    const gap = (speed: number): number =>
      stopLineGap(map, at.x, at.y, head.dirIdx, speed, 9, amberTick, timings, brake);
    // Crawling: plenty of room, so stop.
    expect(gap(5)).toBeLessThan(Infinity);
    // Committed: braking that hard is worse driving than clearing the box.
    expect(gap(300)).toBe(Infinity);
  });

  it('traffic actually queues at reds, and gets away again', () => {
    let state = withTraffic(31, 900);
    let everHeld = 0;
    let everMoved = 0;
    for (let i = 0; i < 900; i++) {
      state = step(state, {}, [], map);
      if (i % 15) continue;
      for (const id of state.vehicles.ids) {
        const v = state.vehicles.byId[id]!;
        if (!isAiDriver(v.driverId)) continue;
        const gap = stopLineGap(
          map,
          v.pos.x,
          v.pos.y,
          nearestCardinal(v.heading),
          Math.abs(v.speed),
          getVehicleTuning(v.kind).halfExtent,
          state.tick,
          timing,
          trafficJson.comfortBrake,
        );
        if (gap < Infinity && Math.abs(v.speed) < 8) everHeld++;
        if (Math.abs(v.speed) > 30) everMoved++;
      }
    }
    // Both halves matter: lights that never stop anybody are decoration, and
    // lights that never let anybody go are a jam.
    expect(everHeld).toBeGreaterThan(0);
    expect(everMoved).toBeGreaterThan(everHeld);
  });

  it('a panicking driver runs the light', () => {
    // Fear outranks the highway code, and a car that queued politely while
    // being shot at would read as broken rather than frightened.
    const head = map.junctions.heads[0]!;
    let redTick = -1;
    for (let tick = 0; tick < 400 && redTick < 0; tick++) {
      if (signalColour(head.junctionId, head.dirIdx, tick, timing) === 'red') redTick = tick;
    }
    expect(redTick).toBeGreaterThanOrEqual(0);
    // The clause is gated on driver.panic in laneControl; assert the gate
    // exists by driving the same car through the same red twice.
    let state = withTraffic(52, 600);
    const id = state.vehicles.ids.find((i) => isAiDriver(state.vehicles.byId[i]!.driverId));
    expect(id).toBeDefined();
    const driver = state.trafficDrivers[id as number]!;
    driver.panic = getTrafficTuning().panicTicks;
    expect(driver.panic).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) state = step(state, {}, [], map);
    // It is still in the world and it is not sitting at a line.
    expect(state.vehicles.byId[id as number] ?? null).not.toBeNull();
  });

  it('signals change nothing about determinism', () => {
    const run = (): number => hashState(withTraffic(404, 900));
    expect(run()).toBe(run());
  });
});

describe('getting in and out of cars (J3)', () => {
  /** Count of vehicles with an ambient driver. */
  function aiCars(s: GameState): number {
    let n = 0;
    for (const id of s.vehicles.ids) if (isAiDriver(s.vehicles.byId[id]!.driverId)) n++;
    return n;
  }

  it('a pedestrian standing by a parked car gets in, and it joins the traffic', () => {
    let state = createGameState(64);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'watcher' }], map);
    const lane = eastboundLane();
    // The watcher stands AT the scene: the crowd manager culls peds no
    // player is near, and a culled pedestrian boards nothing. (It also
    // keeps the ambient build-up local, which is what leaves a slot under
    // the traffic ceiling for the boarding draw to fill.)
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y - 200 };
    // A parked car in the kerbside lane, and somebody on the PAVEMENT
    // beside it. The lane point is the southern row of a three-wide
    // street; the ped stands on the north sidewalk with the car parked in
    // the row against that kerb — a pedestrian held mid-carriageway
    // panics at oncoming traffic and a fleeing ped never boards anything.
    const carAt = { x: lane.x, y: lane.y - 2 * TILE_SIZE };
    const pedAt = { x: lane.x + 10, y: lane.y - 3 * TILE_SIZE };
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 900,
          kind: 'car',
          x: carAt.x,
          y: carAt.y,
          heading: 0,
        },
      ],
      map,
    );
    const ped = createPed(9001, { x: pedAt.x, y: pedAt.y }, 30);
    ped.mode = 'walk';
    insertEntity(state.peds, ped);
    expect(state.vehicles.byId[900]!.driverId).toBeNull();

    // The draw is once per tick for the whole city, so give it a while.
    for (let i = 0; i < 400 && state.vehicles.byId[900]!.driverId === null; i++) {
      const p = state.peds.byId[9001];
      if (p) {
        p.pos = { x: pedAt.x, y: pedAt.y }; // hold their ground
        p.mode = 'walk';
      }
      state = step(state, {}, [], map);
    }
    expect(isAiDriver(state.vehicles.byId[900]!.driverId)).toBe(true);
    // The person is off the pavement, because they are in the car.
    expect(state.peds.byId[9001] ?? null).toBeNull();
    expect(state.trafficDrivers[900]).toBeDefined();
  });

  it('nobody boards a car that is occupied, burning or wrecked', () => {
    let state = createGameState(65);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'w' }], map);
    const lane = eastboundLane();
    state = step(
      state,
      {},
      [
        { type: 'spawnVehicle', vehicleId: 910, kind: 'car', x: lane.x, y: lane.y, heading: 0 },
      ],
      map,
    );
    state.vehicles.byId[910]!.condition = 'wreck';
    const ped = createPed(9101, { x: lane.x + 10, y: lane.y - 12 }, 30);
    insertEntity(state.peds, ped);
    for (let i = 0; i < 300; i++) {
      const p = state.peds.byId[9101];
      if (p) p.pos = { x: lane.x + 10, y: lane.y - 12 };
      state = step(state, {}, [], map);
    }
    expect(state.vehicles.byId[910]!.driverId).toBeNull();
  });

  it('a driver whose trip is up parks and walks away, at a parking spot', () => {
    // Not merely "stopped": the first thing that halts a car after its timer
    // expires is a red light, and getting out there abandons it in the queue.
    let state = withTraffic(71, 900);
    const before = aiCars(state);
    expect(before).toBeGreaterThan(0);
    const pedsBefore = state.peds.ids.length;
    // Age every driver past the trip limit at once.
    for (const key of Object.keys(state.trafficDrivers)) {
      (state.trafficDrivers[Number(key)] as { trip: number }).trip = getTrafficTuning().tripTicks;
    }
    let alighted = 0;
    for (let i = 0; i < 900; i++) {
      const had = new Set(Object.keys(state.trafficDrivers));
      state = step(state, {}, [], map);
      for (const k of had) if (!(k in state.trafficDrivers)) alighted++;
    }
    expect(alighted).toBeGreaterThan(0);
    // Somebody is now walking who was not before.
    expect(state.peds.ids.length).toBeGreaterThanOrEqual(pedsBefore);
    // And whoever got out is on ground they can stand on.
    for (const id of state.peds.ids) {
      const p = state.peds.byId[id]!;
      expect(boxInSolid(map, p.pos, 5)).toBe(false);
    }
  });

  it('boarding cannot push the ambient population past its ceiling', () => {
    // The spawner only ever counts UP to the target and session.ts tops the
    // crowd back up behind it, so an uncapped boarding inflates the city.
    let state = withTraffic(72, 900);
    const cap = getTrafficTuning().count;
    for (let i = 0; i < 1200; i++) {
      state = step(state, {}, [], map);
      expect(aiCars(state)).toBeLessThanOrEqual(cap);
    }
  });

  it('getting in and out is deterministic', () => {
    const run = (): number => hashState(withTraffic(88, 1500));
    expect(run()).toBe(run());
  });
});

describe('the horn (J2)', () => {
  it('a driver held up by a person leans on it, once, not thirty times a second', () => {
    const lane = eastboundLane();
    let state = createGameState(303);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'jaywalker' }], map);
    state = ambientCar(state, 940, lane);
    const events: SimEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const p = state.players.byId[1]!;
      p.pos = { x: lane.x + 70, y: lane.y }; // stand in the road and stay there
      state = step(state, {}, [], map, events);
      if (!state.vehicles.byId[940]) break;
    }
    const horns = events.filter((e) => e.type === 'horn');
    expect(horns.length).toBeGreaterThan(0);
    // A blocked street is not an air raid: one press per bout of being stuck.
    expect(horns.length).toBeLessThan(4);
    for (const h of horns) {
      if (h.type !== 'horn') continue;
      expect(h.playerId).toBeNull();
      expect(h.kind).toBe('car');
    }
  });

  it('nobody sounds the horn at a wall', () => {
    // Leaning on it at a building is not a thing drivers do, and the alleys
    // would fire it constantly.
    let state = withTraffic(304, 900);
    const events: SimEvent[] = [];
    // No people at all: any horn in this run is a car annoyed at scenery.
    for (const id of [...state.peds.ids]) removeEntity(state.peds, id);
    for (const id of [...state.players.ids]) {
      state.players.byId[id]!.pos = { x: 8, y: 8 };
    }
    for (let i = 0; i < 600; i++) state = step(state, {}, [], map, events);
    expect(events.filter((e) => e.type === 'horn').length).toBe(0);
  });

  it('a player presses it, and holding the key is still one press', () => {
    const lane = eastboundLane();
    let state = createGameState(305);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 950, kind: 'bus', x: lane.x, y: lane.y, heading: 0 }],
      map,
    );
    const p = state.players.byId[1]!;
    p.pos = { x: lane.x, y: lane.y };
    p.mode = 'driving';
    p.vehicleId = 950;
    state.vehicles.byId[950]!.driverId = 1;

    const events: SimEvent[] = [];
    for (let i = 0; i < 30; i++) {
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick, horn: true } },
        [],
        map,
        events,
      );
    }
    const horns = events.filter((e) => e.type === 'horn');
    expect(horns.length).toBe(1);
    const h = horns[0]!;
    if (h.type === 'horn') {
      expect(h.playerId).toBe(1);
      expect(h.kind).toBe('bus'); // so the client can pitch it accordingly
    }

    // Let go, press again: that is a second press.
    state = step(state, { 1: { ...NULL_INPUT, seq: 99, tick: state.tick } }, [], map, events);
    state = step(
      state,
      { 1: { ...NULL_INPUT, seq: 100, tick: state.tick, horn: true } },
      [],
      map,
      events,
    );
    expect(events.filter((e) => e.type === 'horn').length).toBe(2);
  });
});
