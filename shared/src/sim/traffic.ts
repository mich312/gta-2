import { DT } from '../constants.js';
import { HALF_PI, PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { q256 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { integrateVehicle } from './vehicle.js';
import { T_ROAD, TILE_SIZE, tileAt, type CityMap } from '../world/types.js';
import { roadSpanAt } from '../world/roads.js';

/**
 * Ambient traffic: driverless cars that cruise the arterial roads. All of it
 * runs inside step() with the sim PRNG, so the same seed produces the same
 * traffic everywhere — replays, server, tests. Deliberately simple: cardinal
 * route intents (aiDir), a lane-keeping steer toward the right-hand lane,
 * braking for anything ahead, and a stuck-timeout that turns the car away.
 * Traffic never exceeds the prop-break / run-over / ped-scare speed
 * thresholds, so the city stays calm until a player makes it otherwise.
 */

const DIR_X = [1, 0, -1, 0] as const;
const DIR_Y = [0, 1, 0, -1] as const;
const DIR_ANGLE = [0, HALF_PI, PI, -HALF_PI] as const;
/** Sign of "positive lateral offset ⇒ steer toward larger angle" per dir. */
const LANE_SIGN = [1, -1, -1, 1] as const;

/**
 * Can a traffic car head in direction `d` through world point (x, y)?
 * True inside intersection boxes; on corridors the road must be arterial
 * (crossing width ≥ 3 tiles) and run long along the travel axis.
 */
export function trafficCanGo(map: CityMap, x: number, y: number, d: number): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tileAt(map, tx, ty) !== T_ROAD) return false;
  const h = roadSpanAt(map, tx, ty, true);
  const v = roadSpanAt(map, tx, ty, false);
  if (h.width > 6 && v.width > 6) return true; // intersection box: open
  const horizontal = d === 0 || d === 2;
  const along = horizontal ? h : v;
  const crossing = horizontal ? v : h;
  return along.width > 6 && crossing.width >= 3;
}

/** Centre of the right-hand lane for direction `d`, or null off-corridor. */
function laneTarget(map: CityMap, v: VehicleState, d: number): number | null {
  const tx = Math.floor(v.pos.x / TILE_SIZE);
  const ty = Math.floor(v.pos.y / TILE_SIZE);
  if (tileAt(map, tx, ty) !== T_ROAD) return null;
  const h = roadSpanAt(map, tx, ty, true);
  const vv = roadSpanAt(map, tx, ty, false);
  if (h.width > 6 && vv.width > 6) return null; // intersections: no lane pull
  if (d === 0 || d === 2) {
    if (vv.width < 3 || vv.width > 6) return null;
    const y0 = (ty - vv.before) * TILE_SIZE;
    const w = vv.width * TILE_SIZE;
    return y0 + (d === 0 ? (w * 2) / 3 : w / 3); // eastbound: south lane
  }
  if (h.width < 3 || h.width > 6) return null;
  const x0 = (tx - h.before) * TILE_SIZE;
  const w = h.width * TILE_SIZE;
  return x0 + (d === 1 ? w / 3 : (w * 2) / 3); // southbound: west lane
}

/** Is anything (player, ped, cop, car) in the braking corridor ahead? */
function obstacleAhead(state: GameState, v: VehicleState, brakeDist: number, laneHalf: number): boolean {
  const hx = dCos(v.heading);
  const hy = dSin(v.heading);
  const reach = brakeDist + getVehicleTuning(v.kind).halfExtent;
  const check = (x: number, y: number): boolean => {
    const dx = x - v.pos.x;
    const dy = y - v.pos.y;
    const forward = dx * hx + dy * hy;
    if (forward <= 0 || forward > reach) return false;
    const lateral = dx * hy - dy * hx;
    return Math.abs(lateral) < laneHalf;
  };
  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p || p.mode !== 'foot') continue;
    if (check(p.pos.x, p.pos.y)) return true;
  }
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (ped && check(ped.pos.x, ped.pos.y)) return true;
  }
  for (const id of state.cops.ids) {
    const cop = state.cops.byId[id];
    if (cop && check(cop.pos.x, cop.pos.y)) return true;
  }
  for (const id of state.vehicles.ids) {
    if (id === v.id) continue;
    const other = state.vehicles.byId[id];
    if (other && check(other.pos.x, other.pos.y)) return true;
  }
  return false;
}

/** Pick a new route direction: valid sides preferred, else turn back. */
function chooseNewDir(state: GameState, v: VehicleState, map: CityMap, probe: number): void {
  const sides: number[] = [];
  for (const d of [(v.aiDir + 1) & 3, (v.aiDir + 3) & 3]) {
    const px = v.pos.x + DIR_X[d]! * probe;
    const py = v.pos.y + DIR_Y[d]! * probe;
    if (trafficCanGo(map, px, py, d)) sides.push(d);
  }
  if (sides.length === 0) {
    v.aiDir = (v.aiDir + 2) & 3;
    return;
  }
  let pick: number;
  [pick, state.rng] = nextIntRange(state.rng, 0, sides.length);
  v.aiDir = sides[pick] as number;
}

/**
 * One decision-and-motion step for one ambient traffic car. Runs on the
 * staggered 3-tick NPC cadence (10 Hz with 3× steps, like peds and cops):
 * interpolation renders it smooth and delta traffic drops to a third.
 * Deterministic; server-side only — traffic is never predicted.
 */
export function stepTrafficVehicle(state: GameState, v: VehicleState, map: CityMap): void {
  const t = getTuning().traffic;
  const vt = getVehicleTuning(v.kind);
  const dtMul = 3;

  // Route: if the corridor ends ahead, turn; otherwise occasionally take an
  // intersection turn on a per-car cadence.
  const aheadX = v.pos.x + DIR_X[v.aiDir]! * t.lookAhead;
  const aheadY = v.pos.y + DIR_Y[v.aiDir]! * t.lookAhead;
  if (!trafficCanGo(map, aheadX, aheadY, v.aiDir)) {
    chooseNewDir(state, v, map, t.turnProbe);
  } else if ((state.tick + v.id) % t.decisionCadenceTicks === 0) {
    let roll: number;
    [roll, state.rng] = nextFloat01(state.rng);
    if (roll < t.turnChance) {
      const sides: number[] = [];
      for (const d of [(v.aiDir + 1) & 3, (v.aiDir + 3) & 3]) {
        const px = v.pos.x + DIR_X[d]! * t.turnProbe;
        const py = v.pos.y + DIR_Y[d]! * t.turnProbe;
        if (trafficCanGo(map, px, py, d)) sides.push(d);
      }
      if (sides.length > 0) {
        let pick: number;
        [pick, state.rng] = nextIntRange(state.rng, 0, sides.length);
        v.aiDir = sides[pick] as number;
      }
    }
  }

  // Speed: cruise, slow into turns, stop for obstacles.
  const brakeDist = t.brakeDistance + Math.abs(v.speed) * t.brakeDistancePerSpeed;
  const blocked = obstacleAhead(state, v, brakeDist, t.laneHalfWidth);
  let target = t.cruiseSpeed;
  const misalign = Math.abs(wrapAngle(DIR_ANGLE[v.aiDir]! - v.heading));
  if (misalign > 0.25) target = Math.min(target, t.turnSpeed);
  if (blocked) target = 0;
  if (v.speed < target) v.speed = Math.min(target, v.speed + vt.accel * DT * dtMul);
  else if (v.speed > target) v.speed = Math.max(target, v.speed - vt.brake * DT * dtMul);

  // Stuck behind something for too long: turn away and try another street.
  // The counter decays (rather than resets) when momentarily unblocked, so
  // the creep-brake oscillation at the braking boundary still accumulates.
  if (blocked && Math.abs(v.speed) < t.turnSpeed) {
    v.aiWait += dtMul;
    if (v.aiWait >= t.blockedTimeoutTicks) {
      chooseNewDir(state, v, map, t.turnProbe);
      v.aiWait = 0;
    }
  } else if (v.aiWait > 0) {
    v.aiWait = Math.max(0, v.aiWait - dtMul);
  }

  // Steering: face the route direction, pulled toward the right-hand lane.
  // Unlike player cars this steers even at rest — a blocked car must be able
  // to pivot toward its escape direction, or braking would deadlock it.
  {
    let want = DIR_ANGLE[v.aiDir]!;
    const lane = laneTarget(map, v, v.aiDir);
    if (lane !== null) {
      const lat = v.aiDir === 0 || v.aiDir === 2 ? v.pos.y : v.pos.x;
      const off = Math.max(-0.5, Math.min(0.5, (lane - lat) * t.laneKeepGain));
      want += LANE_SIGN[v.aiDir]! * off;
    }
    const diff = wrapAngle(want - v.heading);
    const maxTurn = vt.turnRate * DT * dtMul;
    v.heading = q256(wrapAngle(v.heading + Math.max(-maxTurn, Math.min(maxTurn, diff))));
  }

  integrateVehicle(v, map, state, dtMul);
}
