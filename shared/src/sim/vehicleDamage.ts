import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import { applyDamage, damageCop, damageProp } from './weapons.js';
import { damagePed } from './peds.js';

/**
 * Vehicle destruction.
 *
 * Before this, `VehicleState` had no health field at all: nothing in a game
 * about driving could destroy a car. A car now takes damage from bullets,
 * collisions and blasts, catches fire, and detonates on a fuse — which is
 * what makes a packed car park interesting.
 *
 * Determinism is the whole risk here, because explosions damage vehicles and
 * damaged vehicles explode. Two rules contain it:
 *
 *  1. Exactly ONE explosion pass per tick. A blast that ignites a neighbour
 *     sets that neighbour's fuse; it does not detonate it inline. Chains
 *     therefore propagate one link per fuse, not recursively inside a single
 *     tick, and cannot depend on how deep the recursion happened to go.
 *  2. The detonation list is collected in sorted-id order and frozen before
 *     any damage is applied. Otherwise the iteration order would decide the
 *     outcome and two hosts could legitimately disagree.
 */

/** Ignite a vehicle: it burns for a tuned fuse, then explodes. */
export function damageVehicle(
  state: GameState,
  v: VehicleState,
  amount: number,
  events: SimEvent[],
): void {
  if (v.condition !== 'ok') return;
  v.health -= amount;
  if (v.health > 0) return;
  v.health = 0;
  v.condition = 'burning';
  v.fuseAtTick = state.tick + Math.round(getVehicleTuning(v.kind).burnSeconds * TICK_RATE);
  events.push({
    type: 'vehicleBurning',
    tick: state.tick,
    vehicleId: v.id,
    x: Math.round(v.pos.x),
    y: Math.round(v.pos.y),
  });
}

function explode(state: GameState, v: VehicleState, events: SimEvent[]): void {
  const t = getVehicleTuning(v.kind);
  const r = t.explosionRadius;
  const r2 = r * r;
  const cx = v.pos.x;
  const cy = v.pos.y;
  // The driver goes with it, and whoever was at the wheel owns the deaths.
  const attackerId = v.driverId ?? -1;

  const falloff = (dx: number, dy: number): number => {
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) return 0;
    return t.explosionDamage * (1 - Math.sqrt(d2) / r);
  };

  events.push({
    type: 'explosion',
    tick: state.tick,
    x: Math.round(cx),
    y: Math.round(cy),
    radius: Math.round(r),
  });

  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode === 'dead') continue;
    const dmg = falloff(p.pos.x - cx, p.pos.y - cy);
    if (dmg > 0) applyDamage(state, p, dmg, attackerId, 'explosion', events);
  }
  for (const cid of [...state.cops.ids]) {
    const c = state.cops.byId[cid];
    if (!c) continue;
    const dmg = falloff(c.pos.x - cx, c.pos.y - cy);
    if (dmg > 0) damageCop(state, c, dmg, attackerId, events);
  }
  for (const pedId of [...state.peds.ids]) {
    const ped = state.peds.byId[pedId];
    if (!ped) continue;
    const dmg = falloff(ped.pos.x - cx, ped.pos.y - cy);
    if (dmg > 0) damagePed(state, ped, dmg, attackerId, events);
  }
  for (const propId of state.props.ids) {
    const prop = state.props.byId[propId];
    if (!prop || !prop.intact) continue;
    const dmg = falloff(prop.pos.x - cx, prop.pos.y - cy);
    if (dmg > 0) damageProp(state, prop, dmg, events);
  }
  // Neighbours are only *ignited*, never detonated inline — that is what
  // keeps a chain reaction a sequence of ticks instead of a recursion whose
  // depth both hosts would have to agree on.
  for (const vid of state.vehicles.ids) {
    if (vid === v.id) continue;
    const other = state.vehicles.byId[vid];
    if (!other || other.condition !== 'ok') continue;
    const dmg = falloff(other.pos.x - cx, other.pos.y - cy);
    if (dmg > 0) damageVehicle(state, other, dmg, events);
  }

  v.condition = 'wreck';
  v.speed = 0;
  v.health = 0;
  v.fuseAtTick = state.tick + Math.round(t.wreckSeconds * TICK_RATE);
  // Anyone still at the wheel is now on foot, dead or otherwise.
  if (v.driverId !== null) {
    const driver = state.players.byId[v.driverId];
    if (driver && driver.vehicleId === v.id) {
      driver.vehicleId = null;
      if (driver.mode === 'driving') driver.mode = 'foot';
    }
    v.driverId = null;
  }
}

/** Burn-down, detonation and wreck clearing. One pass, fixed order. */
export function stepVehicleDamage(state: GameState, events: SimEvent[]): void {
  // Frozen before any damage lands: explosions ignite other vehicles, and a
  // list built while that happens would depend on iteration order.
  const detonating: number[] = [];
  const clearing: number[] = [];
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.fuseAtTick === null || state.tick < v.fuseAtTick) continue;
    if (v.condition === 'burning') detonating.push(id);
    else if (v.condition === 'wreck') clearing.push(id);
  }

  for (const id of detonating) {
    const v = state.vehicles.byId[id];
    if (v && v.condition === 'burning') explode(state, v, events);
  }

  const minDist2 = 260 * 260;
  for (const id of clearing) {
    const v = state.vehicles.byId[id];
    if (!v) continue;
    // Same courtesy as props: a wreck does not blink out under your nose.
    let watched = false;
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p || p.mode === 'dead') continue;
      const dx = p.pos.x - v.pos.x;
      const dy = p.pos.y - v.pos.y;
      if (dx * dx + dy * dy < minDist2) {
        watched = true;
        break;
      }
    }
    if (watched) continue;
    removeEntity(state.vehicles, id);
  }
}

/** Bullets hit cars too. Radius is the collision box, near enough. */
export function vehicleHitRadius(v: VehicleState): number {
  return getVehicleTuning(v.kind).halfExtent + PLAYER_RADIUS * 0.5;
}

/** Speed-scaled damage from a collision, shared by both parties. */
export function collisionDamage(kind: string, closingSpeed: number): number {
  return Math.abs(closingSpeed) * getVehicleTuning(kind).collisionDamagePerSpeed;
}

export function propsTuning(): ReturnType<typeof getTuning>['props'] {
  return getTuning().props;
}
