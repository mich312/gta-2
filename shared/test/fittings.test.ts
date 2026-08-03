import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import fittingsJson from '../data/fittings.json';
import worldgenJson from '../data/worldgen.json';
import { getTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { turretAngle } from '../src/sim/fittings.js';
import { roadLane } from './helpers.js';

const map = generateCity(6006, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
    fittings: fittingsJson,
  });
});

/** A player at the wheel of a car with `fitting` bolted on. */
function fitted(
  fitting: string,
  ammo = 10,
  kind = 'car',
): { state: GameState; lane: ReturnType<typeof roadLane> } {
  // 120 px of clear ground behind too: the slick test rolls a victim onto
  // the fitting from 90 px back down the lane.
  const lane = roadLane(map, 300, 64, Infinity, 120);
  let state = createGameState(515);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
  state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
  state = step(
    state,
    {},
    [
      {
        type: 'spawnVehicle',
        vehicleId: 20,
        kind,
        x: lane.x,
        y: lane.y,
        heading: lane.heading,
      },
    ],
    map,
  );
  const p = state.players.byId[1]!;
  p.mode = 'driving';
  p.vehicleId = 20;
  state.vehicles.byId[20]!.driverId = 1;
  state = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting, ammo }], map);
  return { state, lane };
}

function press(state: GameState, events: SimEvent[] = []): GameState {
  const input: InputIntent = { ...NULL_INPUT, seq: 1, tick: state.tick, fitting: true };
  return step(state, { 1: input }, [], map, events);
}

describe('car fittings (G2)', () => {
  it('the garage bolts one thing on at a time, and tops up the same one', () => {
    const { state } = fitted('mine', 10);
    expect(state.vehicles.byId[20]!.fitting).toBe('mine');
    expect(state.vehicles.byId[20]!.fittingAmmo).toBe(10);
    const more = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'mine', ammo: 5 }], map);
    expect(more.vehicles.byId[20]!.fittingAmmo).toBe(15);
    const swapped = step(more, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'guns', ammo: 20 }], map);
    expect(swapped.vehicles.byId[20]!.fitting).toBe('guns');
    expect(swapped.vehicles.byId[20]!.fittingAmmo).toBe(20); // no refund, no carry-over
  });

  it('a mine is laid behind the car and spends one of them', () => {
    const { state } = fitted('mine', 3);
    const after = press(state);
    expect(after.projectiles.ids.length).toBe(1);
    const mine = after.projectiles.byId[after.projectiles.ids[0]!]!;
    expect(mine.kind).toBe('mine');
    expect(mine.ownerId).toBe(1);
    expect(after.vehicles.byId[20]!.fittingAmmo).toBe(2);
  });

  it('you cannot drive over your own mine while you are still in the car', () => {
    const { state } = fitted('mine', 3);
    let s = press(state);
    const events: SimEvent[] = [];
    for (let i = 0; i < 20; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, events);
    }
    expect(events.some((e) => e.type === 'explosion')).toBe(false);
    expect(s.projectiles.ids.length).toBe(1);
  });

  it('somebody else driving over it sets it off, once', () => {
    const { state, lane } = fitted('mine', 3);
    let s = press(state);
    const mine = s.projectiles.byId[s.projectiles.ids[0]!]!;
    // A second car, parked on top of it. The mine sees it on the very tick
    // the spawn command lands, so the events of THAT step are the ones that
    // matter — capturing only the next one measures nothing.
    const events: SimEvent[] = [];
    s = step(
      s,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 21,
          kind: 'car',
          x: mine.pos.x,
          y: mine.pos.y,
          heading: lane.heading,
        },
      ],
      map,
      events,
    );
    expect(events.filter((e) => e.type === 'explosion').length).toBe(1);
    expect(s.projectiles.ids.length).toBe(0); // consumed, and it never comes back
  });

  it('a slick takes the wheel off whoever crosses it, without damaging them', () => {
    const { state, lane } = fitted('slick', 3);
    let s = press(state);
    const slick = s.projectiles.byId[s.projectiles.ids[0]!]!;
    // Park the victim just clear of the slick, then let it roll on: the
    // spawn tick itself would trigger it before the test could read the
    // before-state.
    const away = 90;
    s = step(
      s,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 22,
          kind: 'car',
          x: slick.pos.x - Math.cos(lane.heading) * away,
          y: slick.pos.y - Math.sin(lane.heading) * away,
          heading: lane.heading,
        },
      ],
      map,
    );
    const victim = s.vehicles.byId[22]!;
    victim.speed = 150;
    const headingBefore = victim.heading;
    const healthBefore = victim.health;
    for (let i = 0; i < 40 && s.projectiles.ids.length > 0; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 9 + i, tick: s.tick } }, [], map);
    }
    const after = s.vehicles.byId[22]!;
    expect(after.heading).not.toBe(headingBefore);
    expect(Math.abs(after.speed)).toBeLessThan(150);
    expect(after.health).toBe(healthBefore); // a slick is not a weapon
    expect(s.projectiles.ids.length).toBe(0);
  });

  it('the guns fire down the nose, not at the mouse', () => {
    const { state } = fitted('guns', 20);
    const events: SimEvent[] = [];
    // Aim hard left while pointing the car down the lane: the shot must
    // follow the car.
    const input: InputIntent = {
      ...NULL_INPUT,
      seq: 1,
      tick: state.tick,
      fitting: true,
      aimAngle: state.vehicles.byId[20]!.heading + Math.PI / 2,
    };
    const after = step(state, { 1: input }, [], map, events);
    const shot = events.find((e) => e.type === 'shot');
    expect(shot).toBeDefined();
    if (shot && shot.type === 'shot') {
      const angle = Math.atan2(shot.y1 - shot.y0, shot.x1 - shot.x0);
      const carAngle = state.vehicles.byId[20]!.heading;
      const delta = Math.abs(Math.atan2(Math.sin(angle - carAngle), Math.cos(angle - carAngle)));
      expect(delta).toBeLessThan(0.1);
    }
    expect(after.vehicles.byId[20]!.fittingAmmo).toBe(19);
  });

  it('a turret is the exception: it follows the mouse, not the hull', () => {
    const { state } = fitted('guns', 20, 'tank');
    const events: SimEvent[] = [];
    const carAngle = state.vehicles.byId[20]!.heading;
    const aim = carAngle + Math.PI / 2;
    const after = step(
      state,
      { 1: { ...NULL_INPUT, seq: 1, tick: state.tick, fitting: true, aimAngle: aim } },
      [],
      map,
      events,
    );
    const shot = events.find((e) => e.type === 'shot');
    expect(shot).toBeDefined();
    if (shot && shot.type === 'shot') {
      const angle = Math.atan2(shot.y1 - shot.y0, shot.x1 - shot.x0);
      const off = (a: number): number => Math.abs(Math.atan2(Math.sin(angle - a), Math.cos(angle - a)));
      expect(off(aim)).toBeLessThan(0.1); // down the barrel...
      expect(off(carAngle)).toBeGreaterThan(1); // ...and nowhere near the bonnet
    }
    // A tank comes with its own gun, so the round comes off whatever it
    // rolled out of the factory with rather than off the 20 asked for.
    expect(after.vehicles.byId[20]!.fittingAmmo).toBe(state.vehicles.byId[20]!.fittingAmmo - 1);
  });

  it('the turret rests along the hull when nobody is driving', () => {
    const { state } = fitted('guns', 20, 'tank');
    const v = state.vehicles.byId[20]!;
    const driver = state.players.byId[1]!;
    driver.aimAngle = v.heading + Math.PI / 2;
    expect(turretAngle(state, v)).toBeCloseTo(driver.aimAngle, 6);
    v.driverId = null;
    expect(turretAngle(state, v)).toBe(v.heading);
  });

  it('a vehicle without a turret ignores the aim entirely', () => {
    const { state } = fitted('guns', 20);
    const v = state.vehicles.byId[20]!;
    state.players.byId[1]!.aimAngle = v.heading + 1.2;
    expect(turretAngle(state, v)).toBe(v.heading);
  });

  it('a bomb arms rather than detonating in your lap', () => {
    const { state } = fitted('bomb', 1);
    const events: SimEvent[] = [];
    const armed = press(state, events);
    const v = armed.vehicles.byId[20]!;
    expect(v.condition).toBe('burning');
    expect(v.fuseAtTick).toBe(armed.tick + Math.round(getTuning().fittings.bombFuseSec * 30));
    expect(v.fitting).toBe(''); // one bomb, one bang
    expect(events.some((e) => e.type === 'explosion')).toBe(false);

    // ...and then it goes off, through the same path every other car uses.
    let s = armed;
    const later: SimEvent[] = [];
    for (let i = 0; i < 140 && !later.some((e) => e.type === 'explosion'); i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, later);
    }
    expect(later.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('an empty fitting does nothing at all', () => {
    const { state } = fitted('mine', 1);
    let s = press(state); // spends the last one
    expect(s.vehicles.byId[20]!.fitting).toBe('');
    const before = s.projectiles.ids.length;
    for (let i = 0; i < 30; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 5 + i, tick: s.tick, fitting: true } }, [], map);
    }
    expect(s.projectiles.ids.length).toBe(before);
  });

  it('laying and detonating is deterministic', () => {
    const run = (): number => {
      let s = press(fitted('mine', 4).state);
      for (let i = 0; i < 40; i++) {
        s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick, fitting: i % 13 === 0 } }, [], map);
      }
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
