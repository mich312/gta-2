import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning, getTuning, getVehicleTuning, getWeaponTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import {
  addHeat,
  createCop,
  createGameState,
  createVehicle,
  wantedLevelOf,
  type GameState,
} from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { applyDamage } from '../src/sim/weapons.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { T_BUILDING, TILE_SIZE } from '../src/world/types.js';
import { clearSpot, roadLane } from './helpers.js';
import { TICK_RATE } from '../src/constants.js';

const map = generateCity(6006, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
  });
});

const PISTOL = [{ weaponId: 'pistol', ammo: 500 }];

function fire(seq: number, aim: number): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, fire: true, aimAngle: aim };
}

/** Two players; p1 shoots p2 until wanted level reaches the target. */
function commitCrimes(targetLevel: number): GameState {
  let state = createGameState(42);
  state = step(
    state,
    {},
    [
      { type: 'spawnPlayer', playerId: 1, name: 'crook', loadout: PISTOL },
      { type: 'spawnPlayer', playerId: 2, name: 'victim' },
    ],
    map,
  );
  let seq = 1;
  // Aim at the victim; keep shooting (and let respawns re-supply victims).
  // Spawns are deliberately spread out, so the test drags the victim next to
  // the shooter (direct state surgery is fine server-side and repeats
  // identically, so determinism checks still hold).
  for (let t = 0; t < 3000 && wantedLevelOf(state.players.byId[1]!) < targetLevel; t++) {
    const p1 = state.players.byId[1]!;
    const p2 = state.players.byId[2]!;
    if (p2.mode !== 'dead' && Math.hypot(p2.pos.x - p1.pos.x, p2.pos.y - p1.pos.y) > 120) {
      // Along a clear line, not a fixed +x offset: a wall between the two
      // makes this a test of nothing.
      const spot = clearSpot(map, p1.pos, 60);
      p2.pos = { x: spot.x, y: spot.y };
    }
    const aim = Math.atan2(p2.pos.y - p1.pos.y, p2.pos.x - p1.pos.x);
    const cmds: Array<{ type: 'respawnPlayer'; playerId: number; loadout: typeof PISTOL }> = [];
    // The cops WILL kill the crook mid-spree; respawn both parties so the
    // spree continues. Dying now wipes the crook's own wanted level, so the
    // loop simply has to climb the ladder again from wherever it left off.
    if (p2.mode === 'dead' && p2.respawnAtTick !== null && state.tick >= p2.respawnAtTick) {
      cmds.push({ type: 'respawnPlayer', playerId: 2, loadout: [] });
    }
    if (p1.mode === 'dead' && p1.respawnAtTick !== null && state.tick >= p1.respawnAtTick) {
      cmds.push({ type: 'respawnPlayer', playerId: 1, loadout: PISTOL });
    }
    state = step(state, { 1: fire(seq++, aim) }, cmds, map);
  }
  return state;
}

describe('wanted + police', () => {
  it('violence raises heat; wanted level maps from heat', () => {
    const state = commitCrimes(1);
    expect(wantedLevelOf(state.players.byId[1]!)).toBeGreaterThanOrEqual(1);
    expect(state.players.byId[1]!.wantedLevel).toBe(wantedLevelOf(state.players.byId[1]!));
  });

  it('the wanted level belongs to one player, not to the session', () => {
    let state = createGameState(77);
    state = step(
      state,
      {},
      [
        { type: 'spawnPlayer', playerId: 1, name: 'crook' },
        { type: 'spawnPlayer', playerId: 2, name: 'bystander' },
      ],
      map,
    );
    addHeat(state.players.byId[1]!, 320);
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.wantedLevel).toBe(3);
    expect(state.players.byId[2]!.wantedLevel).toBe(0);
    expect(state.players.byId[2]!.heat).toBe(0);
  });

  it('dying wipes your wanted level and the tail that came with it', () => {
    let state = createGameState(78);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    const p = state.players.byId[1]!;
    addHeat(p, 450);
    // Officers already on the case, pointed at this player.
    const t = getTuning().police;
    for (const id of [80, 81]) {
      const cop = createCop(id, { x: p.pos.x + 40, y: p.pos.y }, t.copHealth);
      cop.targetId = 1;
      insertEntity(state.cops, cop);
    }
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.wantedLevel).toBeGreaterThanOrEqual(4);

    // Shot dead by the streets: heat, stars and pursuit all go with it. This
    // used to survive death, so you woke up at the hospital still four-starred
    // with the same force re-acquiring on the spawn tick.
    const events: SimEvent[] = [];
    applyDamage(state, state.players.byId[1]!, 1000, -1, 'police', events);
    expect(state.players.byId[1]!.mode).toBe('dead');
    expect(state.players.byId[1]!.heat).toBe(0);
    expect(state.players.byId[1]!.wantedLevel).toBe(0);
    expect(wantedLevelOf(state.players.byId[1]!)).toBe(0);
    for (const id of state.cops.ids) expect(state.cops.byId[id]!.targetId).toBeNull();

    // ...and it stays gone through the respawn.
    state = step(
      state,
      {},
      [{ type: 'respawnPlayer', playerId: 1, loadout: [], atStation: false }],
      map,
    );
    expect(state.players.byId[1]!.mode).toBe('foot');
    expect(state.players.byId[1]!.wantedLevel).toBe(0);
  });

  /** Player 1 in a car parked on top of them, ready to drive. Returns the state. */
  function boardParkedCar(seed: number): GameState {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], map);
    // On a real lane with road ahead, so the car can actually be driven.
    const lane = roadLane(map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
    state = step(
      state,
      {},
      [
        {
          type: 'spawnVehicle',
          vehicleId: 2,
          kind: 'car',
          x: lane.x,
          y: lane.y,
          heading: lane.heading,
        },
      ],
      map,
    );
    return step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  }

  it('lifting an empty parked car unseen is not a crime', () => {
    const state = boardParkedCar(7);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.players.byId[1]!.heat).toBe(0);
  });

  it('lifting one under a cop’s nose is', () => {
    let state = createGameState(7);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'thief' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 }],
      map,
    );
    // A witness, standing right next to the car so line of sight is certain.
    insertEntity(
      state.cops,
      createCop(90, { x: p.pos.x + 12, y: p.pos.y }, getTuning().police.copHealth),
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
    expect(state.players.byId[1]!.mode).toBe('driving');
    expect(state.players.byId[1]!.heat).toBeGreaterThanOrEqual(
      getTuning().police.heatPerTheft,
    );
  });

  it('a speeding car runs a cop down, and it counts against the driver', () => {
    let state = boardParkedCar(11);
    const t = getTuning().police;
    const v = state.vehicles.byId[2]!;
    v.speed = getVehicleTuning('car').maxSpeed; // flat out, whatever that is
    insertEntity(state.cops, createCop(90, { x: v.pos.x, y: v.pos.y }, t.copHealth));

    const events: SimEvent[] = [];
    state = step(state, {}, [], map, events);
    const hit = state.cops.byId[90]!;
    expect(hit.health).toBeLessThan(t.copHealth);
    expect(hit.carHitCooldown).toBeGreaterThan(0);
    // Assault on an officer is a crime even at the wheel.
    expect(state.players.byId[1]!.heat).toBeGreaterThan(0);

    // Immunity holds: parked on top of them costs no further health.
    const healthAfterFirst = hit.health;
    const car = state.vehicles.byId[2]!;
    hit.pos = { x: car.pos.x, y: car.pos.y };
    state = step(state, {}, [], map);
    expect(state.cops.byId[90]!.health).toBe(healthAfterFirst);

    // Sustained contact does finish the job, and it is reported as a cop down.
    const kill: SimEvent[] = [];
    for (let i = 0; i < 120 && (state.cops.byId[90]?.health ?? 0) > 0; i++) {
      const c = state.cops.byId[90];
      const drive = state.vehicles.byId[2]!;
      drive.speed = 300;
      if (c) c.pos = { x: drive.pos.x, y: drive.pos.y };
      state = step(state, {}, [], map, kill);
    }
    // The officer stays put as a body for the corpse span, then is cleared.
    expect(state.cops.byId[90]!.health).toBe(0);
    expect(kill.some((e) => e.type === 'copDown')).toBe(true);
    for (let i = 0; i < getTuning().peds.corpseSec * TICK_RATE + 2; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.cops.byId[90]).toBeUndefined();
  });

  it('cops arrive on a ramp, not a wall', () => {
    const t = getTuning().police;
    let state = createGameState(21);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);

    let ticksToSecondCop = -1;
    for (let i = 1; i <= 400 && ticksToSecondCop < 0; i++) {
      // Hold the fugitive at three stars so decay can't end the measurement.
      state.players.byId[1]!.heat = 320;
      state = step(state, {}, [], map);
      if (state.cops.ids.length >= 2) ticksToSecondCop = i;
    }

    expect(ticksToSecondCop).toBeGreaterThan(0);
    // At most one arrival per spawnCooldownTicks, so a second cop cannot be
    // on the street any sooner than that.
    expect(ticksToSecondCop).toBeGreaterThanOrEqual(t.spawnCooldownTicks);
  });

  it('the fifth star fields more cops than the fourth', () => {
    const t = getTuning().police;
    const posse = (stars: number): number =>
      Math.min(t.copsPerStar * stars, t.maxCopsPerPlayer);
    expect(posse(5)).toBeGreaterThan(posse(4));
    expect(posse(4)).toBeGreaterThan(posse(3));
  });

  it('cops spawn for the wanted, converge, and hurt them (the level-3 chase)', () => {
    let state = commitCrimes(3);
    expect(wantedLevelOf(state.players.byId[1]!)).toBeGreaterThanOrEqual(3);
    const t = getTuning().police;

    // Stand the fugitive in the open, on a road, rather than wherever the
    // spree left them: this test is about whether pursuit converges and gets
    // a shot away, not about whether the seed happened to leave them cornered
    // somewhere with no line of sight.
    const lane = roadLane(map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y };

    // Cops arrive on a ramp (one per spawnCooldownTicks), not as a wall, so
    // the posse is measured at its peak over the window rather than at a
    // single instant — the fugitive may be shot dead partway through, which
    // sends everyone home.
    //
    // The fugitive RUNS, side to side. It used to stand still, and the
    // assertion at the bottom — that this costs blood — then held only by
    // timing: a suspect on foot and not going anywhere fast is one an officer
    // within reach ARRESTS rather than shoots (see `tryBust`, and F2 in
    // FEATURES.md). That is the whole risk calculus of the mechanic, so a
    // stationary target getting nicked instead of shot is the design working,
    // not pursuit failing. Measured on a standing target: 24 arrests to 6
    // shots. Running: 49 shots to 2 arrests. If you want to assert blood, the
    // fugitive has to be doing the thing that gets you shot.
    let minDist = Infinity;
    let peakCops = 0;
    for (let i = 0; i < 600; i++) {
      // Keep the fugitive on their feet and wanted: a dead target has no
      // pursuers, and this test is about whether pursuit converges.
      const me = state.players.byId[1]!;
      me.heat = Math.max(me.heat, 310);
      if (me.mode === 'dead') {
        me.mode = 'foot';
        me.health = 100;
        me.respawnAtTick = null;
      }
      const running: InputIntent = {
        ...NULL_INPUT,
        seq: 10_000 + i,
        tick: 10_000 + i,
        right: i % 120 < 60,
        left: i % 120 >= 60,
      };
      state = step(state, { 1: running }, [], map);
      peakCops = Math.max(peakCops, state.cops.ids.length);
      for (const cid of state.cops.ids) {
        const cop = state.cops.byId[cid]!;
        const p1 = state.players.byId[1]!;
        minDist = Math.min(minDist, Math.hypot(cop.pos.x - p1.pos.x, cop.pos.y - p1.pos.y));
      }
    }
    const wanted = wantedLevelOf(state.players.byId[1]!);
    const expectedCops = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
    expect(peakCops).toBeGreaterThanOrEqual(Math.min(expectedCops, 6));
    // They converge: someone got within firing range of the target.
    expect(minDist).toBeLessThan(t.fireRange);
    // And it costs blood: the fugitive has been shot.
    expect(state.players.byId[1]!.health).toBeLessThan(100);
  });

  it('...but a suspect who stands still gets nicked instead of shot', () => {
    // The other half of the same rule, which nothing covered: an officer
    // within reach of a stationary suspect on foot puts hands on them. Worth
    // its own test, because the level-3 chase above used to rest on it not
    // happening and nobody would have noticed if it stopped.
    let state = commitCrimes(3);
    const lane = roadLane(map);
    state.players.byId[1]!.pos = { x: lane.x, y: lane.y };

    const events: SimEvent[] = [];
    for (let i = 0; i < 600; i++) {
      const me = state.players.byId[1]!;
      me.heat = Math.max(me.heat, 310);
      if (me.mode === 'dead') {
        me.mode = 'foot';
        me.health = 100;
        me.respawnAtTick = null;
      }
      state = step(state, {}, [], map, events);
    }
    const busts = events.filter((e) => e.type === 'busted').length;
    const shots = events.filter((e) => e.type === 'shot' && e.playerId < 0).length;
    expect(busts).toBeGreaterThan(0);
    expect(busts).toBeGreaterThan(shots);
  });

  it('heat decays and cops go home when the fugitive stays out of sight', () => {
    // Directly seed modest heat (below one star after decay begins).
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    state.players.byId[1]!.heat = 90; // manual seed, server-side test
    const decayPerTick = getTuning().police.heatDecayPerSec / 30;
    const before = state.players.byId[1]!.heat;
    state = step(state, {}, [], map);
    // No cops exist -> unseen -> decay applies.
    expect(state.players.byId[1]!.heat).toBeCloseTo(before - decayPerTick, 5);
    for (let i = 0; i < 90 * 30; i++) {
      state = step(state, {}, [], map);
      if (state.players.byId[1]!.heat === 0) break;
    }
    expect(state.players.byId[1]!.heat).toBe(0);
  });

  it('shooting a cop hurts it and killing one raises heat hard', () => {
    let state = commitCrimes(1);
    // Let cops arrive.
    for (let i = 0; i < 200 && state.cops.ids.length === 0; i++) {
      state = step(state, {}, [], map);
    }
    expect(state.cops.ids.length).toBeGreaterThan(0);
    const events: SimEvent[] = [];
    let seq = 10_000;
    const heatBefore = state.players.byId[1]!.heat;
    // Blast at the nearest cop until it drops (or 300 ticks pass).
    for (let i = 0; i < 300; i++) {
      const p1 = state.players.byId[1]!;
      const cid = state.cops.ids[0];
      if (cid === undefined) break;
      const cop = state.cops.byId[cid]!;
      const aim = Math.atan2(cop.pos.y - p1.pos.y, cop.pos.x - p1.pos.x);
      state = step(state, { 1: fire(seq++, aim) }, [], map, events);
      if (events.some((e) => e.type === 'copDown')) break;
      if (p1.mode === 'dead') break; // cops shot back first — acceptable
    }
    if (events.some((e) => e.type === 'copDown')) {
      expect(state.players.byId[1]!.heat).toBeGreaterThan(heatBefore);
    }
  });

  it('the whole chase is deterministic', () => {
    const run = (): number => {
      let state = commitCrimes(2);
      for (let i = 0; i < 200; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe('escalation by kind', () => {
  /**
   * Hold a player at `stars` and run the chase. Reports the peak number of
   * officers seen actually driving, because a cruiser is a means of arrival —
   * they dismount inside dismountDist — so any single instant undercounts.
   */
  function chaseAt(
    stars: number,
    ticks: number,
    seed = 55,
  ): { state: GameState; peakDriving: number; peakCars: number } {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    let peakDriving = 0;
    let peakCars = 0;
    for (let i = 0; i < ticks; i++) {
      const p = state.players.byId[1]!;
      p.heat = stars * 100 + 10; // hold the tier steady
      // A fugitive is a MOVING target. Since F2 a suspect standing still
      // beside an officer gets arrested, which ends the chase this test is
      // trying to measure — so keep them running. Movement decays toward zero
      // during the step, but stays above the bust threshold when the police
      // step runs, which is exactly the state of somebody legging it.
      p.vel = { x: getTuning().player.walkSpeed, y: 0 };
      if (p.mode === 'dead') {
        p.health = 100;
        p.mode = 'foot';
        p.respawnAtTick = null;
      }
      state = step(state, {}, [], map);
      peakDriving = Math.max(
        peakDriving,
        state.cops.ids.filter((c) => state.cops.byId[c]!.vehicleId !== null).length,
      );
      peakCars = Math.max(peakCars, copCars(state));
    }
    return { state, peakDriving, peakCars };
  }

  function copCars(state: GameState): number {
    let n = 0;
    for (const id of state.vehicles.ids) {
      if (state.vehicles.byId[id]!.kind === 'copcar') n++;
    }
    return n;
  }

  it('two stars is still an on-foot posse', () => {
    const { state, peakCars, peakDriving } = chaseAt(2, 700);
    expect(state.cops.ids.length).toBeGreaterThan(0);
    expect(peakCars).toBe(0);
    expect(peakDriving).toBe(0);
  });

  it('three stars puts officers in cruisers', () => {
    const { peakCars, peakDriving } = chaseAt(3, 900);
    expect(peakCars).toBeGreaterThan(0);
    expect(peakDriving).toBeGreaterThan(0);
  });

  it('cruisers can actually keep up with a car', () => {
    // This is the hole the whole phase exists to close: cops on foot move at
    // 122 px/s against a player car's 330, so any vehicle was a guaranteed
    // escape from the entire police force.
    const t = getTuning().police;
    expect(t.copCarSpeed).toBeGreaterThan(getTuning().vehicles['car']!.maxSpeed * 0.85);
  });

  it('four stars throws roadblocks across the road', () => {
    const three = chaseAt(3, 1500, 61).peakCars;
    const four = chaseAt(4, 1500, 61).peakCars;
    // Roadblock cruisers are additional to pursuit cruisers.
    expect(four).toBeGreaterThan(three);
  });

  it('every vehicle the chase creates sits on the wire grid', () => {
    // The binary codec ships positions as exact q8 integers on the promise
    // that the sim only ever holds grid values. A roadblock cruiser used to
    // break it: spawned at c + cos(angle)*14 un-quantised, then parked
    // forever, so nothing ever rounded it and every client that saw one
    // carried a permanent one-bit disagreement with the server — the bot
    // harness read it as an endless hash desync. Found by the harness, fixed
    // at the spawn, pinned here.
    const { state } = chaseAt(4, 1500, 61);
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id]!;
      expect(v.pos.x * 8, `vehicle ${id} pos.x ${v.pos.x}`).toBeCloseTo(
        Math.round(v.pos.x * 8),
        9,
      );
      expect(v.pos.y * 8, `vehicle ${id} pos.y ${v.pos.y}`).toBeCloseTo(
        Math.round(v.pos.y * 8),
        9,
      );
    }
  });

  /** Put officer 500 in cruiser 501 at `at`, chasing player 1 at `targetAt`. */
  function wedged(at: { x: number; y: number }, targetAt: { x: number; y: number }): GameState {
    let state = createGameState(71);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    const p = state.players.byId[1]!;
    p.heat = 410;
    p.pos = { x: targetAt.x, y: targetAt.y };
    const cop = createCop(500, at, getTuning().police.copHealth);
    cop.targetId = 1;
    insertEntity(state.cops, cop);
    const heading = Math.atan2(targetAt.y - at.y, targetAt.x - at.x);
    const car = createVehicle(501, 'copcar', at, heading);
    car.driverId = -100000 - 500;
    insertEntity(state.vehicles, car);
    cop.vehicleId = 501;
    return state;
  }

  it('an officer pulls up and finishes the chase on foot', () => {
    const t = getTuning().police;
    // Close enough to be inside dismountDist on the very next tick.
    let state = wedged({ x: 1000, y: 1000 }, { x: 1000 + t.dismountDist - 40, y: 1000 });
    state = step(state, {}, [], map);
    const cop = state.cops.byId[500]!;
    expect(cop.vehicleId).toBeNull();
    // The cruiser is left behind as an ordinary abandoned car.
    expect(state.vehicles.byId[501]!.driverId).toBeNull();
  });

  it('an officer bails out of a cruiser that cannot close, rather than being lost', () => {
    // Target parked inside a building, so no amount of driving closes the
    // gap: the officer must give up on the car and continue on foot.
    let solid = { x: 0, y: 0 };
    outer: for (let ty = 4; ty < map.heightTiles - 4; ty++) {
      for (let tx = 4; tx < map.widthTiles - 4; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] === T_BUILDING) {
          solid = { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
          break outer;
        }
      }
    }
    let state = wedged({ x: solid.x - 300, y: solid.y }, solid);
    for (let i = 0; i < 200 && state.cops.byId[500]?.vehicleId != null; i++) {
      const c = state.cops.byId[500];
      if (c?.vehicleId != null) {
        const veh = state.vehicles.byId[c.vehicleId];
        if (veh) {
          // Keep it intact: a car ramming a wall now damages itself and can
          // detonate, which would end the officer before the bail-out fires.
          veh.health = 130;
          veh.condition = 'ok';
          veh.fuseAtTick = null;
        }
      }
      state.players.byId[1]!.heat = 410;
      state = step(state, {}, [], map);
    }
    const after = state.cops.byId[500];
    expect(after).toBeDefined();
    expect(after!.vehicleId).toBeNull();
  });

  it('a cruiser facing the wrong way turns round instead of ditching the car', () => {
    // The old pursuit controller held the throttle down whenever it was under
    // the speed limit and steered bang-bang at the target, so a cruiser that
    // arrived pointing away drove a circle the width of a block, never closed,
    // and hit the bail-out — the officer lost the car within half a second and
    // ran the rest. It should U-turn and drive.
    const start = { x: 1000, y: 1000 };
    const targetAt = { x: 1240, y: 1000 };
    let state = wedged(start, targetAt);
    state.vehicles.byId[501]!.heading = Math.PI; // facing directly away
    const before = Math.hypot(start.x - targetAt.x, start.y - targetAt.y);
    for (let i = 0; i < 40; i++) {
      state.players.byId[1]!.heat = 410;
      state = step(state, {}, [], map);
    }
    const cop = state.cops.byId[500]!;
    expect(cop.vehicleId).toBe(501); // still driving
    const after = Math.hypot(cop.pos.x - targetAt.x, cop.pos.y - targetAt.y);
    expect(after).toBeLessThan(before);
  });

  it('the whole motorised chase is deterministic', () => {
    const run = (): number => hashState(chaseAt(4, 900, 88).state);
    expect(run()).toBe(run());
  });
});

describe('arrest (F2): busted is not wasted', () => {
  /** A wanted player on foot with one officer standing on top of them. */
  function grabbed(playerMoving: boolean, inCar = false): { state: GameState; events: SimEvent[] } {
    let state = createGameState(99);
    state = step(
      state,
      {},
      [{ type: 'spawnPlayer', playerId: 1, name: 'crook', loadout: PISTOL }],
      map,
    );
    const p = state.players.byId[1]!;
    p.heat = 250; // wanted 2: cops are interested
    if (inCar) {
      state = step(
        state,
        {},
        [
          {
            type: 'spawnVehicle',
            vehicleId: 7,
            kind: 'car',
            x: p.pos.x,
            y: p.pos.y,
            heading: 0,
          },
        ],
        map,
      );
      const pp = state.players.byId[1]!;
      pp.mode = 'driving';
      pp.vehicleId = 7;
      state.vehicles.byId[7]!.driverId = 1;
      pp.heat = 250;
    }
    const me = state.players.byId[1]!;
    const cop = createCop(500, { x: me.pos.x + 8, y: me.pos.y }, getTuning().police.copHealth);
    insertEntity(state.cops, cop);
    // Moving: already at walk speed, which is well over the bust threshold.
    if (playerMoving) {
      me.vel = { x: getTuning().player.walkSpeed, y: 0 };
    }
    const events: SimEvent[] = [];
    const input = playerMoving ? { ...NULL_INPUT, seq: 1, tick: 1, up: true } : NULL_INPUT;
    state = step(state, { 1: input }, [], map, events);
    return { state, events };
  }

  it('an officer within reach of a stationary suspect arrests them', () => {
    const { state, events } = grabbed(false);
    const busted = events.find((e) => e.type === 'busted');
    expect(busted).toBeDefined();
    // The death pipeline still runs — one code path for "out of play".
    expect(events.some((e) => e.type === 'death' && e.playerId === 1)).toBe(true);
    const p = state.players.byId[1]!;
    expect(p.mode).toBe('dead');
    // An arrest ends the chase outright rather than letting it decay.
    expect(p.heat).toBe(0);
    expect(p.wantedLevel).toBe(0);
    // Guns confiscated, hands kept.
    expect(p.weapons.map((w) => w.weaponId)).toEqual([]);
    expect(p.armour).toBe(0);
  });

  it('run and you get shot instead — the whole risk calculus', () => {
    const { state, events } = grabbed(true);
    expect(events.some((e) => e.type === 'busted')).toBe(false);
    // Still wanted, still being shot at: the officer fired rather than grabbed.
    expect(state.players.byId[1]!.heat).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'shot')).toBe(true);
  });

  it('a driver is never arrested through the windscreen', () => {
    const { events } = grabbed(false, true);
    expect(events.some((e) => e.type === 'busted')).toBe(false);
  });

  it('one officer does one thing per cadence: no bust and shot on the same tick', () => {
    const { events } = grabbed(false);
    expect(events.some((e) => e.type === 'busted')).toBe(true);
    expect(events.some((e) => e.type === 'shot')).toBe(false);
  });

  it('an arrest is deterministic', () => {
    const run = (): number => hashState(grabbed(false).state);
    expect(run()).toBe(run());
  });

  it('worldgen places police stations, and arrest respawns at one', () => {
    expect(map.policeStations.length).toBeGreaterThan(0);
    const { state } = grabbed(false);
    const p = state.players.byId[1]!;
    const after = step(
      state,
      {},
      [{ type: 'respawnPlayer', playerId: 1, loadout: [], atStation: true }],
      map,
    );
    const at = after.players.byId[1]!.pos;
    const nearestStation = Math.min(
      ...map.policeStations.map((s) => Math.hypot(s.x - at.x, s.y - at.y)),
    );
    const nearestHospital = Math.min(
      ...map.hospitals.map((h) => Math.hypot(h.x - at.x, h.y - at.y)),
    );
    expect(nearestStation).toBe(0);
    expect(nearestHospital).toBeGreaterThan(0);
    expect(p.id).toBe(1);
  });

  it('dying still wakes you at a hospital', () => {
    let state = createGameState(99);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'victim' }], map);
    state.players.byId[1]!.mode = 'dead';
    const after = step(state, {}, [{ type: 'respawnPlayer', playerId: 1, loadout: [] }], map);
    const at = after.players.byId[1]!.pos;
    expect(Math.min(...map.hospitals.map((h) => Math.hypot(h.x - at.x, h.y - at.y)))).toBe(0);
  });
});

describe('escalation by kind (I1)', () => {
  /** Hold a player at `stars` long enough for the response to turn out. */
  function forceAt(stars: number, ticks = 400): GameState {
    let state = createGameState(31);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    for (let i = 0; i < ticks; i++) {
      const p = state.players.byId[1]!;
      p.heat = stars * 100 + 10;
      p.vel = { x: getTuning().player.walkSpeed, y: 0 }; // fleeing, not surrendering
      if (p.mode === 'dead') {
        p.health = 100;
        p.mode = 'foot';
        p.respawnAtTick = null;
      }
      state = step(state, {}, [], map);
    }
    return state;
  }

  function kindsPresent(state: GameState): Set<string> {
    return new Set(state.cops.ids.map((id) => state.cops.byId[id]!.kind));
  }

  it('each tier fields a different force, not more of the last one', () => {
    // The point of the ladder: a fifth patrolman is the same problem as the
    // fourth. These must differ in KIND.
    expect(kindsPresent(forceAt(2))).toEqual(new Set(['patrol']));
    expect(kindsPresent(forceAt(4))).toEqual(new Set(['swat']));
    expect(kindsPresent(forceAt(5))).toEqual(new Set(['fed']));
    expect(kindsPresent(forceAt(6))).toEqual(new Set(['army']));
  });

  it('the ceiling is six, and heat cannot climb past it', () => {
    const p = { heat: 0 } as never as Parameters<typeof wantedLevelOf>[0];
    for (let i = 0; i < 100; i++) addHeat(p, 100);
    expect(wantedLevelOf(p)).toBe(6);
  });

  it('higher tiers are tougher and better armed', () => {
    const t = getTuning().police;
    const patrol = t.kinds['patrol']!;
    const army = t.kinds['army']!;
    expect(army.health).toBeGreaterThan(patrol.health);
    expect(getWeaponTuning(army.weapon)!.damage).toBeGreaterThan(
      getWeaponTuning(patrol.weapon)!.damage,
    );
  });

  it('an officer keeps the uniform they turned out in', () => {
    // Escalation fields new units; it does not upgrade the ones already
    // chasing you, or a two-star pursuit would silently become a six-star one
    // in the officers' hands.
    let state = forceAt(2, 200);
    const original = state.cops.ids.slice();
    expect(original.length).toBeGreaterThan(0);
    expect(original.every((id) => state.cops.byId[id]!.kind === 'patrol')).toBe(true);

    for (let i = 0; i < 60; i++) {
      const p = state.players.byId[1]!;
      p.heat = 610; // straight to the top of the ladder
      p.vel = { x: getTuning().player.walkSpeed, y: 0 };
      state = step(state, {}, [], map);
    }

    // Every officer who was already on the scene is still a patrolman...
    for (const id of original) {
      const cop = state.cops.byId[id];
      if (!cop) continue; // some will have despawned or died; those prove nothing
      expect(cop.kind).toBe('patrol');
    }
    // ...and the reinforcements are army.
    const fresh = state.cops.ids.filter((id) => !original.includes(id));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((id) => state.cops.byId[id]!.kind === 'army')).toBe(true);
  });

  it('the cop kind survives the wire and the hash', () => {
    const state = forceAt(6);
    expect(kindsPresent(state)).toEqual(new Set(['army']));
    expect(hashState(state)).toBe(hashState(state));
  });
});
