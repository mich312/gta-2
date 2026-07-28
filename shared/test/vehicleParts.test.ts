import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, createVehicle, type GameState, type VehicleState } from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import { hashState } from '../src/net/hash.js';
import type { SimEvent } from '../src/sim/events.js';
import type { SimCommand } from '../src/sim/commands.js';
import {
  PART_BUMPER_F,
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_RADIATOR,
  PART_TAILLIGHT_L,
  PART_TYRE_FL,
  PART_TYRE_FR,
  PARTS_MECHANICAL,
  ZONE_FRONT,
  ZONE_LEFT,
  ZONE_REAR,
  ZONE_RIGHT,
  damageVehicle,
  partsSteerPull,
  vehiclePower,
  zoneOfLocal,
} from '../src/sim/vehicleDamage.js';
import { roadLane } from './helpers.js';

beforeAll(() => {
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
});

const map = generateCity(2024, parseWorldgenParams(worldgenJson));

/** A lone car, parked, with nothing else in the world to complicate it. */
function loneCar(kind = 'car'): { state: GameState; car: VehicleState } {
  const state = createGameState(5);
  const car = createVehicle(70, kind, { x: 400, y: 400 }, 0); // pointing +x
  insertEntity(state.vehicles, car);
  return { state, car };
}

describe('the damage map', () => {
  it('splits the body into quadrants at 45°', () => {
    expect(zoneOfLocal(10, 0)).toBe(ZONE_FRONT);
    expect(zoneOfLocal(-10, 0)).toBe(ZONE_REAR);
    expect(zoneOfLocal(0, 10)).toBe(ZONE_RIGHT);
    expect(zoneOfLocal(0, -10)).toBe(ZONE_LEFT);
    // Dead on the diagonal resolves to the long axis, deterministically.
    expect(zoneOfLocal(10, 10)).toBe(ZONE_FRONT);
    expect(zoneOfLocal(-10, -10)).toBe(ZONE_REAR);
  });

  it('routes a hit to the end that took it', () => {
    const { state, car } = loneCar();
    const events: SimEvent[] = [];
    // Hit square on the nose. The car points +x, so that is +x of its centre.
    damageVehicle(state, car, 20, events, null, car.pos.x + 12, car.pos.y);
    expect(car.zones[ZONE_FRONT]).toBe(20);
    expect(car.zones[ZONE_REAR]).toBe(0);
    expect(car.zones[ZONE_LEFT]).toBe(0);
    expect(car.zones[ZONE_RIGHT]).toBe(0);

    // ...and one in the back goes in the back.
    damageVehicle(state, car, 9, events, null, car.pos.x - 12, car.pos.y);
    expect(car.zones[ZONE_REAR]).toBe(9);
    expect(car.zones[ZONE_FRONT]).toBe(20);
  });

  it('turns with the car: the same world point hits a different end', () => {
    const { state, car } = loneCar();
    car.heading = Math.PI; // now pointing -x
    damageVehicle(state, car, 12, [], null, car.pos.x + 12, car.pos.y);
    // The point is still to the +x of the centre, but that is now the BACK.
    expect(car.zones[ZONE_REAR]).toBe(12);
    expect(car.zones[ZONE_FRONT]).toBe(0);
  });

  it('breaks the lamps on an end one at a time', () => {
    const { state, car } = loneCar();
    const max = getVehicleTuning('car').health; // 200
    const nose = (): [number, number] => [car.pos.x + 12, car.pos.y];

    // 4% takes the bumper and nothing else.
    damageVehicle(state, car, max * 0.05, [], null, ...nose());
    expect(car.broken & PART_BUMPER_F).toBeTruthy();
    expect(car.broken & PART_HEADLIGHT_L).toBeFalsy();

    // Past 7%: one lamp. This is the state the model could never express —
    // every light on a car used to be a single boolean.
    damageVehicle(state, car, max * 0.03, [], null, ...nose());
    expect(car.broken & PART_HEADLIGHT_L).toBeTruthy();
    expect(car.broken & PART_HEADLIGHT_R).toBeFalsy();

    // Past 11%: the pair.
    damageVehicle(state, car, max * 0.05, [], null, ...nose());
    expect(car.broken & PART_HEADLIGHT_R).toBeTruthy();
    // ...and nothing at the back has been touched by any of it.
    expect(car.broken & PART_TAILLIGHT_L).toBeFalsy();
  });

  it('announces each part as it goes, so the client can put glass on it', () => {
    const { state, car } = loneCar();
    const events: SimEvent[] = [];
    damageVehicle(
      state,
      car,
      getVehicleTuning('car').health * 0.2,
      events,
      null,
      car.pos.x + 12,
      car.pos.y,
    );
    const broke = events.filter((e) => e.type === 'vehiclePartBroke');
    expect(broke.length).toBeGreaterThanOrEqual(3); // bumper, both lamps, bonnet
    expect(broke.every((e) => e.type === 'vehiclePartBroke' && e.vehicleId === car.id)).toBe(true);
  });

  it('a hit on a wheel flattens that tyre', () => {
    const { state, car } = loneCar();
    // Near-side front wheel sits at body-local (8, -5).
    damageVehicle(state, car, 5, [], null, car.pos.x + 8, car.pos.y - 5);
    expect(car.broken & PART_TYRE_FL).toBeTruthy();
    expect(car.broken & PART_TYRE_FR).toBeFalsy();
  });

  it('broken parts cost speed, and a flat pulls the car toward it', () => {
    const { car } = loneCar();
    expect(vehiclePower(car)).toBeCloseTo(1, 5);
    expect(partsSteerPull(car)).toBe(0);

    car.broken |= PART_RADIATOR;
    expect(vehiclePower(car)).toBeCloseTo(0.85, 5);
    car.broken |= PART_TYRE_FL;
    expect(vehiclePower(car)).toBeCloseTo(0.85 * 0.88, 5);
    // Near side flat drags left (negative).
    expect(partsSteerPull(car)).toBeLessThan(0);
    car.broken |= PART_TYRE_FR;
    // A matched pair cancels, which is what a matched pair does.
    expect(partsSteerPull(car)).toBeCloseTo(0, 5);
  });

  it('a bent body pulls toward the side that is bent', () => {
    const { car } = loneCar();
    car.zones[ZONE_LEFT] = 100;
    expect(partsSteerPull(car)).toBeLessThan(0);
    car.zones[ZONE_LEFT] = 0;
    car.zones[ZONE_RIGHT] = 100;
    expect(partsSteerPull(car)).toBeGreaterThan(0);
  });
});

describe('crashing', () => {
  /** Roll `kind` into a parked `into` at `speed`, once. */
  function ram(kind: string, into: string, speed: number): {
    striker: VehicleState;
    struck: VehicleState;
  } {
    const lane = roadLane(map, 260);
    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const ux = Math.cos(lane.heading);
    const uy = Math.sin(lane.heading);
    const cmds: SimCommand[] = [
      { type: 'spawnVehicle', vehicleId: 80, kind, x: lane.x, y: lane.y, heading: lane.heading },
      {
        type: 'spawnVehicle',
        vehicleId: 81,
        kind: into,
        x: lane.x + ux * 60,
        y: lane.y + uy * 60,
        heading: lane.heading,
      },
    ];
    state = step(state, {}, cmds, map);
    state.vehicles.byId[80]!.speed = speed;
    for (let i = 0; i < 30; i++) state = step(state, {}, [], map);
    return { striker: state.vehicles.byId[80]!, struck: state.vehicles.byId[81]! };
  }

  it('a single prang dents the nose — the first mark no longer takes four crashes', () => {
    const { striker } = ram('car', 'car', 200);
    // It hit something, on the front, and it shows.
    expect(striker.zones[ZONE_FRONT]).toBeGreaterThan(getVehicleTuning('car').health * 0.03);
    expect(striker.broken & PART_BUMPER_F).toBeTruthy();
    // The back of the same car is untouched.
    expect(striker.zones[ZONE_REAR]).toBe(0);
  });

  it('mass decides who comes off worse', () => {
    const carIntoBus = ram('car', 'bus', 200);
    const carLoss =
      (getVehicleTuning('car').health - carIntoBus.striker.health) / getVehicleTuning('car').health;
    const busLoss =
      (getVehicleTuning('bus').health - carIntoBus.struck.health) / getVehicleTuning('bus').health;
    // The bus used to come off WORSE than the car that hit it.
    expect(carLoss).toBeGreaterThan(busLoss * 2);

    const busIntoCar = ram('bus', 'car', 148);
    const busLoss2 =
      (getVehicleTuning('bus').health - busIntoCar.striker.health) / getVehicleTuning('bus').health;
    const carLoss2 =
      (getVehicleTuning('car').health - busIntoCar.struck.health) / getVehicleTuning('car').health;
    expect(carLoss2).toBeGreaterThan(busLoss2 * 2);
  });

  it('cars passing in adjacent lanes do not touch', () => {
    // The bug this whole geometry change exists for: opposing lanes on a
    // two-tile street are 16 px apart, the old collision square was 18 px
    // wide, and two cars passing collided eight times and lost 44% of their
    // health each without their bodies ever coming near each other.
    const lane = roadLane(map, 300);
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const ux = Math.cos(lane.heading);
    const uy = Math.sin(lane.heading);
    const px = -uy;
    const py = ux;
    state = step(state, {}, [
      { type: 'spawnVehicle', vehicleId: 90, kind: 'car', x: lane.x, y: lane.y, heading: lane.heading },
      {
        type: 'spawnVehicle',
        vehicleId: 91,
        kind: 'car',
        x: lane.x + ux * 100 + px * 16,
        y: lane.y + uy * 100 + py * 16,
        heading: lane.heading + Math.PI,
      },
    ], map);
    for (let i = 0; i < 30; i++) {
      const a = state.vehicles.byId[90];
      const b = state.vehicles.byId[91];
      if (a) a.speed = 104;
      if (b) b.speed = 104;
      state = step(state, {}, [], map);
    }
    expect(state.vehicles.byId[90]!.health).toBe(getVehicleTuning('car').health);
    expect(state.vehicles.byId[91]!.health).toBe(getVehicleTuning('car').health);
  });

  it('a burnt-out wreck has every panel off it', () => {
    const events: SimEvent[] = [];
    const { state: base, car } = loneCar();
    let state = base;
    damageVehicle(state, car, 1000, events);
    expect(car.condition).toBe('burning');
    while (state.vehicles.byId[70]?.condition === 'burning') {
      state = step(state, {}, [], map, events);
    }
    const wreck = state.vehicles.byId[70]!;
    expect(wreck.condition).toBe('wreck');
    expect(wreck.broken & PART_HEADLIGHT_L).toBeTruthy();
    expect(wreck.broken & PART_TYRE_FL).toBeTruthy();
    expect(wreck.broken & PART_RADIATOR).toBeTruthy();
  });

  it('the damage map hashes, and re-simulates identically', () => {
    const run = (): number => {
      const lane = roadLane(map, 260);
      let state = createGameState(77);
      state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
      const ux = Math.cos(lane.heading);
      const uy = Math.sin(lane.heading);
      const cmds: SimCommand[] = [];
      for (let i = 0; i < 6; i++) {
        cmds.push({
          type: 'spawnVehicle',
          vehicleId: 100 + i,
          kind: i % 2 === 0 ? 'car' : 'van',
          x: lane.x + ux * (40 + i * 30),
          y: lane.y + uy * (40 + i * 30),
          heading: lane.heading,
        });
      }
      state = step(state, {}, cmds, map);
      for (let i = 0; i < 200; i++) {
        const v = state.vehicles.byId[100];
        if (v && v.condition === 'ok') v.speed = 200;
        state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i } }, [], map);
      }
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe('putting it right', () => {
  it('panel-beating clears the bodywork but not the mechanicals', () => {
    const lane = roadLane(map, 200);
    let state = createGameState(21);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const p = state.players.byId[1]!;
    state = step(state, {}, [
      { type: 'spawnVehicle', vehicleId: 60, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 },
    ], map);
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('driving');

    const car = state.vehicles.byId[60]!;
    car.zones = [90, 40, 10, 5];
    car.broken = PART_HEADLIGHT_L | PART_BUMPER_F | PART_RADIATOR | PART_TYRE_FL;
    car.health = 60;

    state = step(state, {}, [{ type: 'repairVehicle', playerId: 1, tier: 'panel' }], map);
    const beaten = state.vehicles.byId[60]!;
    expect(beaten.zones).toEqual([0, 0, 0, 0]);
    expect(beaten.broken & PART_HEADLIGHT_L).toBeFalsy();
    expect(beaten.broken & PART_BUMPER_F).toBeFalsy();
    // ...but the radiator and the flat are still yours to deal with, and the
    // car is still a car that has been through a wall.
    expect(beaten.broken & PARTS_MECHANICAL).toBeTruthy();
    expect(beaten.health).toBe(60);

    state = step(state, {}, [{ type: 'repairVehicle', playerId: 1, tier: 'full' }], map);
    const rebuilt = state.vehicles.byId[60]!;
    expect(rebuilt.broken).toBe(0);
    expect(rebuilt.health).toBe(getVehicleTuning('car').health);
  });
});
