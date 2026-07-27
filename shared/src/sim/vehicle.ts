import { DT, PLAYER_RADIUS } from '../constants.js';
import { HALF_PI, PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { approach, q8, q256 } from '../math/vec.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, PlayerState, VehicleState } from './state.js';
import { addHeat } from './state.js';
import type { InputIntent } from './input.js';
import type { CityMap } from '../world/types.js';
import { boxInSolid, moveWithCollision } from '../world/collide.js';
import type { SimEvent } from './events.js';
import { collisionDamage, damageVehicle } from './vehicleDamage.js';
import { anyCopSees } from './police.js';

/**
 * Arcade vehicle physics: signed forward speed along a heading, steering
 * authority that grows with speed, hard friction when coasting. Deliberately
 * not rigid-body anything. Deterministic trig only — this runs in prediction.
 */

function overlappingVehicle(
  state: GameState | null,
  self: VehicleState,
  half: number,
): VehicleState | null {
  if (!state) return null; // prediction ignores dynamic entities (plan §7)
  for (const id of state.vehicles.ids) {
    if (id === self.id) continue;
    const other = state.vehicles.byId[id];
    if (!other) continue;
    if (
      Math.abs(other.pos.x - self.pos.x) < half * 2 &&
      Math.abs(other.pos.y - self.pos.y) < half * 2
    ) {
      return other;
    }
  }
  return null;
}

/** Move a vehicle by its speed/heading, colliding with tiles and (server-side) other cars. */
function integrateVehicle(
  v: VehicleState,
  map: CityMap,
  state: GameState | null,
  events?: SimEvent[],
): void {
  const t = getVehicleTuning(v.kind);
  if (v.speed === 0) return;
  const beforeX = v.pos.x;
  const beforeY = v.pos.y;
  const dx = dCos(v.heading) * v.speed * DT;
  const dy = dSin(v.heading) * v.speed * DT;
  const tmpVel = { x: dx, y: dy };
  moveWithCollision(map, v.pos, tmpVel, t.halfExtent, dx, dy, t.medium);
  const hitWall = (dx !== 0 && tmpVel.x === 0) || (dy !== 0 && tmpVel.y === 0);
  if (hitWall) {
    const closing = Math.abs(v.speed);
    v.speed = -v.speed * t.crashDamp; // crunch + slight rebound
    if (Math.abs(v.speed) < 10) v.speed = 0;
    if (state && closing > 90) {
      damageVehicle(state, v, collisionDamage(v.kind, closing) * 0.7, events ?? []);
    }
  }
  const hit = overlappingVehicle(state, v, t.halfExtent);
  if (hit && state) {
    // Momentum transfer, not a brick wall. The old behaviour reverted the
    // position and zeroed the speed, so a parked car stopped a 330 px/s
    // impact dead — you could not shunt, nudge or plough anything.
    v.pos.x = beforeX;
    v.pos.y = beforeY;
    const closing = Math.abs(v.speed);
    const shove = v.speed * 0.55;
    // The struck car is pushed along the striker's heading; the striker keeps
    // a little of its momentum rather than stopping.
    if (hit.condition !== 'wreck' && Math.abs(shove) > Math.abs(hit.speed)) {
      hit.heading = v.heading;
      hit.speed = q8(shove);
    }
    v.speed = q8(-v.speed * t.crashDamp);
    if (Math.abs(v.speed) < 10) v.speed = 0;
    if (closing > 60) {
      damageVehicle(state, v, collisionDamage(v.kind, closing), events ?? []);
      damageVehicle(state, hit, collisionDamage(hit.kind, closing), events ?? []);
    }
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
  events?: SimEvent[],
): void {
  const t = getVehicleTuning(v.kind);
  // A wreck is scenery: it does not respond to the pedals.
  if (v.condition === 'wreck') {
    v.speed = 0;
    return;
  }
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

  integrateVehicle(v, map, state, events);
}

/** Driverless vehicles coast to a stop. */
export function stepVehicleCoasting(
  v: VehicleState,
  map: CityMap,
  state: GameState | null,
  events?: SimEvent[],
): void {
  const t = getVehicleTuning(v.kind);
  v.speed = approach(v.speed, 0, t.friction * DT);
  integrateVehicle(v, map, state, events);
}

const MAX_BOARDING_SPEED = 40;

/** Try to put a player into the nearest free, near-stationary vehicle. */
export function tryEnterVehicle(state: GameState, p: PlayerState, map: CityMap): boolean {
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.driverId !== null) continue;
    if (v.condition === 'wreck') continue; // scenery, not transport
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
  // Lifting an empty parked car is only a crime if someone official is
  // watching. Taking an *occupied* one is always a crime — that path arrives
  // with NPC drivers (roadmap C2), where the jack becomes an explicit action.
  if (anyCopSees(state, map, p)) {
    addHeat(p, getTuning().police.heatPerTheft);
  }
  best.driverId = p.id;
  p.mode = 'driving';
  p.vehicleId = best.id;
  p.vel.x = 0;
  p.vel.y = 0;
  p.pos.x = best.pos.x;
  p.pos.y = best.pos.y;
  return true;
}

/** Try to exit: first free spot beside (then behind) the car wins. */
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
  ];
  for (const [ox, oy] of candidates) {
    const spot = { x: v.pos.x + ox, y: v.pos.y + oy };
    // Land check regardless of the vehicle's medium: stepping off a boat
    // has to put you on a bank, not into the river.
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
