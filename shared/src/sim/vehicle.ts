import { DT, PLAYER_RADIUS } from '../constants.js';
import { HALF_PI, PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { approach, q8, q256 } from '../math/vec.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, PlayerState, VehicleState } from './state.js';
import { addHeat } from './state.js';
import type { InputIntent } from './input.js';
import type { CityMap } from '../world/types.js';
import { boxInSolid, isSolidForBoat, isSolidTile, moveWithCollision } from '../world/collide.js';

/**
 * Arcade vehicle physics: signed forward speed along a heading, steering
 * authority that grows with speed, hard friction when coasting. Deliberately
 * not rigid-body anything. Deterministic trig only — this runs in prediction.
 */

function overlapsOtherVehicle(
  state: GameState | null,
  self: VehicleState,
  half: number,
): boolean {
  if (!state) return false; // prediction ignores dynamic entities (plan §7)
  for (const id of state.vehicles.ids) {
    if (id === self.id) continue;
    const other = state.vehicles.byId[id];
    if (!other) continue;
    if (
      Math.abs(other.pos.x - self.pos.x) < half * 2 &&
      Math.abs(other.pos.y - self.pos.y) < half * 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Move a vehicle by its speed/heading, colliding with tiles and (server-side)
 * other cars. `dtMul` lets NPC traffic integrate on the staggered 3-tick
 * cadence (10 Hz, 3× step) like peds and cops; player cars always pass 1.
 */
export function integrateVehicle(
  v: VehicleState,
  map: CityMap,
  state: GameState | null,
  dtMul = 1,
): void {
  const t = getVehicleTuning(v.kind);
  if (v.speed === 0) return;
  const beforeX = v.pos.x;
  const beforeY = v.pos.y;
  const dx = dCos(v.heading) * v.speed * DT * dtMul;
  const dy = dSin(v.heading) * v.speed * DT * dtMul;
  const tmpVel = { x: dx, y: dy };
  const solid = t.medium === 'water' ? isSolidForBoat : isSolidTile;
  moveWithCollision(map, v.pos, tmpVel, t.halfExtent, dx, dy, solid);
  const hitWall = (dx !== 0 && tmpVel.x === 0) || (dy !== 0 && tmpVel.y === 0);
  if (hitWall) {
    v.speed = -v.speed * t.crashDamp; // crunch + slight rebound
    if (Math.abs(v.speed) < 10) v.speed = 0;
  }
  if (overlapsOtherVehicle(state, v, t.halfExtent)) {
    v.pos.x = beforeX;
    v.pos.y = beforeY;
    v.speed = 0;
  }
  v.pos.x = q8(v.pos.x);
  v.pos.y = q8(v.pos.y);
  v.speed = q8(v.speed);
}

/** One tick of driver-controlled vehicle. */
export function stepVehicleDriving(
  v: VehicleState,
  input: InputIntent | undefined,
  map: CityMap,
  state: GameState | null,
): void {
  const t = getVehicleTuning(v.kind);
  const throttle = input ? (input.up ? 1 : 0) - (input.down ? 1 : 0) : 0;
  const steer = input ? (input.right ? 1 : 0) - (input.left ? 1 : 0) : 0;

  if (throttle > 0) {
    v.speed = Math.min(t.maxSpeed, v.speed + t.accel * DT);
  } else if (throttle < 0) {
    v.speed =
      v.speed > 0
        ? Math.max(0, v.speed - t.brake * DT)
        : Math.max(-t.maxReverseSpeed, v.speed - t.reverseAccel * DT);
  } else {
    v.speed = approach(v.speed, 0, t.friction * DT);
  }

  if (steer !== 0 && v.speed !== 0) {
    const authority = Math.min(1, Math.abs(v.speed) / (t.maxSpeed * t.minSteerSpeedFrac));
    const dir = v.speed >= 0 ? 1 : -1; // reversing inverts steering, like a car
    v.heading = q256(wrapAngle(v.heading + steer * dir * t.turnRate * authority * DT));
  }

  integrateVehicle(v, map, state);
}

/** Driverless vehicles coast to a stop. */
export function stepVehicleCoasting(v: VehicleState, map: CityMap, state: GameState | null): void {
  const t = getVehicleTuning(v.kind);
  v.speed = approach(v.speed, 0, t.friction * DT);
  integrateVehicle(v, map, state);
}

const MAX_BOARDING_SPEED = 40;

/** Try to put a player into the nearest free, near-stationary vehicle. */
export function tryEnterVehicle(state: GameState, p: PlayerState, map: CityMap): boolean {
  void map;
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.driverId !== null) continue;
    if (Math.abs(v.speed) > MAX_BOARDING_SPEED) continue;
    const t = getVehicleTuning(v.kind);
    const dx = v.pos.x - p.pos.x;
    const dy = v.pos.y - p.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= t.enterRadius && d < bestD) {
      best = v;
      bestD = d;
    }
  }
  if (!best) return false;
  addHeat(p, getTuning().police.heatPerTheft); // grand theft auto, witnessed or not
  best.ai = 0; // a jacked traffic car is a normal car forever after
  best.aiWait = 0;
  best.driverId = p.id;
  p.mode = 'driving';
  p.vehicleId = best.id;
  p.vel.x = 0;
  p.vel.y = 0;
  p.pos.x = best.pos.x;
  p.pos.y = best.pos.y;
  return true;
}

/**
 * Try to exit: first free spot beside (then behind, then over the bow) wins.
 * The bow spot exists for boats nosed onto a beach — sides and stern are
 * water there, and water is solid ground-movement terrain.
 */
export function tryExitVehicle(state: GameState, p: PlayerState, map: CityMap): boolean {
  if (p.vehicleId === null) return false;
  const v = state.vehicles.byId[p.vehicleId];
  if (!v) return false;
  const t = getVehicleTuning(v.kind);
  const side = t.halfExtent + PLAYER_RADIUS + 3;
  const candidates: Array<[number, number]> = [
    [dCos(v.heading + HALF_PI) * side, dSin(v.heading + HALF_PI) * side],
    [dCos(v.heading - HALF_PI) * side, dSin(v.heading - HALF_PI) * side],
    [dCos(v.heading + PI) * (side + 8), dSin(v.heading + PI) * (side + 8)],
    [dCos(v.heading) * (side + 8), dSin(v.heading) * (side + 8)],
  ];
  for (const [ox, oy] of candidates) {
    const spot = { x: v.pos.x + ox, y: v.pos.y + oy };
    if (!boxInSolid(map, spot, PLAYER_RADIUS)) {
      v.driverId = null;
      p.mode = 'foot';
      p.vehicleId = null;
      p.pos = spot;
      p.vel.x = 0;
      p.vel.y = 0;
      return true;
    }
  }
  return false; // boxed in — stay in the car
}
