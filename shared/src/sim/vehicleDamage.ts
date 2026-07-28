import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { dCos, dSin } from '../math/trig.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { addHeat } from './state.js';
import { removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import { applyDamage, damageCop, damageProp } from './weapons.js';
import { damagePed } from './peds.js';

/**
 * Vehicle destruction, and the damage map underneath it.
 *
 * `health` says how close a car is to burning. On its own that was the whole
 * model, and it could express exactly two visible states — some dents, and
 * darker paint — arriving in batches at fixed thresholds in places hashed off
 * the vehicle id rather than where you were hit. You could reverse into a wall
 * and watch a dent appear on the bonnet.
 *
 * `zones` says WHERE the car has been hit: four accumulators, front / right /
 * rear / left, quadrants split at 45°. Every legible thing about a damaged car
 * derives from them — which lamp shattered, which door is hanging off, which
 * corner is crumpled, which way it pulls, whether it is smoking. Components
 * break on a ladder of thresholds expressed as fractions of the vehicle's own
 * health, so a bus's headlight takes proportionally more to put out than a
 * hatchback's.
 *
 * Determinism is the whole risk here, because explosions damage vehicles and
 * damaged vehicles explode. Three rules contain it:
 *
 *  1. Exactly ONE explosion pass per tick. A blast that ignites a neighbour
 *     sets that neighbour's fuse; it does not detonate it inline. Chains
 *     therefore propagate one link per fuse, not recursively inside a single
 *     tick, and cannot depend on how deep the recursion happened to go.
 *  2. The detonation list is collected in sorted-id order and frozen before
 *     any damage is applied. Otherwise the iteration order would decide the
 *     outcome and two hosts could legitimately disagree.
 *  3. Zones are integers, thresholds are integers, and the quadrant test is
 *     comparisons on products — no atan2, no rng, nothing that can round
 *     differently on another engine. Breakage is a pure function of
 *     (zones, health), so it re-derives identically everywhere.
 */

/** Body zones, in `VehicleState.zones` order. */
export const ZONE_FRONT = 0;
export const ZONE_RIGHT = 1;
export const ZONE_REAR = 2;
export const ZONE_LEFT = 3;

/** Breakable components, one bit each in `VehicleState.broken`. */
export const PART_HEADLIGHT_L = 1 << 0;
export const PART_HEADLIGHT_R = 1 << 1;
export const PART_TAILLIGHT_L = 1 << 2;
export const PART_TAILLIGHT_R = 1 << 3;
export const PART_WINDSCREEN = 1 << 4;
export const PART_BONNET = 1 << 5;
export const PART_BOOT = 1 << 6;
export const PART_RADIATOR = 1 << 7;
export const PART_TYRE_FL = 1 << 8;
export const PART_TYRE_FR = 1 << 9;
export const PART_TYRE_RL = 1 << 10;
export const PART_TYRE_RR = 1 << 11;
export const PART_DOOR_L = 1 << 12;
export const PART_DOOR_R = 1 << 13;
export const PART_BUMPER_F = 1 << 14;
export const PART_BUMPER_R = 1 << 15;

export const PART_TYRES =
  PART_TYRE_FL | PART_TYRE_FR | PART_TYRE_RL | PART_TYRE_RR;
/** Everything a rebuild has to put right; the rest is panel-beating. */
export const PARTS_MECHANICAL = PART_RADIATOR | PART_TYRES;
export const PARTS_ALL = 0xffff;

/**
 * The breakage ladder: what comes off a given zone, and at what fraction of
 * the vehicle's own health.
 *
 * The two lamps on an end break at DIFFERENT thresholds on purpose. Lights
 * going one at a time is the most legible damage cue the genre has, and a car
 * coming the other way on one headlight says more about what has happened to
 * it than any amount of dent geometry. It costs one bit and one comparison.
 */
const LADDER: Array<{ zone: number; at: number; part: number }> = [
  { zone: ZONE_FRONT, at: 0.04, part: PART_BUMPER_F },
  { zone: ZONE_FRONT, at: 0.07, part: PART_HEADLIGHT_L },
  { zone: ZONE_FRONT, at: 0.11, part: PART_HEADLIGHT_R },
  { zone: ZONE_FRONT, at: 0.18, part: PART_BONNET },
  { zone: ZONE_FRONT, at: 0.24, part: PART_WINDSCREEN },
  { zone: ZONE_FRONT, at: 0.32, part: PART_RADIATOR },
  { zone: ZONE_REAR, at: 0.04, part: PART_BUMPER_R },
  { zone: ZONE_REAR, at: 0.07, part: PART_TAILLIGHT_L },
  { zone: ZONE_REAR, at: 0.11, part: PART_TAILLIGHT_R },
  { zone: ZONE_REAR, at: 0.18, part: PART_BOOT },
  { zone: ZONE_RIGHT, at: 0.22, part: PART_DOOR_R },
  { zone: ZONE_LEFT, at: 0.22, part: PART_DOOR_L },
];

/** Wheel positions in body-local coordinates; +x forward, +y to the right. */
const WHEELS: Array<{ lx: number; ly: number; part: number }> = [
  { lx: 8, ly: -5, part: PART_TYRE_FL },
  { lx: 8, ly: 5, part: PART_TYRE_FR },
  { lx: -8, ly: -5, part: PART_TYRE_RL },
  { lx: -8, ly: 5, part: PART_TYRE_RR },
];

/** How close a hit has to land to a wheel to put the tyre out, px. */
const WHEEL_HIT_RADIUS = 6;

/** A vehicle's body-local coordinates for a world point. +x forward, +y right. */
export function localOf(v: VehicleState, x: number, y: number): { lx: number; ly: number } {
  const dx = x - v.pos.x;
  const dy = y - v.pos.y;
  const c = dCos(v.heading);
  const s = dSin(v.heading);
  return { lx: dx * c + dy * s, ly: -dx * s + dy * c };
}

/**
 * Which quadrant a hit landed in.
 *
 * Comparing |lx| against |ly| is the 45° split, and it is nothing but
 * multiplications and an absolute value — cheaper and tighter than an atan2,
 * and with no approximation error to disagree about near a boundary.
 */
export function zoneOfLocal(lx: number, ly: number): number {
  const ax = lx < 0 ? -lx : lx;
  const ay = ly < 0 ? -ly : ly;
  if (ax >= ay) return lx >= 0 ? ZONE_FRONT : ZONE_REAR;
  return ly >= 0 ? ZONE_RIGHT : ZONE_LEFT;
}

/** How wrecked a car is, 0 (showroom) to 1. Kept here beside the ladder. */
function wearOf(v: VehicleState): number {
  const max = getVehicleTuning(v.kind).health;
  if (max <= 0) return 0;
  const wear = (max - v.health) / max;
  return wear < 0 ? 0 : wear > 1 ? 1 : wear;
}

/**
 * Re-derive which components are broken from the damage map.
 *
 * A pure function of (zones, health, kind), which is why it needs no event of
 * its own to stay in step — but it emits one anyway, so the client can put a
 * glass tinkle on the frame the lamp actually goes rather than noticing on the
 * next redraw.
 */
function evaluateBreakage(state: GameState, v: VehicleState, events: SimEvent[]): void {
  const max = getVehicleTuning(v.kind).health;
  for (const rung of LADDER) {
    if ((v.broken & rung.part) !== 0) continue;
    if ((v.zones[rung.zone] as number) < rung.at * max) continue;
    v.broken |= rung.part;
    events.push({
      type: 'vehiclePartBroke',
      tick: state.tick,
      vehicleId: v.id,
      part: rung.part,
      x: Math.round(v.pos.x),
      y: Math.round(v.pos.y),
    });
  }
}

/** Put a tyre out, if this is a tyre-shaped hit. */
function breakTyre(state: GameState, v: VehicleState, part: number, events: SimEvent[]): void {
  if ((v.broken & part) !== 0) return;
  v.broken |= part;
  events.push({
    type: 'vehiclePartBroke',
    tick: state.tick,
    vehicleId: v.id,
    part,
    x: Math.round(v.pos.x),
    y: Math.round(v.pos.y),
  });
}

/**
 * A kerb taken hard enough to burst the tyre nearest the contact.
 *
 * Separate from the proximity test in `damageVehicle` because a wall contact
 * point sits on the middle of a face, which is close to BOTH wheels on that
 * end — a head-on prang that always flattened two tyres would read as a bug.
 * One tyre, the nearest, is the thing that actually happens.
 */
export function kerbStrike(
  state: GameState,
  v: VehicleState,
  x: number,
  y: number,
  events: SimEvent[],
): void {
  if (v.condition !== 'ok') return;
  const { lx, ly } = localOf(v, x, y);
  let best = WHEELS[0] as { lx: number; ly: number; part: number };
  let bestD = Infinity;
  for (const wheel of WHEELS) {
    const dx = lx - wheel.lx;
    const dy = ly - wheel.ly;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = wheel;
    }
  }
  breakTyre(state, v, best.part, events);
}

/**
 * Ignite a vehicle: it burns for a tuned fuse, then explodes.
 *
 * `impact` is where the damage landed, in world coordinates. Everything that
 * can hurt a car knows this — a bullet has a hit point, a blast has a centre,
 * a collision has a contact point — and passing it is what turns a health
 * subtraction into damage you can see.
 *
 * `attackerId` is who did it, or null when nobody did — an ambient shunt in
 * traffic is not arson, and charging for it would make every journey a crime.
 * It is remembered on the vehicle (`igniterId`) rather than used and dropped,
 * because the two things that need it happen later: the police price the
 * crime here, and the blast on the far side of the fuse has to be credited to
 * the arsonist rather than to whoever happened to be at the wheel.
 *
 * The two are independent on purpose: WHERE a car was hit and WHO hit it
 * answer different questions, and plenty of damage knows one without the
 * other. A kerb knows the corner and nobody to blame; a bomb under the floor
 * knows the arsonist and no corner at all.
 */
export function damageVehicle(
  state: GameState,
  v: VehicleState,
  amount: number,
  events: SimEvent[],
  attackerId: number | null = null,
  impactX?: number,
  impactY?: number,
): void {
  if (v.condition !== 'ok') return;
  if (amount <= 0) return;

  // Whole numbers throughout: the ladder is a set of integer thresholds, and a
  // fractional health would let a lamp flicker on and off across a boundary.
  const dealt = Math.round(amount);
  if (dealt <= 0) return;

  if (impactX !== undefined && impactY !== undefined) {
    const { lx, ly } = localOf(v, impactX, impactY);
    const zone = zoneOfLocal(lx, ly);
    const at = (v.zones[zone] as number) + dealt;
    v.zones[zone] = at > 255 ? 255 : at;
    // A hit that lands on a wheel puts the tyre out regardless of how much
    // bodywork that corner has taken. This is what makes shooting the tyres
    // out a thing you can do on purpose.
    for (const wheel of WHEELS) {
      const dx = lx - wheel.lx;
      const dy = ly - wheel.ly;
      if (dx * dx + dy * dy <= WHEEL_HIT_RADIUS * WHEEL_HIT_RADIUS) {
        breakTyre(state, v, wheel.part, events);
      }
    }
  } else {
    // No impact point — a car bomb under the middle of it. Spread evenly.
    const share = Math.round(dealt / 4);
    for (let z = 0; z < 4; z++) {
      const at = (v.zones[z] as number) + share;
      v.zones[z] = at > 255 ? 255 : at;
    }
  }

  v.health = Math.round(v.health - dealt);
  evaluateBreakage(state, v, events);
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
    // fire — that is what stops a chain reaction laundering the crime. And the
    // blast centre IS the impact point: a bomb going off by your near-side
    // front wing takes the near-side front wing off.
    if (dmg > 0) {
      damageVehicle(state, other, dmg, events, attackerId >= 0 ? attackerId : null, cx, cy);
    }
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
  // A burnt-out shell has no glass, no lamps, no bumpers and four flat tyres.
  // Without this the wreck drew as an intact car in shadow, which read as a
  // car somebody had parked out of the sun.
  v.broken = PARTS_ALL;
  v.zones = [255, 255, 255, 255];
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

/**
 * Fire travelling from a burning car to what is parked beside it.
 *
 * The blast at the end of the fuse already ignites neighbours; what did not
 * happen before this was fire spreading BEFORE the explosion, so a burning
 * car in a packed street was a countdown rather than a developing situation.
 *
 * No rng: the nearest eligible neighbour wins, ties broken by ascending id,
 * evaluated in ascending burning-vehicle id, collected then applied. Three
 * brakes stop it running away, because spread is exponential by nature and
 * this map has car parks — a budget of one ignition per car, a city-wide
 * ceiling on simultaneous fires, and the reach itself.
 *
 * Attribution carries: the neighbour inherits the original arsonist from K1,
 * so a fire you start is a fire you are wanted for however far it travels.
 * That is why this item depends on K1 rather than merely following it.
 */
function stepFireSpread(state: GameState, events: SimEvent[]): void {
  const t = getTuning().fire;
  if (t.spreadBudget <= 0 || t.maxConcurrent <= 0) return;

  let burning = 0;
  const sources: VehicleState[] = [];
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.condition !== 'burning') continue;
    burning++;
    if (v.spreadUsed >= t.spreadBudget) continue;
    // Staggered by id so the whole street does not try to spread on one tick.
    if ((state.tick + id) % t.spreadIntervalTicks !== 0) continue;
    sources.push(v);
  }
  if (sources.length === 0 || burning >= t.maxConcurrent) return;

  const r2 = t.spreadRadius * t.spreadRadius;
  const lighting: Array<{ from: VehicleState; to: number }> = [];
  for (const src of sources) {
    if (burning + lighting.length >= t.maxConcurrent) break;
    let best: number | null = null;
    let bestD2 = r2;
    for (const id of state.vehicles.ids) {
      const other = state.vehicles.byId[id];
      if (!other || other.id === src.id || other.condition !== 'ok') continue;
      if (lighting.some((l) => l.to === id)) continue;
      const dx = other.pos.x - src.pos.x;
      const dy = other.pos.y - src.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = id;
      }
    }
    if (best !== null) lighting.push({ from: src, to: best });
  }

  for (const l of lighting) {
    const victim = state.vehicles.byId[l.to];
    if (!victim || victim.condition !== 'ok') continue;
    l.from.spreadUsed++;
    // Straight to burning rather than through damageVehicle: fire does not
    // shoot a car, it sets it alight, and routing through the damage path
    // would charge the arsonist a second time for the same crime.
    victim.condition = 'burning';
    victim.health = 0;
    victim.igniterId = l.from.igniterId;
    victim.fuseAtTick =
      state.tick + Math.round(getVehicleTuning(victim.kind).burnSeconds * TICK_RATE);
    events.push({
      type: 'vehicleBurning',
      tick: state.tick,
      vehicleId: victim.id,
      x: Math.round(victim.pos.x),
      y: Math.round(victim.pos.y),
    });
  }
}

/** Burn-down, detonation and wreck clearing. One pass, fixed order. */
export function stepVehicleDamage(state: GameState, events: SimEvent[]): void {
  stepFireSpread(state, events);

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
    delete state.vehicleHitTick[id];
  }
}

/**
 * Bullets hit cars too. A circle, not the body box.
 *
 * Deliberately still a circle, and worth saying why now that everything a car
 * BUMPS into uses its real oriented box (see bodies.ts). This radius feeds
 * ray casts, blast falloff and mine drop clearance, all of which are tuned
 * around it, and a car is a target you shoot at rather than a shape you have
 * to fit past — being a little generous at the flanks reads as a car being
 * easy to hit rather than as a collider in the wrong place. Swapping it for a
 * ray-versus-box test is a weapons change, not a collider fix, and belongs
 * with the tuning pass that would have to follow it.
 */
export function vehicleHitRadius(v: VehicleState): number {
  return getVehicleTuning(v.kind).halfExtent + PLAYER_RADIUS * 0.5;
}

/**
 * Damage a vehicle of this kind DEALS at this closing speed.
 *
 * It used to be read as damage *received*, which had the coefficient — larger
 * for heavier vehicles — hurting the bus rather than the car that hit it. The
 * receiver now divides by its own mass, so a truck hands out what its weight
 * suggests and soaks what its weight suggests.
 */
export function collisionDamage(kind: string, closingSpeed: number): number {
  return Math.abs(closingSpeed) * getVehicleTuning(kind).collisionDamagePerSpeed;
}

/** Top speed a car can still reach, as a fraction, given what is broken. */
export function partsSpeedFactor(v: VehicleState): number {
  let f = 1;
  if ((v.broken & PART_RADIATOR) !== 0) f *= 0.85;
  // Multiplied one flat at a time rather than raised to a power: repeated
  // multiplication is exact under IEEE-754, Math.pow is not pinned.
  for (const part of [PART_TYRE_FL, PART_TYRE_FR, PART_TYRE_RL, PART_TYRE_RR]) {
    if ((v.broken & part) !== 0) f *= 0.88;
  }
  return f;
}

/**
 * How hard a damaged car pulls, as a fraction of full lock. Negative is left.
 *
 * This replaces a sign taken from the vehicle id, which the old comment
 * admitted was a stand-in: a car that wandered left and then right would read
 * as ice rather than as damage, so the id was used to keep it constant. A flat
 * near-side front tyre is the honest reason a car pulls left, and a wing
 * folded into the arch on one side is the honest reason it pulls the other.
 */
export function partsSteerPull(v: VehicleState): number {
  let pull = 0;
  if ((v.broken & PART_TYRE_FL) !== 0) pull -= 0.18;
  if ((v.broken & PART_TYRE_FR) !== 0) pull += 0.18;
  if ((v.broken & PART_TYRE_RL) !== 0) pull -= 0.12;
  if ((v.broken & PART_TYRE_RR) !== 0) pull += 0.12;
  // ...plus whatever the bodywork is doing. A car bent down the left side
  // drags that way.
  const max = getVehicleTuning(v.kind).health;
  if (max > 0) {
    const right = v.zones[ZONE_RIGHT] as number;
    const left = v.zones[ZONE_LEFT] as number;
    pull += ((right - left) / max) * BODY_PULL;
  }
  return pull;
}

/** Steering a bent body applies on its own, as a fraction of lock. */
const BODY_PULL = 0.5;

/** Power a battered engine loses at full wear, as a fraction. */
const WEAR_POWER_LOSS = 0.45;

/** Engine power available, 0..1, from overall wear and what is broken. */
export function vehiclePower(v: VehicleState): number {
  return (1 - wearOf(v) * WEAR_POWER_LOSS) * partsSpeedFactor(v);
}

export function propsTuning(): ReturnType<typeof getTuning>['props'] {
  return getTuning().props;
}
