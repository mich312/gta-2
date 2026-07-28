import { DT, PLAYER_RADIUS } from '../constants.js';
import { HALF_PI, PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { approach, clamp, q8, q256 } from '../math/vec.js';
import { getTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, PlayerState, VehicleState } from './state.js';
import { addHeat } from './state.js';
import type { InputIntent } from './input.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import { boxInSolid, moveWithCollision } from '../world/collide.js';
import { boxesOverlap, distanceToBox, poseIn, vehicleBox, vehicleBoxAt } from './bodies.js';
import type { Pose, VehicleWorld } from './bodies.js';
import type { SimEvent } from './events.js';
import {
  collisionDamage,
  damageVehicle,
  detonateVehicle,
  kerbStrike,
  partsSteerPull,
  vehiclePower,
} from './vehicleDamage.js';
import { creditGangKill } from './respect.js';
import { anyCopSees } from './police.js';
import { applyDamage } from './weapons.js';

// `VehicleWorld` and `Pose` moved to bodies.ts when people started colliding
// with cars too, but they are still part of this module's public face.
export type { Pose, VehicleWorld } from './bodies.js';

/** Closing speed below which a scrape is just a scrape. */
const WALL_HIT_MIN_SPEED = 54;
const CAR_HIT_MIN_SPEED = 36;
/** A wall gives back less than another car does — it does not move. */
const WALL_SHARE = 0.7;
/** Fraction of the exchange the car that did the hitting takes. */
const STRIKER_SHARE = 0.7;
/** Impulse handed to the struck car, before the mass split. */
const SHOVE_BASE = 0.55;
/** Kerb strike above this bursts the tyre nearest the contact. */
const KERB_TYRE_SPEED = 140;

/**
 * Arcade vehicle physics: signed forward speed along a heading, steering
 * authority that grows with speed, hard friction when coasting. Deliberately
 * not rigid-body anything. Deterministic trig only — this runs in prediction.
 */

/** What two vehicles touching tells the rest of the system. */
interface VehicleContact {
  /** The live vehicle — what the shove and the damage are applied TO. */
  other: VehicleState;
  /** Where it was when we hit it. The same as its live pose unless the
   * contact was resolved on a viewer's delayed clock. */
  pose: Pose;
  /** Where they met, in world coordinates. Routes the damage to a zone. */
  x: number;
  y: number;
}

/** Do these two vehicles' bodies overlap, where they each are right now? */
export function vehiclesOverlap(a: VehicleState, b: VehicleState): boolean {
  return boxesOverlap(vehicleBox(a), vehicleBox(b));
}

/**
 * Does a `heavy` simply drive over a `victim`, rather than bumping into it?
 *
 * A pure function of the two kinds' tuning, which is what lets the client
 * predict it: whether the tank stops is decided identically on both hosts,
 * and only what happens to the car underneath is the server's business. Get
 * this wrong in either direction and the tank stops dead on one host and
 * drives on in the other — the exact disagreement lag compensation exists to
 * remove, reintroduced by the feature.
 */
export function crushes(heavyKind: string, victimKind: string): boolean {
  const limit = getVehicleTuning(heavyKind).crushesBelowMass;
  return limit > 0 && getVehicleTuning(victimKind).mass < limit;
}

function overlappingVehicle(
  world: VehicleWorld | null,
  self: VehicleState,
): VehicleContact | null {
  if (!world) return null;
  const selfBox = vehicleBox(self);
  const selfReach = selfBox.halfLength + selfBox.halfWidth;
  for (const id of world.vehicles.ids) {
    if (id === self.id) continue;
    const other = world.vehicles.byId[id];
    if (!other) continue;
    // Nothing this one drives over can stop it — including the wreck it made
    // of that car a moment ago, which would otherwise be a tank sitting on
    // top of its own kill unable to get off it.
    if (crushes(self.kind, other.kind)) continue;
    const pose = poseIn(world, other);
    // Distance reject before the trig. `boxesOverlap` has a broad phase of its
    // own, but it runs after both boxes are built, and building one costs a
    // sine and a cosine — the whole expense on a street of parked cars none of
    // which are anywhere near.
    //
    // `halfLength + halfWidth`, which is EXACTLY the reach the inner broad
    // phase uses, so hoisting the test in front of the trig cannot change any
    // answer. Tempting and wrong: `halfLength` alone. A box reaches
    // sqrt(hl² + hw²) from its centre, not hl, so two cars meeting corner to
    // corner touch with their centres 26.4 px apart while `hl + hl` is 24 —
    // and the contact gets thrown away before anything looks at it. Which is
    // the exact class of bug this whole change is about.
    const ot = getVehicleTuning(other.kind);
    const reach = selfReach + ot.halfLength + ot.halfWidth;
    const rdx = pose.x - self.pos.x;
    const rdy = pose.y - self.pos.y;
    if (rdx * rdx + rdy * rdy > reach * reach) continue;
    if (boxesOverlap(selfBox, vehicleBoxAt(other.kind, pose.x, pose.y, pose.heading))) {
      // The midpoint of the two centres is the contact point, near enough:
      // head-on it lands in front of you, side-swiped it lands on the side
      // that was swiped, which is all the damage map needs to know.
      return {
        other,
        pose,
        x: (self.pos.x + pose.x) * 0.5,
        y: (self.pos.y + pose.y) * 0.5,
      };
    }
  }
  return null;
}

/**
 * Flatten everything `heavy` is currently standing on.
 *
 * The car goes up on the spot rather than catching light and going up seven
 * seconds later somewhere behind you: a tank rolling down a street leaves a
 * line of fireballs, which is the whole point of driving one.
 *
 * It is destroyed through the ordinary path — `damageVehicle` for exactly its
 * remaining health, so ignition, the arson charge and the `vehicleBurning`
 * event all happen the way they do for any other kill — and then detonated
 * immediately instead of on the burn fuse. Unlike a chain reaction this
 * cannot recurse: a blast only ever *ignites* the vehicles around it, so the
 * depth here is one, and the crusher itself is shielded from the blast it
 * just caused. Driving over a car is free; the tank is what it is.
 *
 * Crushing is charged as arson and not as a traffic accident, which is the
 * opposite of the call made for an ordinary shunt — and for the same reason.
 * There, nothing at the call site can tell a deliberate ram from a bad line
 * through a junction. Here there is nothing to tell apart: you were driving a
 * tank, and the car was underneath it.
 */
function crushUnderneath(sim: GameState, heavy: VehicleState, events: SimEvent[]): void {
  const box = vehicleBox(heavy);
  // Snapshot the ids: destroying one ignites its neighbours, which may add to
  // the table's contents, and iteration order must not depend on that.
  for (const id of [...sim.vehicles.ids]) {
    if (id === heavy.id) continue;
    const victim = sim.vehicles.byId[id];
    if (!victim || victim.condition !== 'ok') continue; // a wreck is already flat
    if (!crushes(heavy.kind, victim.kind)) continue;
    if (!boxesOverlap(box, vehicleBox(victim))) continue;
    damageVehicle(
      sim,
      victim,
      victim.health,
      events,
      heavy.driverId !== null && heavy.driverId >= 0 ? heavy.driverId : null,
      victim.pos.x,
      victim.pos.y,
    );
    // Re-read rather than trusting the binding: `damageVehicle` decides
    // whether that was enough to light it, and only something it actually
    // lit is ours to set off.
    const lit = sim.vehicles.byId[id];
    if (lit && lit.condition === 'burning') {
      detonateVehicle(sim, lit, events, heavy.id);
    }
  }
}

/** Ticks a pair stays immune after a shunt. See `GameState.vehicleHitTick`. */
const CONTACT_DEBOUNCE_TICKS = 4;

function contactIsFresh(sim: GameState, v: VehicleState): boolean {
  const last = sim.vehicleHitTick[v.id];
  return last === undefined || sim.tick - last >= CONTACT_DEBOUNCE_TICKS;
}

/** Move a vehicle by its speed/heading, colliding with tiles and (server-side) other cars. */
function integrateVehicle(
  v: VehicleState,
  map: CityMap,
  /**
   * What this vehicle can SEE. Supplied by the server from its own state and
   * by the client from the newest snapshot, so a car stops against a parked
   * car on the client at the moment of impact instead of driving through it
   * and being yanked back when the correction lands.
   */
  world: VehicleWorld | null,
  /**
   * What this vehicle may CHANGE. Non-null only on the server: damage,
   * wrecks and the shove given to the car you hit are authoritative, and a
   * client that guessed at them would be predicting somebody else's health.
   */
  sim: GameState | null,
  events?: SimEvent[],
  airborne = false,
): void {
  const t = getVehicleTuning(v.kind);
  if (v.speed === 0) return;
  if (airborne) {
    // Off the ground: no tiles, no other cars, no kerbs. Clearing things is
    // the entire point of a jump.
    v.pos.x = q8(v.pos.x + dCos(v.heading) * v.speed * DT);
    v.pos.y = q8(v.pos.y + dSin(v.heading) * v.speed * DT);
    return;
  }
  const beforeX = v.pos.x;
  const beforeY = v.pos.y;
  const dx = dCos(v.heading) * v.speed * DT;
  const dy = dSin(v.heading) * v.speed * DT;
  const tmpVel = { x: dx, y: dy };
  moveWithCollision(map, v.pos, tmpVel, t.halfExtent, dx, dy, t.medium);
  const hitWall = (dx !== 0 && tmpVel.x === 0) || (dy !== 0 && tmpVel.y === 0);
  if (hitWall) {
    const closing = Math.abs(v.speed);
    // Where the body met the wall: the centre of whichever face was blocked,
    // taken at the body's own extent so a nose-first prang dents the nose.
    const wx = v.pos.x + (dx !== 0 && tmpVel.x === 0 ? Math.sign(dx) * t.halfLength : 0);
    const wy = v.pos.y + (dy !== 0 && tmpVel.y === 0 ? Math.sign(dy) * t.halfWidth : 0);
    v.speed = -v.speed * t.crashDamp; // crunch + slight rebound
    if (Math.abs(v.speed) < 10) v.speed = 0;
    if (sim && closing > WALL_HIT_MIN_SPEED && contactIsFresh(sim, v)) {
      sim.vehicleHitTick[v.id] = sim.tick;
      damageVehicle(
        sim,
        v,
        (collisionDamage(v.kind, closing) * WALL_SHARE) / t.mass,
        events ?? [],
        // A wall is nobody's fault. Same reasoning as a car-to-car shunt: the
        // impact point is known, the culprit is not.
        null,
        wx,
        wy,
      );
      if (closing > KERB_TYRE_SPEED) kerbStrike(sim, v, wx, wy, events ?? []);
      events?.push({
        type: 'vehicleCollided',
        tick: sim.tick,
        vehicleId: v.id,
        x: Math.round(wx),
        y: Math.round(wy),
        speed: Math.round(closing),
      });
    }
  }
  // Anything it drove over. Server only — the client already knows it does
  // not stop (see `crushes`), and what becomes of the car underneath is
  // somebody else's vehicle, which a client has no business deciding.
  if (sim && getVehicleTuning(v.kind).crushesBelowMass > 0) {
    crushUnderneath(sim, v, events ?? []);
  }
  const hit = overlappingVehicle(world, v);
  if (hit) {
    const other = hit.other;
    // Are we driving INTO it, or out of it?
    //
    // Reverting the move on any overlap at all means two vehicles that are
    // already interpenetrating can never separate: every escape attempt is
    // undone, and the only way out is whatever unwedging heuristic the driver
    // happens to have. Two cruisers spawned on the same spot sat in a
    // wedge-reverse-wedge cycle for the whole of a chase because of it. A move
    // that increases the distance between the centres is a move out, and it is
    // always allowed — which is also simply what "momentum transfer, not a
    // brick wall" was supposed to mean.
    // Against the pose we HIT, not the live one: on a lag-compensated world
    // those differ, and mixing the two would have a car escaping a contact it
    // never made.
    const odx0 = beforeX - hit.pose.x;
    const ody0 = beforeY - hit.pose.y;
    const odx1 = v.pos.x - hit.pose.x;
    const ody1 = v.pos.y - hit.pose.y;
    if (odx1 * odx1 + ody1 * ody1 > odx0 * odx0 + ody0 * ody0) {
      v.pos.x = q8(v.pos.x);
      v.pos.y = q8(v.pos.y);
      v.speed = q8(v.speed);
      return;
    }
    // Momentum transfer, not a brick wall. The old behaviour reverted the
    // position and zeroed the speed, so a parked car stopped a 330 px/s
    // impact dead — you could not shunt, nudge or plough anything.
    v.pos.x = beforeX;
    v.pos.y = beforeY;
    const to = getVehicleTuning(other.kind);
    const closing = Math.abs(v.speed);
    // Mass splits the exchange. Every one of these three used to treat a bus
    // and a hatchback as the same object: a flat 0.55 shove, a heading
    // ASSIGNED rather than nudged (a T-boned bus instantly pointed the way
    // the car that hit it was going), and damage scaled by the receiver's own
    // "damage dealt" coefficient, which had the bus coming off worse than the
    // car. Equal masses reproduce the old numbers exactly.
    const share = t.mass / (t.mass + to.mass);
    const shove = v.speed * SHOVE_BASE * 2 * share;
    // Shoving the struck car is part of the collision RESPONSE, so the
    // client predicts it too — otherwise the server's car retreats, ours
    // does not, and the two disagree by a car length after a few seconds of
    // leaning on it. Safe because the client's world view is its own clone.
    // Damage is the part that stays authoritative.
    if (other.condition !== 'wreck' && Math.abs(shove) > Math.abs(other.speed)) {
      // Deflected toward the striker's line by the striker's mass share, not
      // snapped onto it.
      const swing = wrapAngle(v.heading - other.heading) * share;
      other.heading = q256(wrapAngle(other.heading + swing));
      other.speed = q8(shove);
    }
    v.speed = q8(-v.speed * t.crashDamp * 2 * (1 - share));
    if (Math.abs(v.speed) < 10) v.speed = 0;
    if (sim && closing > CAR_HIT_MIN_SPEED && contactIsFresh(sim, v) && contactIsFresh(sim, other)) {
      sim.vehicleHitTick[v.id] = sim.tick;
      sim.vehicleHitTick[other.id] = sim.tick;
      // Each takes what the OTHER dealt, divided by its own mass. The striker
      // is discounted: the end pointing at the impact is the end built for it.
      //
      // No attacker on either call: a collision is an accident as far as the
      // police are concerned, and nothing here can tell a deliberate ram from
      // a bad line through a junction. Charging for it would make every
      // scrape in ambient traffic a crime and turn the wanted system into
      // noise. The impact point is known; the culprit is not.
      damageVehicle(
        sim,
        other,
        collisionDamage(v.kind, closing) / to.mass,
        events ?? [],
        null,
        hit.x,
        hit.y,
      );
      damageVehicle(
        sim,
        v,
        (collisionDamage(other.kind, closing) / t.mass) * STRIKER_SHARE,
        events ?? [],
        null,
        hit.x,
        hit.y,
      );
      events?.push({
        type: 'vehicleCollided',
        tick: sim.tick,
        vehicleId: v.id,
        x: Math.round(hit.x),
        y: Math.round(hit.y),
        speed: Math.round(closing),
      });
    }
  }
  v.pos.x = q8(v.pos.x);
  v.pos.y = q8(v.pos.y);
  v.speed = q8(v.speed);
}

/**
 * How wrecked a car is, 0 (showroom) to 1 (one more shunt and it burns).
 *
 * Derived from health rather than stored, so it costs nothing on the wire and
 * cannot disagree between hosts. Division is exactly rounded under IEEE-754,
 * so this is prediction-safe like everything else here.
 */
export function vehicleWear(v: VehicleState): number {
  const max = getVehicleTuning(v.kind).health;
  if (max <= 0) return 0;
  const wear = (max - v.health) / max;
  return wear < 0 ? 0 : wear > 1 ? 1 : wear;
}

/** One tick of driver-controlled vehicle. */
export function stepVehicleDriving(
  v: VehicleState,
  input: InputIntent | undefined,
  map: CityMap,
  /** What it can see. The client passes the newest snapshot; see VehicleWorld. */
  world: VehicleWorld | null,
  /** What it may change. Server only. */
  sim: GameState | null = null,
  events?: SimEvent[],
  airborne = false,
): void {
  const throttle = input ? (input.up ? 1 : 0) - (input.down ? 1 : 0) : 0;
  const steer = input ? (input.right ? 1 : 0) - (input.left ? 1 : 0) : 0;
  driveVehicle(v, throttle, steer, map, world, sim, events, airborne);
}

/**
 * One tick of vehicle under continuous controls.
 *
 * A human at a keyboard only ever supplies ±1 on each axis, but an AI driver
 * wants a *proportion* of the wheel — bang-bang steering is what made ambient
 * traffic saw back and forth across the road instead of tracking a lane. Both
 * paths run the same physics, so a car handles identically whoever is at the
 * wheel.
 *
 * `throttle` and `steer` are clamped to [-1, 1]. Multiplication by a fraction
 * is exact under IEEE-754, so this stays prediction-safe.
 *
 * `authorityFloor` raises the minimum steering authority. The speed ramp exists
 * so a player cannot pirouette a parked car; an AI driver never asks for more
 * wheel than the lane it is tracking needs, and it has to be able to make a
 * 90° turn into a two-tile street at walking pace.
 */
export function driveVehicle(
  v: VehicleState,
  throttleIn: number,
  steerIn: number,
  map: CityMap,
  world: VehicleWorld | null,
  sim: GameState | null = null,
  events?: SimEvent[],
  airborne = false,
  authorityFloor = 0,
): void {
  const t = getVehicleTuning(v.kind);
  // A wreck is scenery: it does not respond to the pedals.
  if (v.condition === 'wreck') {
    v.speed = 0;
    return;
  }
  const throttle = clamp(throttleIn, -1, 1);
  // A damaged car does not drive straight. The pull is added BEFORE the clamp
  // so a badly bent one cannot be held perfectly straight at full lock — you
  // fight it, and at walking pace you win, because steering authority scales
  // with speed and the pull does not. Which way it pulls is now a fact about
  // the car — a flat near-side tyre, a wing folded into the arch — rather
  // than a sign taken from the vehicle id.
  const steer = clamp(steerIn + partsSteerPull(v), -1, 1);
  // ...and a holed radiator or a flat tyre costs it top end on top of wear.
  const power = vehiclePower(v);

  if (throttle > 0) {
    // Over the reduced ceiling — shot while flat out, say — it bleeds off at
    // engine-braking rate rather than snapping down, which would read as
    // hitting an invisible wall.
    const cap = t.maxSpeed * power;
    v.speed =
      v.speed > cap
        ? approach(v.speed, cap, t.friction * DT)
        : Math.min(cap, v.speed + t.accel * power * throttle * DT);
  } else if (throttle < 0) {
    v.speed =
      v.speed > 0
        ? Math.max(0, v.speed + t.brake * throttle * DT)
        : Math.max(-t.maxReverseSpeed, v.speed + t.reverseAccel * throttle * DT);
  } else {
    v.speed = approach(v.speed, 0, t.friction * DT);
  }

  if (steer !== 0 && v.speed !== 0) {
    const authority = Math.max(
      authorityFloor,
      Math.min(1, Math.abs(v.speed) / (t.maxSpeed * t.minSteerSpeedFrac)),
    );
    const dir = v.speed >= 0 ? 1 : -1; // reversing inverts steering, like a car
    v.heading = q256(wrapAngle(v.heading + steer * dir * t.turnRate * authority * DT));
  }

  integrateVehicle(v, map, world, sim, events, airborne);
}

/** Driverless vehicles coast to a stop. */
export function stepVehicleCoasting(
  v: VehicleState,
  map: CityMap,
  world: VehicleWorld | null,
  sim: GameState | null = null,
  events?: SimEvent[],
): void {
  const t = getVehicleTuning(v.kind);
  v.speed = approach(v.speed, 0, t.friction * DT);
  integrateVehicle(v, map, world, sim, events);
}

const MAX_BOARDING_SPEED = 24;

/** Try to put a player into the nearest free, near-stationary vehicle. */
export function tryEnterVehicle(
  state: GameState,
  p: PlayerState,
  map: CityMap,
  events?: SimEvent[],
): boolean {
  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.driverId !== null) continue;
    if (v.condition === 'wreck') continue; // scenery, not transport
    if (Math.abs(v.speed) > MAX_BOARDING_SPEED) continue;
    const t = getVehicleTuning(v.kind);
    // From the BODYWORK, not the centre. Measured from the centre, a door
    // reach that suits a car does not reach the front of a bus: a bus is 42 px
    // long, so its bumper is already 21 px out, and once people stopped being
    // able to walk INTO a vehicle the old rule stranded you against the nose
    // of the biggest ones with the door refusing to open. Nearest by the same
    // measure, so the vehicle you are touching is the one you get in.
    const d = distanceToBox(p.pos.x, p.pos.y, vehicleBox(v));
    if (d <= t.enterReach && d < bestD) {
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
  // The police are not the only ones who mind. Taking a gang's car is a
  // slight against them and a favour to whoever they are at odds with,
  // through exactly the same arithmetic as killing one of their people —
  // which is the point of having them own cars at all.
  if (best.gangId !== 0) {
    creditGangKill(state, p.id, best.gangId, events ?? []);
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

/** Step out above this and you go down the road rather than onto your feet. */
const BAILOUT_SAFE_SPEED = 60;
/** Health per px/s of overspeed. A 200 px/s bail costs about 28. */
const BAILOUT_DAMAGE_PER_SPEED = 0.2;
/** Ticks you spend picking yourself up, unable to shoot. */
const BAILOUT_STUN_TICKS = 18;

/**
 * How far ashore a passenger will wade when stepping off a boat, in tiles.
 *
 * A mooring is a tile of open water in every direction by construction, and
 * only guarantees dry land somewhere in the surrounding 7x7 (see
 * placeBoatSpawns) — while a boat's own hull keeps its centre 11 px off any
 * bank. So all three spots a car steps into land in the river, and getting
 * out of a boat was flatly impossible: pressing E aboard did nothing, ever.
 * You could sail away from the quay and never set foot on land again.
 *
 * Four tiles covers that 7x7 from the middle of it.
 */
const DISEMBARK_REACH_TILES = 4;

/**
 * Where somebody stepping off a boat may end up, nearest first.
 *
 * TILE CENTRES, not a ring of bearings around the hull. A player box is 12 px
 * across and a tile is 16, so the centre of any non-solid tile is a spot the
 * player provably fits in — which a polar search does not give you: it can
 * thread a bearing between two candidate tiles and report the whole bank as
 * blocked. Ordered by true distance, with the scan order breaking ties (sort
 * is stable), so every host picks the same bank.
 */
function disembarkSpots(v: VehicleState): Array<[number, number]> {
  const tx0 = Math.floor(v.pos.x / TILE_SIZE);
  const ty0 = Math.floor(v.pos.y / TILE_SIZE);
  const out: Array<[number, number, number]> = [];
  for (let ty = ty0 - DISEMBARK_REACH_TILES; ty <= ty0 + DISEMBARK_REACH_TILES; ty++) {
    for (let tx = tx0 - DISEMBARK_REACH_TILES; tx <= tx0 + DISEMBARK_REACH_TILES; tx++) {
      const ox = (tx + 0.5) * TILE_SIZE - v.pos.x;
      const oy = (ty + 0.5) * TILE_SIZE - v.pos.y;
      out.push([ox * ox + oy * oy, ox, oy]);
    }
  }
  out.sort((a, b) => (a[0] as number) - (b[0] as number));
  return out.map(([, ox, oy]) => [ox, oy] as [number, number]);
}

/** Try to exit: first free spot beside (then behind) the car wins. */
export function tryExitVehicle(
  state: GameState,
  p: PlayerState,
  map: CityMap,
  events?: SimEvent[],
): boolean {
  if (p.vehicleId === null) return false;
  const v = state.vehicles.byId[p.vehicleId];
  if (!v) return false;
  const t = getVehicleTuning(v.kind);
  const side = t.halfExtent + PLAYER_RADIUS + 3;
  const candidates: Array<[number, number]> =
    t.medium === 'water'
      ? // Off a boat you wade for the nearest bank rather than looking for a
        // gap beside the hull: beside the hull is always more river.
        disembarkSpots(v)
      : [
          [dCos(v.heading + HALF_PI) * side, dSin(v.heading + HALF_PI) * side],
          [dCos(v.heading - HALF_PI) * side, dSin(v.heading - HALF_PI) * side],
          [dCos(v.heading + PI) * (side + 8), dSin(v.heading + PI) * (side + 8)],
        ];
  for (const [ox, oy] of candidates) {
    const spot = { x: v.pos.x + ox, y: v.pos.y + oy };
    // Land check regardless of the vehicle's medium: stepping off a boat
    // has to put you on a bank, not into the river.
    if (!boxInSolid(map, spot, PLAYER_RADIUS)) {
      const speed = Math.abs(v.speed);
      v.driverId = null;
      p.mode = 'foot';
      p.vehicleId = null;
      p.pos = spot;
      p.vel.x = 0;
      p.vel.y = 0;
      // Stepping out of a moving car used to be free, which made the burn
      // fuse a non-decision: you could bail at full speed and stand there
      // unhurt. It costs skin now, and a moment on the floor before you can
      // shoot — so riding it out is a real alternative rather than the only
      // stupid option.
      if (speed > BAILOUT_SAFE_SPEED) {
        p.fireCooldown = Math.max(p.fireCooldown, BAILOUT_STUN_TICKS);
        applyDamage(
          state,
          p,
          (speed - BAILOUT_SAFE_SPEED) * BAILOUT_DAMAGE_PER_SPEED,
          p.id,
          'tumble',
          events ?? [],
        );
      }
      return true;
    }
  }
  return false; // boxed in — stay in the car
}
