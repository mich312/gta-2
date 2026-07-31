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
import { damageProp, rayWallDistance } from '../src/sim/weapons.js';
import { districtAt, T_SIDEWALK, TILE_SIZE } from '../src/world/types.js';
import { clearSpot } from './helpers.js';

/** A player with a barrel and an ordinary bin planted in clear ground. */
function withBarrel(): { state: GameState; barrelId: number; binId: number } {
  let state = createGameState(5150);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
  const at = clearSpot(map, state.players.byId[1]!.pos, 200);
  state = step(
    state,
    {},
    [
      { type: 'spawnProp', propId: 600, kind: 'barrel', x: at.x, y: at.y, orient: 0 },
      { type: 'spawnProp', propId: 601, kind: 'bin', x: at.x + 200, y: at.y, orient: 0 },
    ],
    map,
  );
  return { state, barrelId: 600, binId: 601 };
}

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

describe('explosive barrels (K2)', () => {
  it('worldgen puts barrels in every city, and only against industrial walls', () => {
    for (const seed of [777, 808, 2024, 6006]) {
      const m = generateCity(seed, parseWorldgenParams(worldgenJson));
      const barrels = m.propSpawns.filter((p) => p.kind === 'barrel');
      // Reserved out of the prop cap on purpose: the furniture list is
      // decimated to a ceiling, and a plain decimation left two barrels in
      // one city and none at all in another.
      expect(barrels.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const b of barrels) {
        const tx = Math.floor(b.x / TILE_SIZE);
        const ty = Math.floor(b.y / TILE_SIZE);
        expect(districtAt(m, tx, ty)).toBe('industrial');
      }
    }
  });

  it('a barrel goes off, and hurts whoever is standing beside it', () => {
    const { state: base, barrelId } = withBarrel();
    let s = base;
    const near = s.props.byId[barrelId]!;
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'bystander' }], map);
    s.players.byId[2]!.pos = { x: near.pos.x + 10, y: near.pos.y };
    // ...and one well clear, to prove the blast has an edge.
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 3, name: 'far' }], map);
    s.players.byId[3]!.pos = { x: near.pos.x + 400, y: near.pos.y };

    const events: SimEvent[] = [];
    damageProp(s, s.props.byId[barrelId]!, 1000, events, 1);
    expect(s.props.byId[barrelId]!.intact).toBe(false);
    // It does NOT go off on the same tick: blast() calls damageProp, so an
    // inline detonation would recurse to a depth two hosts must agree on.
    expect(events.some((e) => e.type === 'explosion')).toBe(false);

    for (let i = 0; i < 4; i++) s = step(s, {}, [], map, events);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
    expect(s.players.byId[2]!.health).toBeLessThan(100);
    expect(s.players.byId[3]!.health).toBe(100);
    // And it leaves nothing behind flying around.
    expect(s.projectiles.ids.length).toBe(0);
  });

  it('an ordinary bin breaks without going off', () => {
    const { state: base, binId } = withBarrel();
    let s = base;
    const events: SimEvent[] = [];
    damageProp(s, s.props.byId[binId]!, 1000, events, 1);
    for (let i = 0; i < 5; i++) s = step(s, {}, [], map, events);
    expect(events.some((e) => e.type === 'propDown')).toBe(true);
    expect(events.some((e) => e.type === 'explosion')).toBe(false);
    expect(s.projectiles.ids.length).toBe(0);
  });

  it('the arsonist owns the blast, not the barrel', () => {
    const { state: base, barrelId } = withBarrel();
    let s = base;
    const spot = s.props.byId[barrelId]!.pos;
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'victim' }], map);
    s.players.byId[2]!.pos = { x: spot.x + 8, y: spot.y };
    const events: SimEvent[] = [];
    damageProp(s, s.props.byId[barrelId]!, 1000, events, 1);
    for (let i = 0; i < 4; i++) s = step(s, {}, [], map, events);
    const kill = events.find((e) => e.type === 'kill');
    if (kill && kill.type === 'kill') expect(kill.killerId).toBe(1);
    expect(s.players.byId[2]!.health).toBeLessThan(100);
  });

  it('a row of barrels chains, one link per tick, and terminates', () => {
    let s = createGameState(4242);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
    const at = clearSpot(map, s.players.byId[1]!.pos, 200);
    const cmds: SimCommand[] = [];
    for (let i = 0; i < 5; i++) {
      cmds.push({
        type: 'spawnProp',
        propId: 700 + i,
        kind: 'barrel',
        x: at.x + i * 30,
        y: at.y,
        orient: 0,
      });
    }
    s = step(s, {}, cmds, map);
    const events: SimEvent[] = [];
    damageProp(s, s.props.byId[700]!, 1000, events, 1);
    for (let i = 0; i < 60; i++) s = step(s, {}, [], map, events);
    const booms = events.filter((e) => e.type === 'explosion').length;
    // The whole row went, and the run ended: no projectile left cooking.
    expect(booms).toBe(5);
    expect(s.projectiles.ids.length).toBe(0);
    for (let i = 0; i < 5; i++) expect(s.props.byId[700 + i]!.intact).toBe(false);
  });

  it('barrels are deterministic, chain and all', () => {
    const run = (): number => {
      let s = createGameState(31);
      s = step(s, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'a' }], map);
      const at = clearSpot(map, s.players.byId[1]!.pos, 200);
      const cmds: SimCommand[] = [];
      for (let i = 0; i < 4; i++) {
        cmds.push({
          type: 'spawnProp',
          propId: 800 + i,
          kind: 'barrel',
          x: at.x + i * 28,
          y: at.y,
          orient: 0,
        });
      }
      s = step(s, {}, cmds, map);
      damageProp(s, s.props.byId[800]!, 1000, [], 1);
      for (let i = 0; i < 40; i++) s = step(s, {}, [], map);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

describe('street furniture reaches the whole city', () => {
  /**
   * The cap has to sample the candidate list, not truncate it.
   *
   * `placeProps` sweeps the map row-major and then cuts the list down to
   * `MAX_PROPS`. The cut used to be `filter((_, i) => i % stride === 0)
   * .slice(0, cap)` with `stride = floor(length / cap)` — which is 1 whenever
   * there are fewer than twice the cap of candidates, so the filter kept
   * everything and the slice took the first `cap` of a row-major sweep. Every
   * lamp, bin and fence ended up in whichever half the sweep reached first.
   *
   * Measured before the fix: seed 7 put 358 of 381 props in the northern half
   * against 23 in the southern, while the pavement they stand on was split
   * 50/50. Seed 42 had nothing below y = 2632 of 3840.
   *
   * The assertion is deliberately about *proportion to what is there* rather
   * than an even split: a city whose pavement genuinely lies mostly south
   * should have its furniture mostly south too.
   */
  it('places props in proportion to the pavement, not to sweep order', () => {
    for (const seed of [7, 11, 42]) {
      const m = generateCity(seed, parseWorldgenParams(worldgenJson));
      const W = m.widthTiles;
      const H = m.heightTiles;
      let padSouth = 0;
      let padTotal = 0;
      for (let ty = 0; ty < H; ty++) {
        for (let tx = 0; tx < W; tx++) {
          if (m.tiles[ty * W + tx] !== T_SIDEWALK) continue;
          padTotal++;
          if (ty >= H / 2) padSouth++;
        }
      }
      const props = m.propSpawns;
      const south = props.filter((p) => p.y >= (H * TILE_SIZE) / 2).length;
      const keptFrac = south / props.length;
      const candFrac = padSouth / padTotal;

      expect(props.length).toBeGreaterThan(200);
      // Within a wide band of the candidate density. Wide because the sweep is
      // row-major and the kit is not uniform across districts; narrow enough
      // that truncation — which drove seed 7 to 0.06 against 0.50 — fails it.
      expect(Math.abs(keptFrac - candFrac)).toBeLessThan(0.2);
    }
  });

  it('reaches the far edge of the map', () => {
    const m = generateCity(42, parseWorldgenParams(worldgenJson));
    const far = Math.max(...m.propSpawns.map((p) => p.y));
    // Truncation left seed 42 with nothing below y = 2632 of 3840.
    expect(far).toBeGreaterThan(m.heightTiles * TILE_SIZE * 0.8);
  });
});
