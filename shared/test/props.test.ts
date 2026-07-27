import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimCommand } from '../src/sim/commands.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { roadLane } from './helpers.js';
import { rayWallDistance } from '../src/sim/weapons.js';

const map = generateCity(9009, parseWorldgenParams(worldgenJson));

/**
 * An axis direction with at least `need` px of clear line from `from`.
 *
 * These tests used to assume +x was clear from wherever the player happened
 * to spawn. That held only by luck: any change to worldgen's rng order moves
 * every spawn point, and adding a shop kind was enough to park a player
 * against a wall with the target behind it.
 */
function clearAim(from: { x: number; y: number }, need = 60): number {
  for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    const d = rayWallDistance(map, from.x, from.y, Math.cos(angle), Math.sin(angle), need + 20);
    if (d >= need) return angle;
  }
  throw new Error('no clear direction from spawn — pick another seed');
}

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    // These tests shoot at a specific prop across open ground; ambient
    // traffic would drive through the firing line and block the shot.
    traffic: { ...trafficJson, count: 0 },
  });
});

describe('destructible props', () => {
  it('the map places all three kinds of street furniture', () => {
    const kinds = new Set(map.propSpawns.map((p) => p.kind));
    expect(kinds.has('lamp')).toBe(true);
    expect(kinds.has('bin')).toBe(true);
    expect(kinds.has('fence')).toBe(true);
    expect(map.propSpawns.length).toBeGreaterThan(100);
  });

  it('shooting a bin breaks it: discrete transition, stays broken, no re-hit', () => {
    let state = createGameState(1);
    state = step(
      state,
      {},
      [
        { type: 'spawnPlayer', playerId: 1, name: 'vandal', loadout: [{ weaponId: 'shotgun', ammo: 50 }] },
      ],
      map,
    );
    const p1 = state.players.byId[1]!;
    const aim = clearAim(p1.pos);
    state = step(
      state,
      {},
      [
        {
          type: 'spawnProp',
          propId: 77,
          kind: 'bin',
          x: p1.pos.x + Math.cos(aim) * 30,
          y: p1.pos.y + Math.sin(aim) * 30,
          orient: 0,
        },
      ],
      map,
    );
    expect(state.props.byId[77]!.intact).toBe(true);

    const events: SimEvent[] = [];
    let seq = 1;
    for (let i = 0; i < 60 && state.props.byId[77]!.intact; i++) {
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: aim } },
        [],
        map,
        events,
      );
    }
    const prop = state.props.byId[77]!;
    expect(prop.intact).toBe(false);
    expect(prop.hp).toBe(0);
    expect(events.some((e) => e.type === 'propDown' && e.kind === 'bin')).toBe(true);

    // Broken props are inert: further fire passes through without events.
    const before = hashState(state);
    const moreEvents: SimEvent[] = [];
    state = step(
      state,
      { 1: { ...NULL_INPUT, seq: seq++, tick: 99, fire: false, aimAngle: aim } },
      [],
      map,
      moreEvents,
    );
    expect(moreEvents.some((e) => e.type === 'propDown')).toBe(false);
    expect(hashState(state)).not.toBe(before); // tick advanced, but...
    expect(state.props.byId[77]!.intact).toBe(false); // ...still broken
  });

  it('a speeding car smashes a lamp post and sheds a little momentum', () => {
    let state = createGameState(2);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
    const p1 = state.players.byId[1]!;
    // Run the car in along a stretch of road that is actually clear.
    const lane = roadLane(map);
    const ux = Math.cos(lane.heading);
    const uy = Math.sin(lane.heading);
    void p1;
    const cmds: SimCommand[] = [
      { type: 'spawnVehicle', vehicleId: 5, kind: 'car', x: lane.x, y: lane.y, heading: lane.heading },
      {
        type: 'spawnProp',
        propId: 88,
        kind: 'lamp',
        x: lane.x + ux * 70,
        y: lane.y + uy * 70,
        orient: 0,
      },
    ];
    state = step(state, {}, cmds, map);
    const events: SimEvent[] = [];
    let broke = false;
    let speedAtBreak = 0;
    for (let i = 0; i < 40 && !broke; i++) {
      state.vehicles.byId[5]!.speed = 300;
      const preSpeed = state.vehicles.byId[5]!.speed;
      state = step(state, {}, [], map, events);
      if (!state.props.byId[88]!.intact) {
        broke = true;
        speedAtBreak = state.vehicles.byId[5]!.speed;
        expect(speedAtBreak).toBeLessThan(preSpeed); // momentum shed
      }
    }
    expect(broke).toBe(true);
    expect(events.some((e) => e.type === 'propDown' && e.kind === 'lamp')).toBe(true);
  });

  it('prop destruction is deterministic', () => {
    const run = (): number => {
      let state = createGameState(3);
      state = step(
        state,
        {},
        [{ type: 'spawnPlayer', playerId: 1, name: 'x', loadout: [{ weaponId: 'smg', ammo: 200 }] }],
        map,
      );
      const p1 = state.players.byId[1]!;
      const cmds: SimCommand[] = map.propSpawns.slice(0, 10).map((spawn, i) => ({
        type: 'spawnProp',
        propId: 100 + i,
        kind: spawn.kind,
        x: p1.pos.x + 25 + i * 9,
        y: p1.pos.y,
        orient: spawn.orient,
      }));
      state = step(state, {}, cmds, map);
      for (let i = 0; i < 120; i++) {
        state = step(
          state,
          { 1: { ...NULL_INPUT, seq: i + 1, tick: i, fire: true, aimAngle: 0.02 * (i % 5) } },
          [],
          map,
        );
      }
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe('the world replenishes', () => {
  /** A lone prop, smashed, with the player parked far away. */
  function smashedProp(seed: number): GameState {
    let state = createGameState(seed);
    state = step(
      state,
      {},
      [
        {
          type: 'spawnPlayer',
          playerId: 1,
          name: 'p',
          loadout: [{ weaponId: 'shotgun', ammo: 99 }],
        },
      ],
      map,
    );
    const p = state.players.byId[1]!;
    const aim = clearAim(p.pos);
    state = step(
      state,
      {},
      [
        {
          type: 'spawnProp',
          propId: 5,
          kind: 'bin',
          x: p.pos.x + Math.cos(aim) * 30,
          y: p.pos.y + Math.sin(aim) * 30,
          orient: 0,
        },
      ],
      map,
    );
    for (let i = 0; i < 60 && state.props.byId[5]!.intact; i++) {
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: i + 1, tick: i + 1, fire: true, aimAngle: aim } },
        [],
        map,
      );
    }
    expect(state.props.byId[5]!.intact).toBe(false);
    return state;
  }

  it('a smashed prop schedules its own repair', () => {
    const state = smashedProp(31);
    expect(state.props.byId[5]!.respawnAtTick).not.toBeNull();
    expect(state.props.byId[5]!.respawnAtTick).toBeGreaterThan(state.tick);
  });

  it('it comes back once the delay passes and nobody is watching', () => {
    let state = smashedProp(31);
    // Walk the witness far away, then run past the repair delay.
    state.players.byId[1]!.pos = { x: map.widthPx - 40, y: map.heightPx - 40 };
    const due = state.props.byId[5]!.respawnAtTick!;
    const events: SimEvent[] = [];
    while (state.tick <= due + 5) state = step(state, {}, [], map, events);
    expect(state.props.byId[5]!.intact).toBe(true);
    expect(state.props.byId[5]!.hp).toBeGreaterThan(0);
    expect(state.props.byId[5]!.respawnAtTick).toBeNull();
    expect(events.some((e) => e.type === 'propUp')).toBe(true);
  });

  it('but never while somebody is stood over it', () => {
    let state = smashedProp(31);
    const prop = state.props.byId[5]!;
    const due = prop.respawnAtTick!;
    while (state.tick <= due + 60) {
      // Keep the witness parked right on top of the wreckage.
      state.players.byId[1]!.pos = { x: prop.pos.x + 5, y: prop.pos.y + 5 };
      state = step(state, {}, [], map);
    }
    expect(state.props.byId[5]!.intact).toBe(false);
  });

  it('repair is deterministic', () => {
    const run = (): number => {
      let state = smashedProp(31);
      state.players.byId[1]!.pos = { x: map.widthPx - 40, y: map.heightPx - 40 };
      for (let i = 0; i < 60 * 30; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
