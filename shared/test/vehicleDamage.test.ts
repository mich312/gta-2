import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimCommand } from '../src/sim/commands.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { clearSpot, roadLane } from './helpers.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
});

const map = generateCity(2024, parseWorldgenParams(worldgenJson));

/** A shooter with a big magazine, and a car parked in front of them. */
function shooterAndCar(seed = 1): GameState {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [{ type: 'spawnPlayer', playerId: 1, name: 'a', loadout: [{ weaponId: 'smg', ammo: 4000 }] }],
    map,
  );
  const p = state.players.byId[1]!;
  const spot = clearSpot(map, p.pos, 60);
  aimAt = spot.angle;
  return step(
    state,
    {},
    [{ type: 'spawnVehicle', vehicleId: 9, kind: 'car', x: spot.x, y: spot.y, heading: 0 }],
    map,
  );
}

/** Direction from the shooter to the car in the current fixture. */
let aimAt = 0;

function shootUntil(
  state: GameState,
  pred: (s: GameState) => boolean,
  maxTicks: number,
  events: SimEvent[],
): GameState {
  let seq = 1;
  for (let i = 0; i < maxTicks && !pred(state); i++) {
    state = step(
      state,
      { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: aimAt } },
      [],
      map,
      events,
    );
  }
  return state;
}

describe('vehicle destruction', () => {
  it('a car starts intact with tuned health', () => {
    const state = shooterAndCar();
    const v = state.vehicles.byId[9]!;
    expect(v.condition).toBe('ok');
    expect(v.health).toBe(getVehicleTuning('car').health);
    expect(v.fuseAtTick).toBeNull();
  });

  it('shooting a car sets it burning on a fuse, then it explodes into a wreck', () => {
    const events: SimEvent[] = [];
    let state = shooterAndCar();
    state = shootUntil(state, (s) => s.vehicles.byId[9]!.condition !== 'ok', 400, events);

    const burning = state.vehicles.byId[9]!;
    expect(burning.condition).toBe('burning');
    expect(burning.health).toBe(0);
    expect(burning.fuseAtTick).toBeGreaterThan(state.tick);
    expect(events.some((e) => e.type === 'vehicleBurning')).toBe(true);

    const due = burning.fuseAtTick!;
    const boom: SimEvent[] = [];
    while (state.tick <= due) state = step(state, {}, [], map, boom);
    expect(state.vehicles.byId[9]!.condition).toBe('wreck');
    expect(boom.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('the blast hurts people standing near it', () => {
    let state = shooterAndCar(5);
    // A bystander right beside the car; the shooter is 60px away.
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'b' }], map);
    const car = state.vehicles.byId[9]!;
    state.players.byId[2]!.pos = { x: car.pos.x + 12, y: car.pos.y };
    void car;

    const events: SimEvent[] = [];
    state = shootUntil(state, (s) => s.vehicles.byId[9]!.condition === 'burning', 400, events);
    const due = state.vehicles.byId[9]!.fuseAtTick!;
    while (state.tick <= due) {
      const b = state.players.byId[2]!;
      if (b.mode !== 'dead') {
        b.pos = { x: state.vehicles.byId[9]!.pos.x + 8, y: state.vehicles.byId[9]!.pos.y };
      }
      state = step(state, {}, [], map, events);
    }
    const victim = state.players.byId[2]!;
    expect(victim.health < 100 || victim.mode === 'dead').toBe(true);
  });

  it('a wreck cannot be driven and is eventually cleared when unwatched', () => {
    const events: SimEvent[] = [];
    let state = shooterAndCar(6);
    state = shootUntil(state, (s) => s.vehicles.byId[9]!.condition === 'burning', 400, events);
    let due = state.vehicles.byId[9]!.fuseAtTick!;
    while (state.tick <= due) state = step(state, {}, [], map, events);
    expect(state.vehicles.byId[9]!.condition).toBe('wreck');

    // Standing on it, action pressed: no boarding a burnt-out shell.
    const car = state.vehicles.byId[9]!;
    state.players.byId[1]!.pos = { x: car.pos.x, y: car.pos.y };
    state = step(state, { 1: { ...NULL_INPUT, seq: 9000, tick: 9000, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('foot');

    // Walk away and it gets towed.
    state.players.byId[1]!.pos = { x: map.widthPx - 40, y: map.heightPx - 40 };
    due = state.vehicles.byId[9]!.fuseAtTick!;
    while (state.tick <= due + 2) state = step(state, {}, [], map);
    expect(state.vehicles.byId[9]).toBeUndefined();
  });

  it('ramming a parked car shoves it instead of stopping dead', () => {
    // Both cars go on an actual stretch of road, aligned with it — dropped at
    // an arbitrary offset they just hit a building before ever meeting.
    const spawn = roadLane(map);
    const ux = Math.cos(spawn.heading);
    const uy = Math.sin(spawn.heading);

    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const cmds: SimCommand[] = [
      { type: 'spawnVehicle', vehicleId: 20, kind: 'car', x: spawn.x, y: spawn.y, heading: spawn.heading },
      {
        type: 'spawnVehicle',
        vehicleId: 21,
        kind: 'car',
        x: spawn.x + ux * 40,
        y: spawn.y + uy * 40,
        heading: spawn.heading,
      },
    ];
    state = step(state, {}, cmds, map);

    let shoved = 0;
    for (let i = 0; i < 14; i++) {
      // Hold the rammer at speed so friction cannot stall it before contact.
      const rammer = state.vehicles.byId[20];
      if (rammer && rammer.condition === 'ok') rammer.speed = 300;
      state = step(state, {}, [], map);
      const struck = state.vehicles.byId[21];
      if (struck) shoved = Math.max(shoved, Math.abs(struck.speed));
    }
    // The struck car was pushed along rather than absorbing everything.
    expect(shoved).toBeGreaterThan(0);
  });

  it('a packed car park chain-reacts, and does so identically twice', () => {
    const run = (): { hash: number; wrecks: number; booms: number } => {
      let state = createGameState(99);
      state = step(
        state,
        {},
        [
          {
            type: 'spawnPlayer',
            playerId: 1,
            name: 'a',
            loadout: [{ weaponId: 'smg', ammo: 4000 }],
          },
        ],
        map,
      );
      // Ten cars in a tight row, well inside one blast radius of each other —
      // down a real lane, not along +x from wherever the player happened to
      // spawn. That assumption held by luck, and adding a landmark kind to
      // worldgen moved every spawn point and parked the whole row inside a
      // building, where the test measured nothing. See test/helpers.ts.
      const lane = roadLane(map, 70 + 9 * 26 + 40);
      const p = state.players.byId[1]!;
      p.pos = { x: lane.x, y: lane.y };
      const dirX = Math.cos(lane.heading);
      const dirY = Math.sin(lane.heading);
      const cmds: SimCommand[] = [];
      for (let i = 0; i < 10; i++) {
        const d = 70 + i * 26;
        cmds.push({
          type: 'spawnVehicle',
          vehicleId: 30 + i,
          kind: 'car',
          x: lane.x + dirX * d,
          y: lane.y + dirY * d,
          heading: lane.heading,
        });
      }
      state = step(state, {}, cmds, map);

      const events: SimEvent[] = [];
      let seq = 1;
      for (let i = 0; i < 1200; i++) {
        state = step(
          state,
          { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: i < 300, aimAngle: lane.heading } },
          [],
          map,
          events,
        );
      }
      let wrecks = 0;
      for (const id of state.vehicles.ids) {
        if (state.vehicles.byId[id]!.condition === 'wreck') wrecks++;
      }
      return {
        hash: hashState(state),
        wrecks,
        booms: events.filter((e) => e.type === 'explosion').length,
      };
    };

    const a = run();
    const b = run();
    // The chain actually happened: one shot car took several with it.
    expect(a.booms).toBeGreaterThan(2);
    // ...and it is reproducible, which is the whole risk with chain reactions.
    expect(a).toEqual(b);
  });
});
