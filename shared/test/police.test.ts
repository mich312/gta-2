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
import { applyDamage, damageCop } from '../src/sim/weapons.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { T_BUILDING, TILE_SIZE } from '../src/world/types.js';
import { clearSpot, roadLane, straightEastLane } from './helpers.js';
import { isSolidTile } from '../src/world/collide.js';
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
    // The crook keeps moving while shooting. Standing still, they are a
    // stationary suspect — and since the bust-standoff fix an officer who
    // reaches one ARRESTS them, which zeroes heat and resets the spree this
    // fixture exists to build. Legging it is what makes you shootable-at
    // and un-arrestable; it is also what an actual spree looks like.
    const moving = { ...fire(seq++, aim), right: t % 120 < 60, left: t % 120 >= 60 };
    state = step(state, { 1: moving }, cmds, map);
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
    // Measured across the window, like peakCops and for the same reason: the
    // loop below patches the fugitive back up whenever they go down, so
    // health at the final tick says only whether they were shot RECENTLY.
    // Ambient traffic (and now the lights it waits at) shifts the timing of
    // the whole chase, which is how a passing test came to depend on it.
    let everHurt = false;
    for (let i = 0; i < 600; i++) {
      // Keep the fugitive on their feet and wanted: a dead target has no
      // pursuers, and this test is about whether pursuit converges.
      const me = state.players.byId[1]!;
      if (me.health < 100) everHurt = true;
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
    expect(everHurt).toBe(true);
  });

  it('...but a suspect who stands still gets nicked instead of shot', () => {
    // The other half of the same rule, which nothing covered: an officer
    // within reach of a stationary suspect on foot puts hands on them. Worth
    // its own test, because the level-3 chase above used to rest on it not
    // happening and nobody would have noticed if it stopped.
    const t = getTuning().police;
    let state = commitCrimes(3);
    // A quiet straight street: officers must be able to pull up and close on
    // foot, which a junction-riddled or dead-end spot can quietly prevent.
    const lane = straightEastLane(map);
    state.players.byId[1]!.pos = { x: lane.x + 5 * TILE_SIZE, y: lane.y };

    const events: SimEvent[] = [];
    // How far the SHOOTER was from the suspect, for every police shot. The
    // shot event carries the muzzle position, which is the officer's own —
    // the nearest officer is the wrong thing to measure, because the one who
    // has just put hands on you is on cooldown while his colleagues fire.
    const shooterRange: number[] = [];
    for (let i = 0; i < 600; i++) {
      const me = state.players.byId[1]!;
      me.heat = Math.max(me.heat, 310);
      if (me.mode === 'dead') {
        me.mode = 'foot';
        me.health = 100;
        me.respawnAtTick = null;
      }
      const before = events.length;
      state = step(state, {}, [], map, events);
      const after = state.players.byId[1]!;
      for (let k = before; k < events.length; k++) {
        const e = events[k];
        if (!e || e.type !== 'shot' || e.playerId >= 0) continue;
        shooterRange.push(Math.hypot(e.x0 - after.pos.x, e.y0 - after.pos.y));
      }
    }
    const busts = events.filter((e) => e.type === 'busted').length;
    expect(busts).toBeGreaterThan(0);
    // Hands before bullets, stated as the rule rather than as a ratio.
    //
    // This asserted `busts > shots` and measured 24 to 6, which read as
    // proof. It is not: it is a measurement of where a pack of six officers
    // happens to come to rest, and any change that shifts the sim's random
    // sequence moves it. Merging traffic signals, boarding and gang fights in
    // — none of which the police touch — moved it to 29 and 29, and the
    // *reason* turned out to be geometry: one officer settles at exactly the
    // bust radius and cuffs the suspect, while colleagues stood off at 30-60
    // px keep firing on their own cadence. That is the design working.
    //
    // So assert the thing that is actually true and does not depend on the
    // pack: no officer within arm's reach of a suspect standing still shoots
    // them. One that close cuffs them instead — every time. A pixel of slack
    // because the event rounds the muzzle to whole pixels.
    expect(shooterRange.length).toBeGreaterThan(0);
    for (const d of shooterRange) expect(d).toBeGreaterThan(t.bustRadius - 1.5);
  });

  it('heat holds for the cool-down, then decays on a ramp (P1b)', () => {
    // The rule this pins replaced a presence gate — "does anybody see you
    // right now" — which the spawner defeated by construction, since it
    // answers a wanted level by putting fresh officers inside sight range.
    // The clock can be waited out; the gate could not. See GTA.md P1.
    const t = getTuning().police;
    let state = createGameState(9);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    state.players.byId[1]!.heat = 90; // manual seed, server-side test

    // Nothing comes off during the cool-down, however empty the street is.
    // The threshold tick is the first one that decays, so the quiet stretch
    // is one shorter than the tunable.
    for (let i = 0; i < t.wantedCooldownTicks - 1; i++) state = step(state, {}, [], map);
    expect(state.players.byId[1]!.heat).toBe(90);

    // The tick the clock expires, decay starts at exactly the base rate: the
    // ramp is measured from the threshold, not from the crime.
    const before = state.players.byId[1]!.heat;
    state = step(state, {}, [], map);
    expect(state.players.byId[1]!.heat).toBeCloseTo(before - t.heatDecayPerSec / 30, 5);

    // And it accelerates: the second second sheds more than the first.
    const mark = state.players.byId[1]!.heat;
    for (let i = 0; i < 30; i++) state = step(state, {}, [], map);
    const firstSecond = mark - state.players.byId[1]!.heat;
    const mark2 = state.players.byId[1]!.heat;
    for (let i = 0; i < 30; i++) state = step(state, {}, [], map);
    expect(mark2 - state.players.byId[1]!.heat).toBeGreaterThan(firstSecond);

    for (let i = 0; i < 90 * 30; i++) {
      state = step(state, {}, [], map);
      if (state.players.byId[1]!.heat === 0) break;
    }
    expect(state.players.byId[1]!.heat).toBe(0);
  });

  it('a five-star chase can be escaped, and in about the time it is meant to', () => {
    // The headline number of P1, asserted rather than argued. Before it, the
    // answer was "never": the decay gate was held shut by officers the
    // spawner produced in proportion to the wanted level itself.
    let state = createGameState(11);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    state.players.byId[1]!.heat = 500;
    let ticks = 0;
    for (; ticks < 30 * 120; ticks++) {
      state = step(state, {}, [], map);
      if (state.players.byId[1]!.heat === 0) break;
    }
    expect(state.players.byId[1]!.heat).toBe(0);
    // Long enough to be an achievement, short enough to attempt. The window
    // is wide on purpose — it is a design target, not a golden value.
    expect(ticks / 30).toBeGreaterThan(20);
    expect(ticks / 30).toBeLessThan(60);
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
    at?: { x: number; y: number },
    drive = false,
  ): { state: GameState; peakDriving: number; peakCars: number; peakBlocks: number } {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    // Roadblock tests hand a lane position: blocks are thrown across the
    // road AHEAD of the fugitive, so a fugitive off in the countryside (or
    // wherever the seed's spawn landed) may have no kerb ahead to build on.
    if (at) state.players.byId[1]!.pos = { x: at.x, y: at.y };
    if (at && drive) {
      // Roadblocks are thrown AHEAD of a fleeing DRIVER; a walker never
      // rates one. Put the fugitive in a car barrelling east up the lane.
      state = step(
        state,
        {},
        [{ type: 'spawnVehicle', vehicleId: 777, kind: 'car', x: at.x, y: at.y, heading: 0 }],
        map,
      );
      const p = state.players.byId[1]!;
      const v = state.vehicles.byId[777]!;
      v.driverId = 1;
      p.vehicleId = 777;
      p.mode = 'driving';
    }
    let peakDriving = 0;
    let peakCars = 0;
    let peakBlocks = 0;
    for (let i = 0; i < ticks; i++) {
      const p = state.players.byId[1]!;
      p.heat = stars * 100 + 10; // hold the tier steady
      // A fugitive is a MOVING target. Since F2 a suspect standing still
      // beside an officer gets arrested, which ends the chase this test is
      // trying to measure — so keep them running. Movement decays toward zero
      // during the step, but stays above the bust threshold when the police
      // step runs, which is exactly the state of somebody legging it.
      p.vel = { x: getTuning().player.walkSpeed, y: 0 };
      // Driving stagings leave the fugitive PARKED, engine running: the
      // roadblock's ahead-point follows the vehicle heading, so it lands
      // 420 px up this straight street where kerbside spawns exist — and a
      // driver cannot be arrested through the windscreen, so the chase
      // holds. A held top speed just wedged the car in the first corner.
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
      // A roadblock's signature is the PAIR: two driverless cruisers
      // parked within a couple of car lengths of each other, across the
      // road. A single driverless cruiser is just a dismounted officer's.
      const parked: Array<{ x: number; y: number }> = [];
      for (const id of state.vehicles.ids) {
        const v = state.vehicles.byId[id]!;
        if (v.kind === 'copcar' && v.driverId === null) parked.push({ x: v.pos.x, y: v.pos.y });
      }
      let pairs = 0;
      for (let a = 0; a < parked.length; a++) {
        for (let b = a + 1; b < parked.length; b++) {
          if (Math.hypot(parked[a]!.x - parked[b]!.x, parked[a]!.y - parked[b]!.y) < 48) pairs++;
        }
      }
      peakBlocks = Math.max(peakBlocks, pairs);
    }
    return { state, peakDriving, peakCars, peakBlocks };
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
    // Measured directly as DRIVERLESS cruisers — a roadblock is parked
    // stock, a pursuit car has an officer in it. Comparing total car
    // counts saturated against the per-player cop ceiling and proved
    // nothing on maps where pursuit alone reaches it.
    // A roadblock is built ON a kerbside spawn point within 90 px of the
    // spot 420 px ahead of the fugitive. A parked driver's ahead-point is
    // FIXED, so stage the car exactly one roadblockAheadDist west of a
    // real spawn — the trigger then has a guaranteed site every attempt.
    const site = map.vehicleSpawns[0]!;
    const lane = { x: site.x - getTuning().police.roadblockAheadDist, y: site.y };
    const three = chaseAt(3, 1500, 61, lane, true).peakBlocks;
    const four = chaseAt(4, 1500, 61, lane, true).peakBlocks;
    expect(four, 'no roadblock pair at four stars').toBeGreaterThan(three);
  });

  it('every vehicle the chase creates sits on the wire grid', () => {
    // The binary codec ships positions as exact q8 integers on the promise
    // that the sim only ever holds grid values. A roadblock cruiser used to
    // break it: spawned at c + cos(angle)*14 un-quantised, then parked
    // forever, so nothing ever rounded it and every client that saw one
    // carried a permanent one-bit disagreement with the server — the bot
    // harness read it as an endless hash desync. Found by the harness, fixed
    // at the spawn, pinned here.
    const { state } = chaseAt(4, 1500, 61, straightEastLane(map));
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

  it('an officer who cannot find the suspect gives up, rather than hunting for ever (P1a)', () => {
    // Target parked inside a building: never visible, never reachable. The
    // old force would drive at the wall until the stuck-counter took the car
    // away and then stand there indefinitely, because pursuit read
    // `target.pos` directly and nobody could ever be given the slip.
    const t = getTuning().police;
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
    // Held above a star throughout, so giving up is the search expiring and
    // not the suspect simply becoming uninteresting.
    for (let i = 0; i < t.searchGiveUpTicks + 30; i++) {
      state.players.byId[1]!.heat = 410;
      state = step(state, {}, [], map);
    }
    const after = state.cops.byId[500];
    expect(after).toBeDefined();
    expect(after!.targetId).toBeNull();
    expect(after!.searchTicks).toBeGreaterThanOrEqual(t.searchGiveUpTicks);
  });

  it('an officer bails out of a cruiser that cannot close, rather than being lost', () => {
    // The stuck bail-out, which survives P1 and is still the only way a
    // wedged cruiser stops being a wedged cruiser. Set up so the officer can
    // SEE the target throughout — a chase, not a search — with the car nosed
    // into the building behind them.
    //
    // (The other old exit, "close but with a wall between", was removed with
    // P1a: `blocked` and `seen` are the same ray test, so it could never
    // fire once pursuit stopped being omniscient. A fugitive inside a
    // building is now a search that expires, covered by its own test above.)
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
    for (let i = 0; i < 400 && state.cops.byId[500]?.vehicleId != null; i++) {
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
        // Hold the officer in contact: park the suspect on the cruiser's nose
        // each tick, in the open, so `seen` is true and the pursuit drives at
        // them rather than sweeping for them.
        const p = state.players.byId[1]!;
        p.pos = { x: veh.pos.x + 40, y: veh.pos.y };
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
    //
    // Staged on found OPEN GROUND, not a hard-coded coordinate and not a
    // street: a U-turn needs room for its arc, and since the vehicle-parts
    // work slowed low-speed steering, a cruiser boxed between kerbs runs
    // out of patience and bails — which is the OTHER test's behaviour. The
    // claim here is "given room, it turns and closes".
    // 26×5 tiles of open ground with the start NINE tiles in: the cruiser
    // faces AWAY (west) before it turns, so it needs arc room behind it as
    // well as the driving line to the target in front — a clearing checked
    // only eastward parks it against whatever lies west and it bails.
    let clearing: { x: number; y: number } | null = null;
    outer: for (let ty = 8; ty < map.heightTiles - 8; ty++) {
      for (let tx = 8; tx < map.widthTiles - 34; tx++) {
        let open = true;
        for (let dy = -2; dy <= 2 && open; dy++) {
          for (let dx = 0; dx < 26; dx++) {
            if (isSolidTile(map, tx + dx, ty + dy, 'land')) {
              open = false;
              break;
            }
          }
        }
        if (!open) continue;
        clearing = { x: (tx + 9.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
        break outer;
      }
    }
    expect(clearing, 'no open clearing on this map').not.toBeNull();
    const start = clearing!;
    const targetAt = { x: start.x + 240, y: start.y };
    let state = wedged(start, targetAt);
    state.vehicles.byId[501]!.heading = Math.PI; // facing directly away
    const before = Math.hypot(start.x - targetAt.x, start.y - targetAt.y);
    // 40 ticks: enough to turn and start closing, NOT enough to arrive —
    // a cruiser that reaches dismountDist finishes the chase on foot
    // (correctly), and this assertion would misread that as ditching.
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

describe('the difficulty pass (P2)', () => {
  /**
   * A player and an officer on a verified clear line at a chosen separation.
   *
   * `clearSpot` rather than a fixed offset, and for the reason the fixtures
   * above give: a wall between the two makes the test a test of nothing. It
   * cost an hour here — an officer placed 240 px "down the lane" had a
   * building in the way, so it never saw the target, searched instead, and
   * walked off up the street.
   */
  function faceOff(
    seed: number,
    separation: number,
    kind: string,
    copId: number,
  ): { state: GameState; me: { x: number; y: number }; at: { x: number; y: number } } {
    let state = createGameState(seed);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
    const lane = straightEastLane(map);
    const me = { x: lane.x, y: lane.y };
    state.players.byId[1]!.pos = { x: me.x, y: me.y };
    const spot = clearSpot(map, me, separation);
    const cop = createCop(copId, { x: spot.x, y: spot.y }, 900, kind);
    cop.targetId = 1;
    cop.lastSeenX = me.x;
    cop.lastSeenY = me.y;
    insertEntity(state.cops, cop);
    return { state, me, at: { x: spot.x, y: spot.y } };
  }

  /**
   * One officer, one shot, at a chosen range and target speed. The rng draw
   * is the same every time, so the only thing that moves the round is the
   * spread terms under test.
   */
  function shotAngleError(separation: number, targetSpeed: number): number {
    const f = faceOff(4242, separation, 'patrol', 700);
    let state = f.state;
    const events: SimEvent[] = [];
    for (let i = 0; i < 90; i++) {
      // Both parties pinned: this measures the spread, not the chase.
      const me = state.players.byId[1]!;
      me.pos = { x: f.me.x, y: f.me.y };
      me.vel = { x: targetSpeed, y: 0 };
      me.heat = 310;
      me.health = 200;
      const c = state.cops.byId[700];
      if (c) c.pos = { x: f.at.x, y: f.at.y };
      const before = events.length;
      state = step(state, {}, [], map, events);
      for (let k = before; k < events.length; k++) {
        const e = events[k];
        if (!e || e.type !== 'shot' || e.playerId !== -700) continue;
        // How far off the true bearing the round went.
        const want = Math.atan2(f.me.y - f.at.y, f.me.x - f.at.x);
        const got = Math.atan2(e.y1 - e.y0, e.x1 - e.x0);
        return Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
      }
    }
    throw new Error('no police shot observed');
  }

  it('accuracy falls off with range (P2a)', () => {
    // Same officer, same draw, same target: only the distance changes. Before
    // this the far end of a cordon was as lethal as the near end.
    expect(shotAngleError(150, 0)).toBeGreaterThan(shotAngleError(40, 0));
  });

  it('...and with how fast the target is moving', () => {
    // The lever that stops a cordon deleting a car crossing a junction.
    expect(shotAngleError(120, 200)).toBeGreaterThan(shotAngleError(120, 0));
  });

  it('a burst is followed by a beat (P2b)', () => {
    // The gaps are what a player moves in. A flat cooldown made an officer's
    // peak damage and their sustained damage the same number, which is how
    // ten federal agents came to delete a full-health player in half a second.
    const kind = getTuning().police.kinds['fed'];
    expect(kind).toBeDefined();
    expect(kind!.burstCount).toBeGreaterThan(0);
    const weapon = getWeaponTuning(kind!.weapon)!;
    const f = faceOff(77, 60, 'fed', 701);
    let state = f.state;

    const gaps: number[] = [];
    let last = -1;
    const events: SimEvent[] = [];
    for (let i = 0; i < 240; i++) {
      const me = state.players.byId[1]!;
      me.pos = { x: f.me.x, y: f.me.y };
      me.heat = 510;
      me.health = 500;
      const c = state.cops.byId[701];
      if (c) c.pos = { x: f.at.x, y: f.at.y };
      const before = events.length;
      state = step(state, {}, [], map, events);
      for (let k = before; k < events.length; k++) {
        const e = events[k];
        // This officer's rounds only: five stars means colleagues turn out,
        // and their shots would read as impossible zero-tick gaps.
        if (!e || e.type !== 'shot' || e.playerId !== -701) continue;
        if (last >= 0) gaps.push(i - last);
        last = i;
      }
    }
    expect(gaps.length).toBeGreaterThan(kind!.burstCount);
    // Most gaps are the weapon's own cadence; at least one is the beat.
    expect(Math.min(...gaps)).toBe(weapon.cooldownTicks);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(weapon.cooldownTicks + kind!.burstPauseTicks);
  });

  it('riflemen hold a cordon instead of joining the huddle (P2c)', () => {
    // Every officer used to close to arrest reach, so a five-star response
    // was ten people standing on top of you at minimum range.
    const t = getTuning().police;
    expect(t.kinds['army']!.preferredRange).toBeGreaterThan(t.bustRadius);
    const f = faceOff(78, 220, 'army', 702);
    let state = f.state;
    let closest = Infinity;
    for (let i = 0; i < 300; i++) {
      const me = state.players.byId[1]!;
      me.pos = { x: f.me.x, y: f.me.y };
      me.heat = 610;
      me.health = 900;
      state = step(state, {}, [], map);
      const c = state.cops.byId[702];
      if (c) closest = Math.min(closest, Math.hypot(c.pos.x - f.me.x, c.pos.y - f.me.y));
    }
    // Closed to the cordon, and no further. A stride of slack either side.
    expect(closest).toBeLessThan(t.kinds['army']!.preferredRange + 20);
    expect(closest).toBeGreaterThan(t.bustRadius);
  });

  it('a shield is a fact about which side you are on (P2c)', () => {
    // Frontal damage only differs for kinds that carry one, and going round
    // is the answer rather than more bullets.
    const swat = getTuning().police.kinds['swat']!;
    expect(swat.frontalDamage).toBeLessThan(1);

    const healthAfter = (facingAway: boolean): number => {
      let state = createGameState(79);
      state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'x' }], map);
      const lane = straightEastLane(map);
      state.players.byId[1]!.pos = { x: lane.x, y: lane.y };
      // The officer stands east of the player, so the shot arrives from the
      // west. Moving east is facing away from it; moving west is facing it.
      const cop = createCop(703, { x: lane.x + 60, y: lane.y }, 200, 'swat');
      cop.vel = { x: facingAway ? 60 : -60, y: 0 };
      insertEntity(state.cops, cop);
      damageCop(state, cop, 40, 1, []);
      return cop.health;
    };
    expect(healthAfter(true)).toBeLessThan(healthAfter(false));
  });

  it('someone under the wheels is a lesser crime than someone shot (P2d)', () => {
    // Driving is the main verb and the pavements are full. At a flat 80 a
    // kill, running over four people you never saw was three stars — and
    // with heat that could not come down, that is most of what "too hard"
    // meant. See GTA.md P2d.
    const t = getTuning().peds;
    expect(t.heatPerRoadKill).toBeLessThan(t.heatPerPedKill);
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
