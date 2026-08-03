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
import { getTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { T_RAMP, TILE_SIZE } from '../src/world/types.js';
import { isSolidTile } from '../src/world/collide.js';
import { clearSpot } from './helpers.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
  traffic: { ...trafficJson, count: 0 },
});

const params = parseWorldgenParams(worldgenJson);
const map = generateCity(4321, params);

/** A player with a frenzy crate under their feet, plus a victim to shoot. */
function withFrenzy(seed = 1): GameState {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [
      {
        type: 'spawnPlayer',
        playerId: 1,
        name: 'a',
        loadout: [{ weaponId: 'smg', ammo: 9000 }],
      },
      { type: 'spawnPlayer', playerId: 2, name: 'b' },
    ],
    map,
  );
  const p = state.players.byId[1]!;
  return step(
    state,
    {},
    [{ type: 'spawnPickup', pickupId: 7, kind: 'frenzy', x: p.pos.x, y: p.pos.y }],
    map,
  );
}

describe('kill frenzy', () => {
  it('a crate starts a frenzy with a target and a clock', () => {
    let state = withFrenzy();
    state = step(state, {}, [], map);
    const p = state.players.byId[1]!;
    expect(p.frenzyTarget).toBe(getTuning().pickups.kinds.frenzy.value);
    expect(p.frenzyKills).toBe(0);
    expect(p.frenzyEndsAtTick).toBeGreaterThan(state.tick);
  });

  it('kills count towards it', () => {
    let state = withFrenzy(2);
    state = step(state, {}, [], map);
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 50);

    let seq = 1;
    for (let i = 0; i < 60 && state.players.byId[1]!.frenzyKills === 0; i++) {
      const v = state.players.byId[2]!;
      if (v.mode !== 'dead') v.pos = { x: spot.x, y: spot.y };
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: spot.angle } },
        [],
        map,
      );
    }
    expect(state.players.byId[1]!.frenzyKills).toBeGreaterThan(0);
  });

  it('expires on the clock, and reports that it was not completed', () => {
    let state = withFrenzy(3);
    state = step(state, {}, [], map);
    const due = state.players.byId[1]!.frenzyEndsAtTick!;
    const events: SimEvent[] = [];
    while (state.tick <= due) state = step(state, {}, [], map, events);
    const ended = events.find((e) => e.type === 'frenzyEnded');
    expect(ended).toBeDefined();
    expect(ended && ended.type === 'frenzyEnded' && ended.completed).toBe(false);
    expect(state.players.byId[1]!.frenzyTarget).toBe(0);
  });

  it('completes when the target is met, and says so', () => {
    let state = withFrenzy(4);
    state = step(state, {}, [], map);
    // Hit the target directly: the crediting path is what is under test.
    const p = state.players.byId[1]!;
    p.frenzyKills = p.frenzyTarget - 1;
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 50);

    const events: SimEvent[] = [];
    let seq = 1;
    for (let i = 0; i < 120 && state.players.byId[1]!.frenzyTarget > 0; i++) {
      const v = state.players.byId[2]!;
      if (v.mode !== 'dead') v.pos = { x: spot.x, y: spot.y };
      state = step(
        state,
        { 1: { ...NULL_INPUT, seq: seq++, tick: i, fire: true, aimAngle: spot.angle } },
        [],
        map,
        events,
      );
    }
    const done = events.find((e) => e.type === 'frenzyEnded');
    expect(done).toBeDefined();
    expect(done && done.type === 'frenzyEnded' && done.completed).toBe(true);
    expect(state.players.byId[1]!.frenzyTarget).toBe(0);
  });

  it('a second crate cannot reset a running frenzy', () => {
    let state = withFrenzy(5);
    state = step(state, {}, [], map);
    const endsAt = state.players.byId[1]!.frenzyEndsAtTick;
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnPickup', pickupId: 8, kind: 'frenzy', x: p.pos.x, y: p.pos.y }],
      map,
    );
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.frenzyEndsAtTick).toBe(endsAt);
    expect(state.pickups.byId[8]!.active).toBe(true); // untouched
  });
});

describe('stunt jumps', () => {
  it('worldgen builds ramps', () => {
    let ramps = 0;
    for (let i = 0; i < map.tiles.length; i++) if (map.tiles[i] === T_RAMP) ramps++;
    expect(ramps).toBeGreaterThan(0);
  });

  /** Drop a ramp under a driving player and give them a run-up. */
  function onRamp(seed: number): GameState {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'stunt' }], map);
    // Find a ramp with a clear APPROACH and a clear RUN-OUT, and drive at
    // it. The first ramp in scan order used to do, with the car spawned ON
    // the ramp tile and heading 0 assumed — which worked only while that
    // ramp's surroundings happened to cooperate. A ramp is a solid you
    // drive UP in the volume model, so a car planted inside it at ground
    // level is a collision, not a stunt; and the launch direction is the
    // car's own heading, so the heading has to be one the jump can actually
    // be flown along. Stage the approach and let the car arrive, which is
    // what the launch sweep in `sim/frenzy.ts` is written for.
    let ramp: { tx: number; ty: number; heading: number; dx: number; dy: number } | null = null;
    outer: for (let ty = 0; ty < map.heightTiles && !ramp; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] !== T_RAMP) continue;
        for (const [dx, dy, heading] of [
          [1, 0, 0],
          [-1, 0, Math.PI],
          [0, 1, Math.PI / 2],
          [0, -1, -Math.PI / 2],
        ] as const) {
          // A car-wide corridor, not a point line: the whole run — approach,
          // ramp and run-out — must be clear one tile EITHER SIDE too, or
          // the car's own width clips whatever stands beside the lane (the
          // first attempt bounced off a tree hard against the ramp's flank).
          let clear = true;
          for (let i = -3; i <= 10 && clear; i++) {
            for (let o = -1; o <= 1 && clear; o++) {
              const cx = tx + dx * i - dy * o;
              const cy = ty + dy * i + dx * o;
              clear = !isSolidTile(map, cx, cy, 'land');
              if (clear && i < 0 && map.tiles[cy * map.widthTiles + cx] === T_RAMP) clear = false;
            }
          }
          if (clear) {
            ramp = { tx, ty, heading, dx, dy };
            continue outer;
          }
        }
      }
    }
    expect(ramp).not.toBeNull();
    const x = (ramp!.tx + 0.5 - ramp!.dx * 2.5) * TILE_SIZE;
    const y = (ramp!.ty + 0.5 - ramp!.dy * 2.5) * TILE_SIZE;
    state.players.byId[1]!.pos = { x, y };
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 3, kind: 'car', x, y, heading: ramp!.heading }],
      map,
    );
    return step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  }

  it('a fast car leaves the ground and comes back down', () => {
    let state = onRamp(9);
    expect(state.players.byId[1]!.mode).toBe('driving');
    state.vehicles.byId[3]!.speed = 320;

    const events: SimEvent[] = [];
    let peakZ = 0;
    for (let i = 0; i < 120; i++) {
      state = step(state, {}, [], map, events);
      peakZ = Math.max(peakZ, state.players.byId[1]!.z);
    }
    expect(events.some((e) => e.type === 'stuntLaunched')).toBe(true);
    expect(peakZ).toBeGreaterThan(0);
    const landed = events.find((e) => e.type === 'stuntLanded');
    expect(landed).toBeDefined();
    expect(landed && landed.type === 'stuntLanded' && landed.distance).toBeGreaterThan(0);
    // Back on the ground afterwards.
    expect(state.players.byId[1]!.z).toBe(0);
  });

  it('a slow car just drives over it', () => {
    let state = onRamp(10);
    state.vehicles.byId[3]!.speed = 40;
    const events: SimEvent[] = [];
    for (let i = 0; i < 40; i++) {
      state.vehicles.byId[3]!.speed = 40;
      state = step(state, {}, [], map, events);
    }
    expect(events.some((e) => e.type === 'stuntLaunched')).toBe(false);
    expect(state.players.byId[1]!.z).toBe(0);
  });

  it('someone on foot is never airborne', () => {
    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    for (let i = 0; i < 60; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, up: true } }, [], map);
      expect(state.players.byId[1]!.z).toBe(0);
    }
  });

  it('frenzies and stunts are deterministic', () => {
    const run = (): number => {
      let state = onRamp(12);
      state.vehicles.byId[3]!.speed = 320;
      for (let i = 0; i < 240; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
