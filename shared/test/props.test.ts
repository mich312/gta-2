import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
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

const map = generateCity(9009, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
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
    state = step(
      state,
      {},
      [{ type: 'spawnProp', propId: 77, kind: 'bin', x: p1.pos.x + 30, y: p1.pos.y, orient: 0 }],
      map,
    );
    expect(state.props.byId[77]!.intact).toBe(true);

    const events: SimEvent[] = [];
    let seq = 1;
    for (let i = 0; i < 60 && state.props.byId[77]!.intact; i++) {
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: 0 } },
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
      { 1: { ...NULL_INPUT, seq: seq++, tick: 99, fire: false, aimAngle: 0 } },
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
    const cmds: SimCommand[] = [
      { type: 'spawnVehicle', vehicleId: 5, kind: 'car', x: p1.pos.x - 200, y: p1.pos.y, heading: 0 },
      { type: 'spawnProp', propId: 88, kind: 'lamp', x: p1.pos.x - 60, y: p1.pos.y, orient: 0 },
    ];
    state = step(state, {}, cmds, map);
    state.vehicles.byId[5]!.speed = 300;
    const events: SimEvent[] = [];
    let broke = false;
    let speedAtBreak = 0;
    for (let i = 0; i < 40 && !broke; i++) {
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
