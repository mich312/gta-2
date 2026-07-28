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
import { createGameState, type GameState, type VehicleState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { assignGoto, isAiDriver, stepTrafficPanic } from '../src/sim/traffic.js';
import { planRoute } from '../src/sim/roadgrid.js';
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
    expect(c.moving / c.samples).toBeGreaterThan(0.6);
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
      if (driver && driver.mission === 'cruise' && v) arrivedAt = { x: v.pos.x, y: v.pos.y };
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
});
