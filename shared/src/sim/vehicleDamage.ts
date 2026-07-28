import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { addHeat } from './state.js';
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

/**
 * Ignite a vehicle: it burns for a tuned fuse, then explodes.
 *
 * `attackerId` is who did it, or null when nobody did — an ambient shunt in
 * traffic is not arson, and charging for it would make every journey a crime.
 * It is remembered on the vehicle (`igniterId`) rather than used and dropped,
 * because the two things that need it happen later: the police price the
 * crime here, and the blast on the far side of the fuse has to be credited to
 * the arsonist rather than to whoever happened to be at the wheel.
 */
export function damageVehicle(
  state: GameState,
  v: VehicleState,
  amount: number,
  events: SimEvent[],
  attackerId: number | null = null,
): void {
  if (v.condition !== 'ok') return;
  v.health -= amount;
  if (v.health > 0) return;
  v.health = 0;
  v.condition = 'burning';
  v.igniterId = attackerId;
  v.fuseAtTick = state.tick + Math.round(getVehicleTuning(v.kind).burnSeconds * TICK_RATE);
  chargeForArson(state, v, attackerId);
  events.push({
    type: 'vehicleBurning',
    tick: state.tick,
    vehicleId: v.id,
    x: Math.round(v.pos.x),
    y: Math.round(v.pos.y),
  });
}

/**
 * What the police think of setting a car alight.
 *
 * Priced at ignition, not at detonation: this is the only moment the culprit
 * is known for certain, and it is also the moment a witness would react. An
 * occupied car costs more because the deaths that follow are yours — those
 * are charged separately by the blast, so this is only the arson itself.
 */
function chargeForArson(state: GameState, v: VehicleState, attackerId: number | null): void {
  if (attackerId === null) return;
  const arsonist = state.players.byId[attackerId];
  if (!arsonist) return;
  const t = getTuning().police;
  const occupied = v.driverId !== null && v.driverId !== attackerId;
  addHeat(arsonist, occupied ? t.heatPerOccupiedVehicleKill : t.heatPerVehicleKill);
}

/**
 * One explosion, anywhere, from anything.
 *
 * Extracted from `explode` so a rocket and a burning car detonate through
 * exactly the same code — same victim order (players, cops, peds, props,
 * then vehicles), same falloff, same one-event-then-damage sequence. Two
 * implementations of a blast would be two chances to disagree between hosts.
 *
 * Neighbouring vehicles are only *ignited*, never detonated inline: that is
 * what keeps a chain reaction a sequence of ticks instead of a recursion
 * whose depth both hosts would have to agree on.
 */
export function blast(
  state: GameState,
  cx: number,
  cy: number,
  radius: number,
  damage: number,
  attackerId: number,
  events: SimEvent[],
  exceptVehicleId: number | null = null,
): void {
  const r2 = radius * radius;
  const falloff = (dx: number, dy: number): number => {
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) return 0;
    return damage * (1 - Math.sqrt(d2) / radius);
  };

  events.push({
    type: 'explosion',
    tick: state.tick,
    x: Math.round(cx),
    y: Math.round(cy),
    radius: Math.round(radius),
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
    if (dmg > 0) damageProp(state, prop, dmg, events, attackerId);
  }
  for (const vid of state.vehicles.ids) {
    if (vid === exceptVehicleId) continue;
    const other = state.vehicles.byId[vid];
    if (!other || other.condition !== 'ok') continue;
    const dmg = falloff(other.pos.x - cx, other.pos.y - cy);
    // A blast that lights the next car along is still the first arsonist's
    // fire — that is what stops a chain reaction laundering the crime.
    if (dmg > 0) damageVehicle(state, other, dmg, events, attackerId >= 0 ? attackerId : null);
  }
}

function explode(state: GameState, v: VehicleState, events: SimEvent[]): void {
  const t = getVehicleTuning(v.kind);
  // Whoever lit it owns the deaths. Falling back to the driver reads well for
  // a crash — you drove it into a wall, the casualties are yours — but it is
  // exactly backwards for arson: torch a bus at a crowded stop and the driver
  // was being charged with the bodies while the arsonist walked away.
  blast(
    state,
    v.pos.x,
    v.pos.y,
    t.explosionRadius,
    t.explosionDamage,
    v.igniterId ?? v.driverId ?? -1,
    events,
    v.id,
  );

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
