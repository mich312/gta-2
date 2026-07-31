import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning, getWeaponTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState, type GameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { takeSnapshot } from '../src/net/snapshot.js';
import { binaryCodec } from '../src/net/binary.js';
import { clearSpot, roadLane, spotFacingWall } from './helpers.js';

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
  });
});

/** A player armed with `weaponId`, standing where there is room to shoot. */
function armed(weaponId: string, seed = 4242): { state: GameState; angle: number } {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [
      {
        type: 'spawnPlayer',
        playerId: 1,
        name: 'gunner',
        loadout: [{ weaponId, ammo: 20 }],
      },
    ],
    map,
  );
  const lane = roadLane(map, 260);
  state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
  return { state, angle: lane.heading };
}

function fireOnce(state: GameState, angle: number, events: SimEvent[]): GameState {
  return step(
    state,
    { 1: { ...NULL_INPUT, seq: 1, tick: state.tick, fire: true, aimAngle: angle } },
    [],
    map,
    events,
  );
}

describe('projectiles (F3a)', () => {
  it('a rocket leaves the launcher as an object, not a ray', () => {
    const { state, angle } = armed('rocket');
    const events: SimEvent[] = [];
    const after = fireOnce(state, angle, events);
    expect(after.projectiles.ids.length).toBe(1);
    const pr = after.projectiles.byId[after.projectiles.ids[0]!]!;
    expect(pr.kind).toBe('rocket');
    expect(pr.ownerId).toBe(1);
    expect(Math.hypot(pr.vel.x, pr.vel.y)).toBeCloseTo(
      getWeaponTuning('rocket')!.projectile!.speed,
      0,
    );
    // A hitscan weapon would have resolved and emitted a shot this tick.
    expect(events.some((e) => e.type === 'shot')).toBe(false);
  });

  it('it travels, then detonates — and the blast is what does the damage', () => {
    const { state, angle } = armed('rocket');
    let s = fireOnce(state, angle, []);
    const start = { ...s.projectiles.byId[s.projectiles.ids[0]!]!.pos };
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 && s.projectiles.ids.length > 0; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, events);
    }
    expect(s.projectiles.ids.length).toBe(0); // never leaks
    const boom = events.find((e) => e.type === 'explosion');
    expect(boom).toBeDefined();
    if (boom && boom.type === 'explosion') {
      expect(Math.hypot(boom.x - start.x, boom.y - start.y)).toBeGreaterThan(50);
      expect(boom.radius).toBe(getWeaponTuning('rocket')!.projectile!.blastRadius);
    }
  });

  it('a rocket bursts on the wall it hits rather than passing through', () => {
    const { state } = armed('rocket');
    // Stand somewhere with a wall in front, rather than assuming that at
    // right angles to a kerb there is one: across the street from a kerb in a
    // drawn city can be a park, a dock or the harbour.
    const facing = spotFacingWall(map);
    state.players.byId[1]!.pos = { x: facing.x, y: facing.y };
    const s = fireOnce(state, facing.angle, []);
    let cur = s;
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 && cur.projectiles.ids.length > 0; i++) {
      cur = step(cur, { 1: { ...NULL_INPUT, seq: 2 + i, tick: cur.tick } }, [], map, events);
    }
    expect(cur.projectiles.ids.length).toBe(0);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('a grenade waits out its fuse instead of bursting on contact', () => {
    const { state, angle } = armed('grenade');
    let s = fireOnce(state, angle, []);
    const fuse = s.projectiles.byId[s.projectiles.ids[0]!]!.fuseAtTick;
    expect(fuse - s.tick).toBe(getWeaponTuning('grenade')!.projectile!.fuseTicks);
    const events: SimEvent[] = [];
    // Well before the fuse, it is still in the world.
    for (let i = 0; i < 20; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, events);
    }
    expect(s.projectiles.ids.length).toBe(1);
    expect(events.some((e) => e.type === 'explosion')).toBe(false);
    // Past it, it has gone off.
    for (let i = 0; i < 60 && s.projectiles.ids.length > 0; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 40 + i, tick: s.tick } }, [], map, events);
    }
    expect(s.projectiles.ids.length).toBe(0);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('a rocket kills what it is aimed at', () => {
    const { state, angle } = armed('rocket');
    let s = state;
    const shooter = s.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 120);
    s = step(s, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'target' }], map);
    s.players.byId[2]!.pos = { x: spot.x, y: spot.y };
    const aim = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
    const events: SimEvent[] = [];
    s = fireOnce(s, aim, events);
    for (let i = 0; i < 60 && s.projectiles.ids.length > 0; i++) {
      s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, events);
    }
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
    expect(s.players.byId[2]!.health).toBeLessThan(100);
    expect(angle).toBeTypeOf('number');
  });

  it('a projectile never detonates against the car it was fired from', () => {
    const { state, angle } = armed('rocket');
    const lane = roadLane(map, 260);
    let s = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 9,
          kind: 'car',
          x: lane.x,
          y: lane.y,
          heading: lane.heading,
        },
      ],
      map,
    );
    const p = s.players.byId[1]!;
    p.pos = { x: lane.x, y: lane.y };
    p.mode = 'driving';
    p.vehicleId = 9;
    s.vehicles.byId[9]!.driverId = 1;
    const events: SimEvent[] = [];
    s = fireOnce(s, angle, events);
    // One tick later it is still in flight, not a crater on the bonnet.
    s = step(s, { 1: { ...NULL_INPUT, seq: 2, tick: s.tick } }, [], map, events);
    expect(events.some((e) => e.type === 'explosion')).toBe(false);
    expect(s.projectiles.ids.length).toBe(1);
  });

  it('flight and detonation are deterministic', () => {
    const run = (): number => {
      const { state, angle } = armed('rocket');
      let s = fireOnce(state, angle, []);
      for (let i = 0; i < 90; i++) {
        s = step(s, { 1: { ...NULL_INPUT, seq: 2 + i, tick: s.tick } }, [], map, []);
      }
      return hashState(s);
    };
    expect(run()).toBe(run());
  });

  it('survives the binary wire', () => {
    const { state, angle } = armed('rocket');
    const s = fireOnce(state, angle, []);
    const snap = takeSnapshot(s);
    expect(snap.projectiles.length).toBe(1);
    const round = binaryCodec.decode(binaryCodec.encode({ type: 'full', tick: snap.tick, snapshot: snap }));
    expect(round).toMatchObject({ type: 'full' });
    if (round && typeof round === 'object' && 'snapshot' in round) {
      const back = (round as { snapshot: typeof snap }).snapshot;
      expect(back.projectiles).toEqual(snap.projectiles);
    }
  });

  it('the flamethrower stays hitscan — a cone, not an object', () => {
    const { state, angle } = armed('flamethrower');
    const events: SimEvent[] = [];
    const after = fireOnce(state, angle, events);
    expect(after.projectiles.ids.length).toBe(0);
    expect(events.filter((e) => e.type === 'shot').length).toBe(
      getWeaponTuning('flamethrower')!.pellets,
    );
  });
});
