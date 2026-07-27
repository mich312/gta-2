import { DT, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { dCos, dSin } from '../math/trig.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState } from './state.js';
import type { SimEvent } from './events.js';
import { T_RAMP, TILE_SIZE, type CityMap } from '../world/types.js';

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

    // Only a driver can be airborne; anyone on foot is pinned to the ground.
    if (p.mode !== 'driving' || p.vehicleId === null) {
      if (p.z !== 0 || p.vz !== 0) {
        p.z = 0;
        p.vz = 0;
        p.airDist = 0;
      }
      continue;
    }
    const v = state.vehicles.byId[p.vehicleId];
    if (!v) continue;

    if (p.z > 0 || p.vz > 0) {
      // In the air: integrate, accumulate distance, and land.
      p.vz = q8(p.vz - GRAVITY * DT);
      p.z = q8(p.z + p.vz * DT);
      p.airDist = q8(p.airDist + Math.abs(v.speed) * DT);
      if (p.z <= 0) {
        const dist = p.airDist;
        p.z = 0;
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
    p.z = q8(1);
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

/** True while this player's vehicle is off the ground. */
export function isAirborne(state: GameState, playerId: number): boolean {
  const p = state.players.byId[playerId];
  return !!p && p.z > 0;
}

/** Payout for a landed stunt, in cash. Scales with distance covered. */
export function stuntReward(distance: number): number {
  return Math.round(distance * 0.9);
}

/** Ticks a frenzy lasts, for UI countdowns. */
export function frenzyTicks(): number {
  return Math.round(getTuning().pickups.frenzySeconds * TICK_RATE);
}
