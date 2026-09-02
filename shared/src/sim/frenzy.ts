import { DT, PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { dCos, dSin } from '../math/trig.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState } from './state.js';
import type { SimEvent } from './events.js';
import { damageVehicle } from './vehicleDamage.js';
import { applyDamage } from './weapons.js';
import { T_RAMP, TILE_SIZE, type CityMap } from '../world/types.js';
import { STEP_UP, groundUnder } from '../world/volume.js';

/**
 * Frenzies and stunts: the two things that give a sandbox a reason to exist
 * beyond wandering.
 *
 * There was no goal and no score anywhere in this game. Money bought three
 * guns and four jackets and nothing else wanted it.
 */

/** Gravity for airborne vehicles, px/s². */
const GRAVITY = 900;
/** Below this you are not going fast enough to leave the ground. */
const RAMP_MIN_SPEED = 128;
/** Vertical kick a ramp imparts, scaled by how fast you hit it. */
const RAMP_LAUNCH = 0.62;
/**
 * Descent rate you can put down without hurting the car. A ramp taken at the
 * minimum speed comes back at ~80 px/s, so a modest hop still costs nothing
 * and only a real flight bends anything.
 */
const LANDING_SAFE_VZ = 90;
/**
 * How hard a PERSON can hit the ground for free, and what it costs past it.
 *
 * Lower than a car's, because a car has suspension and a person has ankles.
 * At the shipped `chopper.cruiseZ` of 48 a bail-out lands at about 294 px/s,
 * which costs roughly two thirds of a full-health player — survivable, and
 * never something you would choose over landing the thing.
 */
const FALL_SAFE_VZ = 150;
const FALL_DAMAGE_PER_VZ = 0.45;
const FALL_STUN_TICKS = 20;
/** Damage per px/s of descent above that, before the car's mass divides it. */
const LANDING_DAMAGE_PER_VZ = 0.5;

/**
 * Tick down a running frenzy. Kills are credited by the caller (they arrive
 * as events), so this only handles expiry — but expiry is what makes it a
 * frenzy rather than a checklist.
 */
export function stepFrenzy(state: GameState, events: SimEvent[]): void {
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.frenzyTarget <= 0 || p.frenzyEndsAtTick === null) continue;
    if (state.tick < p.frenzyEndsAtTick) continue;
    // Ran out of time. The reward is only paid on completion, which is
    // handled server-side off the frenzyDone event.
    events.push({
      type: 'frenzyEnded',
      tick: state.tick,
      playerId: pid,
      kills: p.frenzyKills,
      target: p.frenzyTarget,
      completed: false,
    });
    p.frenzyTarget = 0;
    p.frenzyKills = 0;
    p.frenzyEndsAtTick = null;
  }
}

/** Credit a kill toward a running frenzy; emits completion when it lands. */
export function creditFrenzyKill(state: GameState, killerId: number, events: SimEvent[]): void {
  const p = state.players.byId[killerId];
  if (!p || p.frenzyTarget <= 0) return;
  p.frenzyKills++;
  if (p.frenzyKills < p.frenzyTarget) return;
  events.push({
    type: 'frenzyEnded',
    tick: state.tick,
    playerId: killerId,
    kills: p.frenzyKills,
    target: p.frenzyTarget,
    completed: true,
  });
  p.frenzyTarget = 0;
  p.frenzyKills = 0;
  p.frenzyEndsAtTick = null;
}

/**
 * Stunt jumps: the vertical dimension this game never had.
 *
 * The top-down originals had no jump button either, so its absence is
 * period-correct — but they did have ramps, air time and a bonus, and
 * nothing had taken their place here. A car crossing a ramp tile above
 * RAMP_MIN_SPEED leaves the ground; while airborne it ignores tile collision
 * entirely, which is the whole point: you clear things.
 */
export function stepStunts(state: GameState, map: CityMap, events: SimEvent[]): void {
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p) continue;

    // On foot, in the air: falling.
    //
    // This used to pin anybody not driving to the ground, which was right
    // while the only way up was a ramp — you cannot ramp on foot. An
    // aircraft changed that: step out of a helicopter at cruise height and
    // you are eight storeys up with nothing under you. The fall is its own
    // small physics, deliberately not the vehicle's: no `airDist`, no stunt
    // event, no bonus. You went up in something and left it; that is not a
    // jump, it is a mistake with a landing.
    //
    // Against the GROUND UNDER THEM, not against zero (3D.md X2): the ground
    // has a height where the session asked for one — a kerb, a ramp, a roof
    // somebody bailed out onto — and on a flat map it is zero everywhere, so
    // every comparison below is the one it always was.
    if (p.mode !== 'driving' || p.vehicleId === null) {
      const g = groundUnder(map, p.pos.x, p.pos.y, PLAYER_RADIUS);
      stepDown(map, p, g);
      if (p.z > g || p.vz > 0) {
        p.vz = q8(p.vz - GRAVITY * DT);
        p.z = q8(p.z + p.vz * DT);
        if (p.z <= g) {
          const impact = -p.vz;
          p.z = g;
          p.vz = 0;
          p.airDist = 0;
          if (impact > FALL_SAFE_VZ) {
            // A moment on the floor as well as the blood: the same shape as
            // bailing out of a moving car, and for the same reason — the
            // cheap exit has to cost something or it is the only exit.
            p.fireCooldown = Math.max(p.fireCooldown, FALL_STUN_TICKS);
            applyDamage(
              state,
              p,
              (impact - FALL_SAFE_VZ) * FALL_DAMAGE_PER_VZ,
              p.id,
              'fall',
              events,
            );
          }
        }
        continue;
      }
      // On the ground: resting on it. Stepping onto a kerb lifts the feet
      // three px; a lip past `STEP_UP` is a surface the walls should have
      // kept them off, and they keep their height rather than teleport.
      if (p.z !== g || p.vz !== 0) {
        if (g - p.z <= STEP_UP) p.z = g;
        p.vz = 0;
        p.airDist = 0;
      }
      continue;
    }
    const v = state.vehicles.byId[p.vehicleId];
    if (!v) continue;
    const g = groundUnder(map, v.pos.x, v.pos.y, getVehicleTuning(v.kind).halfExtent);
    stepDown(map, p, g);

    if (p.z > g || p.vz > 0) {
      // In the air: integrate, accumulate distance, and land.
      p.vz = q8(p.vz - GRAVITY * DT);
      p.z = q8(p.z + p.vz * DT);
      p.airDist = q8(p.airDist + Math.abs(v.speed) * DT);
      if (p.z <= g) {
        const dist = p.airDist;
        // What the landing cost. A jump used to be free money: the sim
        // integrated z, emitted the event, and did nothing else, so a 300 px
        // flight had no consequence at all. Damage goes to the FRONT of the
        // car, because that is what lands first and what the damage map can
        // now say — a bad landing puts the lights out and holes the radiator.
        const impact = -p.vz;
        if (impact > LANDING_SAFE_VZ) {
          const t = getVehicleTuning(v.kind);
          damageVehicle(
            state,
            v,
            ((impact - LANDING_SAFE_VZ) * LANDING_DAMAGE_PER_VZ) / t.mass,
            events,
            // Landing badly is your own doing, but it is not a crime, and
            // charging the driver for it would make every stunt heat.
            null,
            v.pos.x + dCos(v.heading) * t.halfLength,
            v.pos.y + dSin(v.heading) * t.halfLength,
          );
        }
        p.z = g;
        p.vz = 0;
        p.airDist = 0;
        events.push({
          type: 'stuntLanded',
          tick: state.tick,
          playerId: pid,
          distance: Math.round(dist),
          x: Math.round(v.pos.x),
          y: Math.round(v.pos.y),
        });
      }
      continue;
    }

    // On the ground: on it — a car on the kerb sits a kerb's height up.
    if (p.z !== g && g - p.z <= STEP_UP) p.z = g;

    // On the ground: did the car cross a ramp tile this tick?
    //
    // Sampling only the final position misses it. A ramp tile is 16 px and a
    // car at speed covers most of that per tick, so the one frame it is
    // actually standing on the ramp is easy to step straight over — the car
    // launches or not depending on sub-tile phase, which reads as the ramps
    // being broken. Sweep back along the heading instead.
    if (Math.abs(v.speed) < RAMP_MIN_SPEED) continue;
    if (getVehicleTuning(v.kind).medium !== 'land') continue;
    let onRamp = false;
    for (const back of [0, TILE_SIZE / 2, TILE_SIZE]) {
      const sx = v.pos.x - dCos(v.heading) * back * Math.sign(v.speed);
      const sy = v.pos.y - dSin(v.heading) * back * Math.sign(v.speed);
      const tx = Math.floor(sx / TILE_SIZE);
      const ty = Math.floor(sy / TILE_SIZE);
      if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
      if (map.tiles[ty * map.widthTiles + tx] === T_RAMP) {
        onRamp = true;
        break;
      }
    }
    if (!onRamp) continue;

    p.vz = q8(Math.abs(v.speed) * RAMP_LAUNCH);
    p.z = q8(g + 1);
    p.airDist = 0;
    events.push({
      type: 'stuntLaunched',
      tick: state.tick,
      playerId: pid,
      x: Math.round(v.pos.x),
      y: Math.round(v.pos.y),
    });
  }
}

/**
 * Coming down a step is a step, not a fall.
 *
 * With the ground at height, the far side of a kerb, a ramp's edge and every
 * tile of a bridge deck on the way down is a few px lower than the one
 * before. Left to gravity that was a flight each time: three ticks in the
 * air with the wall collision switched off, a `stuntLanded` event and its
 * cash for every kerb, and an impact hard enough to dent the car on every
 * tile of a bridge's descent. A lip inside the step-up allowance, met with
 * no vertical speed and no flight behind it, is taken by putting the feet
 * (or the wheels) on the lower ground. A launched car has `vz` and then
 * `airDist`; a bail-out from a helicopter has the height. Neither is a step.
 *
 * Only where the ground HAS height: on a flat map the ground is zero, a
 * mover above it is in the air by definition, and this must not change what
 * that game does.
 */
function stepDown(map: CityMap, p: { z: number; vz: number; airDist: number }, g: number): void {
  if (!map.ground) return;
  if (p.vz !== 0 || p.airDist !== 0) return;
  if (p.z > g && p.z - g <= STEP_UP) p.z = g;
}

/**
 * True while this player's vehicle is off the ground — the ground UNDER it,
 * which on a map with heights is a kerb's height up on the pavement and a
 * roof's height up on a roof. Without the map, or on a flat one, zero.
 */
export function isAirborne(state: GameState, playerId: number, map?: CityMap): boolean {
  const p = state.players.byId[playerId];
  if (!p) return false;
  if (!map || !map.ground) return p.z > 0;
  const v = p.vehicleId !== null ? state.vehicles.byId[p.vehicleId] : undefined;
  const half = v ? getVehicleTuning(v.kind).halfExtent : PLAYER_RADIUS;
  const at = v ? v.pos : p.pos;
  return p.z > groundUnder(map, at.x, at.y, half);
}

/** Payout for a landed stunt, in cash. Scales with distance covered. */
export function stuntReward(distance: number): number {
  return Math.round(distance * 0.9);
}

/** Ticks a frenzy lasts, for UI countdowns. */
export function frenzyTicks(): number {
  return Math.round(getTuning().pickups.frenzySeconds * TICK_RATE);
}
