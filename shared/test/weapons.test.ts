import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import { initTuning } from '../src/tuning.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { RESPAWN_DELAY_TICKS } from '../src/sim/weapons.js';
import { T_BUILDING, T_FIELD, TILE_SIZE, type CityMap } from '../src/world/types.js';

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson, weapons: weaponsJson });
});

function arena(wallAtTx: number | null): CityMap {
  const W = 80;
  const H = 40;
  const tiles = new Uint8Array(W * H).fill(T_FIELD);
  if (wallAtTx !== null) {
    for (let ty = 0; ty < H; ty++) tiles[ty * W + wallAtTx] = T_BUILDING;
  }
  return {
    seed: 0,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles,
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    playerSpawns: [
      { x: 10 * TILE_SIZE, y: 20 * TILE_SIZE },
      { x: 10 * TILE_SIZE, y: 20 * TILE_SIZE },
    ],
    // A complete CityMap, not a partial one. Tests are transpiled without
    // typechecking, so an incomplete literal here compiles fine and then
    // fails at runtime the first time the sim reads a field it lacks.
    pedSpawns: [],
    propSpawns: [],
    pickupSpawns: [],
    boatSpawns: [],
    landmarks: [],
    hospitals: [],
  };
}

const PISTOL = [{ weaponId: 'pistol', ammo: 90 }];

/** Two players 100px apart on the same row; p1 aims east at p2. */
function duel(map: CityMap): GameState {
  let state = createGameState(5);
  state = step(
    state,
    {},
    [
      { type: 'spawnPlayer', playerId: 1, name: 'a', loadout: PISTOL },
      { type: 'spawnPlayer', playerId: 2, name: 'b', loadout: PISTOL },
    ],
    map,
  );
  // Walk p2 east until 100px separation (both spawn at the same point).
  for (let i = 0; i < 40; i++) {
    state = step(state, { 2: { ...NULL_INPUT, seq: i + 1, tick: i, right: true } }, [], map);
  }
  return state;
}

function fireIntent(seq: number, aim: number): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, fire: true, aimAngle: aim };
}

describe('weapons', () => {
  it('hitscan damages, respects cooldown and ammo, and kills at zero', () => {
    const map = arena(null);
    let state = duel(map);
    const events: SimEvent[] = [];
    const before = state.players.byId[2]!.health;
    state = step(state, { 1: fireIntent(100, 0) }, [], map, events);
    expect(state.players.byId[2]!.health).toBeLessThan(before);
    expect(state.players.byId[1]!.weapons[0]!.ammo).toBe(89);
    expect(events.some((e) => e.type === 'shot')).toBe(true);

    // Cooldown: firing again next tick does nothing.
    const h2 = state.players.byId[2]!.health;
    state = step(state, { 1: fireIntent(101, 0) }, [], map);
    expect(state.players.byId[2]!.health).toBe(h2);

    // Keep firing every cooldown window until the kill lands.
    const killEvents: SimEvent[] = [];
    let seq = 102;
    for (let t = 0; t < 300 && state.players.byId[2]!.mode !== 'dead'; t++) {
      state = step(state, { 1: fireIntent(seq++, 0) }, [], map, killEvents);
    }
    const victim = state.players.byId[2]!;
    expect(victim.mode).toBe('dead');
    expect(victim.health).toBe(0);
    expect(victim.weapons).toEqual([]);
    expect(victim.respawnAtTick).not.toBeNull();
    expect(killEvents.some((e) => e.type === 'kill' && e.killerId === 1 && e.victimId === 2)).toBe(
      true,
    );

    // Dead players don't move and can't be shot again.
    const posAtDeath = { ...victim.pos };
    state = step(state, { 2: { ...NULL_INPUT, seq: 999, tick: 999, up: true } }, [], map);
    expect(state.players.byId[2]!.pos).toEqual(posAtDeath);

    // Respawn command restores life with the given loadout.
    state = step(
      state,
      {},
      [{ type: 'respawnPlayer', playerId: 2, loadout: [{ weaponId: 'smg', ammo: 50 }] }],
      map,
    );
    const revived = state.players.byId[2]!;
    expect(revived.mode).toBe('foot');
    expect(revived.health).toBe(100);
    expect(revived.weapons[0]!.weaponId).toBe('smg');
  });

  it('walls block shots', () => {
    const map = arena(null);
    let state = duel(map); // p2 ends ~100px east of p1, open ground
    // NOW raise a wall between them (tile 13; p1 is at tile 10, p2 ~16).
    // Mutating the test map is fine — geometry isn't part of sim state.
    for (let ty = 0; ty < map.heightTiles; ty++) {
      map.tiles[ty * map.widthTiles + 13] = T_BUILDING;
    }
    const h0 = state.players.byId[2]!.health;
    for (let i = 0; i < 60; i++) {
      state = step(state, { 1: fireIntent(200 + i, 0) }, [], map);
    }
    expect(state.players.byId[2]!.health).toBe(h0);
  });

  it('combat is deterministic (same fight twice, identical hash)', () => {
    const run = (): number => {
      const map = arena(null);
      let state = duel(map);
      for (let i = 0; i < 120; i++) {
        state = step(
          state,
          {
            1: fireIntent(300 + i, i % 20 < 10 ? 0 : 0.05),
            2: { ...NULL_INPUT, seq: 300 + i, tick: i, left: i % 3 === 0, fire: true, aimAngle: 3.1 },
          },
          [],
          map,
        );
      }
      return hashState(state);
    };
    expect(run()).toBe(run());
  });

  it('run-over: a speeding car hurts a player on foot', () => {
    const map = arena(null);
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'victim' }], map);
    const p = state.players.byId[1]!;
    // Car barreling east, spawned just west of the victim at full tilt.
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x - 120, y: p.pos.y, heading: 0 }],
      map,
    );
    state.vehicles.byId[2]!.speed = 320; // direct nudge is fine in a test
    let hurt = false;
    for (let i = 0; i < 60 && !hurt; i++) {
      state = step(state, {}, [], map);
      hurt = state.players.byId[1]!.health < 100;
    }
    expect(hurt).toBe(true);
  });

  it('respawn delay constant matches what the sim stamps on the corpse', () => {
    expect(RESPAWN_DELAY_TICKS).toBe(90);
  });
});
