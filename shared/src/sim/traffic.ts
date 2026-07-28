import { HALF_PI, PI, dAtan2, dCos, dSin, wrapAngle } from '../math/trig.js';
import { clamp, q8 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTrafficTuning, getTuning, getVehicleTuning, type TrafficTuning } from '../tuning.js';
import type { GameState, TrafficDriver, VehicleState } from './state.js';
import { createPed, createVehicle } from './state.js';
import { insertEntity, removeEntity } from './entities.js';
import { boxInSolid } from '../world/collide.js';
import { PED_RADIUS } from './peds.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import {
  CARDINALS,
  CARDINAL_ANGLE,
  dirIsOpen,
  drivableAt,
  drivableTile,
  nearestCardinal,
  planRoute,
} from './roadgrid.js';
import { PLAYER_RADIUS } from '../constants.js';
import { rayWallDistance } from './weapons.js';
import { stopLineGap } from './signals.js';
import { driveVehicle } from './vehicle.js';
import type { SimEvent } from './events.js';

/**
 * What turns up next, drawn from the weighted mix in traffic.json.
 *
 * The draw happens here, at the moment of spawning, so it costs exactly one
 * rng value per car and nothing when the population is full. Kinds are read
 * in tuning order, so the same seed puts the same bus on the same corner.
 */
function pickKind(state: GameState): string {
  const mix = getTrafficTuning().mix;
  let total = 0;
  for (const m of mix) total += m.weight;
  if (total <= 0) return 'car';
  let roll: number;
  [roll, state.rng] = nextFloat01(state.rng);
  let acc = roll * total;
  for (const m of mix) {
    acc -= m.weight;
    if (acc < 0) return m.kind;
  }
  return mix[mix.length - 1]?.kind ?? 'car';
}

/**
 * Ambient traffic.
 *
 * `shared/data/traffic.json` has existed since the beginning as a complete,
 * carefully-parameterised spec with **no code behind it** — every key in it
 * had zero references. This is that code. Before it, the streets held 48
 * parked, empty, permanently stationary cars.
 *
 * AI drivers are marked by a NEGATIVE `driverId`. That falls out of the
 * existing rules for free: `tryEnterVehicle` already skips any vehicle with a
 * driver, so an occupied car is correctly un-enterable, and taking one has to
 * become an explicit action — which is exactly where the genre's headline
 * verb belongs. See `tryCarjack`.
 *
 * A driver holds one piece of intent — the cardinal direction it means to
 * follow, in `state.trafficDrivers` — and re-derives everything else from the
 * road grid every tick:
 *
 *  - The carriageway is measured ACROSS the direction of travel and the driver
 *    aims at the centre of its right-hand half. That is what puts traffic on
 *    the correct side of the road. The previous version aimed at the centre of
 *    whichever tile the car happened to be standing on, so on any road wider
 *    than one tile — which is all of them — oncoming cars shared a lane and
 *    met head-on.
 *  - Steering is pure pursuit onto that lane with a proportional wheel, so a
 *    car tracks its side of the road and arcs through a junction. The previous
 *    version teleported the heading by 90° at a junction and used a bang-bang
 *    wheel whose deadband (`laneHalfWidth`, 14 px) was nearly as wide as a
 *    tile — so lane keeping could not engage at all.
 *  - Blocked means BRAKE, and reverse is deliberate, brief and only for a car
 *    that has been provably wedged for a while. The previous version held the
 *    brake pedal down against the obstacle, and `down` past a standstill is
 *    reverse — which is why ambient traffic drove backwards down the street.
 *
 * ROUTING runs on a staggered 3-tick cadence (NPC thinking at 10 Hz), but the
 * wheel, the pedals and the physics run EVERY tick. They have to: a car that
 * integrates three ticks' worth of motion on one tick and stands still for the
 * next two is not being simulated at 10 Hz, it is teleporting nine pixels at a
 * time, and no amount of interpolation on the client can smooth a step
 * function whose steps land on tick boundaries. Deciding at 10 Hz is free;
 * moving at 10 Hz is the stutter.
 */

/**
 * Which way is a driver's RIGHT, per cardinal, as a signed step along the
 * perpendicular axis. Screen y points down, so the right of "east" is south.
 */
const RIGHT_SIGN = [1, -1, -1, 1] as const;
/**
 * Widest carriageway that still counts as a road with sides to it, in tiles
 * (the generator's widest is `worldgen.arterialWidth`). Anything wider is a
 * junction or a plaza: the perpendicular scan is running down a CROSSING road,
 * and its "lane" would be five tiles into a building. There, a driver holds
 * its heading and picks lane keeping back up on the far side.
 */
const MAX_LANE_TILES = 4;
/** How far past a junction a driver will look for the lane it comes out into. */
const MAX_JUNCTION_TILES = 6;
/** Heading error past which a driver lifts off and takes the corner slowly. */
const TURN_ERROR = 0.35;
/** Speed below which a car that ought to be moving counts as wedged. */
const WEDGED_SPEED = 12;
/**
 * Gap inside which a person in the road counts as the reason a driver is
 * stationary, so it gets a pedestrian's patience rather than a wall's.
 */
const STOP_GAP = 30;

/** AI drivers are negative ids; -1 is reserved for "the streets". */
export function isAiDriver(driverId: number | null): boolean {
  return driverId !== null && driverId < -1;
}

/** A calm ambient driver about to set off in a direction. */
function freshDriver(dir: number): TrafficDriver {
  return { dir, stuck: 0, panic: 0, mission: 'cruise', route: null, routeIdx: 0, trip: 0 };
}

/**
 * The lanes available to a driver, measured across its direction of travel and
 * listed in the order it should prefer them: the kerb-side lane of its own
 * half first, then the inner lane of its own half where the road is wide
 * enough to have one, and the oncoming half last of all.
 *
 * The middle option is what makes a parked car survivable. An arterial is four
 * tiles across, so it has two lanes each way — and with only one lane per
 * direction modelled, a single car parked at the kerb pushed all the traffic
 * on that side into the oncoming half, where it met the traffic coming the
 * other way and both stopped.
 *
 * Keeping the oncoming half in the same ordered list — rather than gating it
 * behind "is the obstacle stationary?", so that a driver queues behind moving
 * traffic and only crosses the centreline for a parked car — is measured, not
 * assumed. Gating it is worse on every count: over twelve seeds, lane
 * discipline 90.8% -> 89.5%, head-on encounters 4.2% -> 4.8% of samples, and
 * traffic under way 81% -> 79%. Cars that cannot flow round each other queue,
 * queues wedge, and a wedged driver's recovery manoeuvre puts it further out
 * of position than an overtake ever did.
 *
 * Null when the car is not on a road at all, which is the signal to hold the
 * current heading rather than steer at a phantom lane.
 */
function laneOptions(map: CityMap, x: number, y: number, dirIdx: number): number[] | null {
  const alongX = dirIdx === 0 || dirIdx === 2;
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (!drivableTile(map, tx, ty)) return null;

  let lo = alongX ? ty : tx;
  let hi = lo;
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, alongX ? tx : tx - i, alongX ? ty - i : ty)) break;
    lo -= 1;
  }
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, alongX ? tx : tx + i, alongX ? ty + i : ty)) break;
    hi += 1;
  }
  if (hi - lo + 1 > MAX_LANE_TILES) return null;

  const tiles = hi - lo + 1;
  const centre = ((lo + hi + 1) / 2) * TILE_SIZE;
  const halfWidth = (tiles / 2) * TILE_SIZE;
  const sign = RIGHT_SIGN[dirIdx] as number;
  // A one-tile lane has no sides to keep to: everybody shares the middle.
  if (tiles === 1) return [centre];
  if (tiles >= 4) {
    return [
      centre + sign * halfWidth * 0.75, // kerb lane
      centre + sign * halfWidth * 0.25, // inner lane, same direction
      centre - sign * halfWidth * 0.5, // oncoming, last resort
    ];
  }
  return [centre + sign * halfWidth * 0.5, centre - sign * halfWidth * 0.5];
}

/**
 * Is another vehicle sitting on this point? The reach has to stay under the
 * lane spacing (16 px on an arterial), or a car in the next lane along reads
 * as blocking this one and nobody ever changes lane.
 */
function vehicleAt(state: GameState, self: VehicleState, x: number, y: number): boolean {
  const reach = getVehicleTuning(self.kind).halfExtent * 1.6;
  for (const id of state.vehicles.ids) {
    if (id === self.id) continue;
    const other = state.vehicles.byId[id];
    if (!other) continue;
    if (Math.abs(other.pos.x - x) < reach && Math.abs(other.pos.y - y) < reach) return true;
  }
  return false;
}

/**
 * Where the lane we are heading for picks up again on the far side of a
 * junction, or null if there is no road that way.
 *
 * A junction is a hole in the lane model: the carriageway measured across the
 * direction of travel is the width of the CROSSING road, so `laneOptions`
 * correctly refuses to answer and the driver has nothing to aim at. Walking
 * forward tile by tile until the lane model works again is the same thing a
 * path-node driver does when it reaches the end of a lane — take the next lane
 * on the route and drive at it — and it is what turns a corner into an arc
 * instead of a rotation about the junction centre.
 */
function junctionExit(
  map: CityMap,
  x: number,
  y: number,
  dirIdx: number,
): { x: number; y: number } | null {
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const alongX = dirIdx === 0 || dirIdx === 2;
  for (let step = 1; step <= MAX_JUNCTION_TILES; step++) {
    const px = x + dx * step * TILE_SIZE;
    const py = y + dy * step * TILE_SIZE;
    if (!drivableAt(map, px, py)) return null;
    const lanes = laneOptions(map, px, py, dirIdx);
    if (!lanes) continue;
    const lane = lanes[0] as number;
    return { x: alongX ? px : lane, y: alongX ? lane : py };
  }
  return null;
}

/*
 * Junction right-of-way was built here and measured out again.
 *
 * The literature's third ingredient, after car-following and lane traversal,
 * is gap acceptance: yield before entering a junction somebody is already
 * crossing. It was implemented as the one rule that cannot deadlock — yield
 * only to traffic ALREADY in the box, never to traffic merely approaching it,
 * and never yield once committed yourself — and over twelve seeds it is worse
 * on four metrics out of five: lane discipline 98.4% -> 97.9%, traffic under
 * way 90.6% -> 88.4%, head-on encounters 1.00% -> 1.36%, off the carriageway
 * 0.74% -> 1.2%, against a single marginal gain in collision damage.
 *
 * Why: with the Intelligent Driver Model already braking for anything that
 * enters the car's path, a car crossing a junction gets braked for on its own
 * merits. The extra rule mostly stops cars that had no conflict, and a car
 * stopped at a junction mouth is a car other drivers then have to negotiate.
 * Cheap politeness, expensive traffic.
 */

/** What a driver has found in front of it, and how fast that thing is going. */
interface Ahead {
  /** Bumper-to-bumper distance, px. Infinity when the road is clear. */
  gap: number;
  /** The obstacle's speed along OUR heading. Negative for oncoming traffic. */
  leadSpeed: number;
  /** True when the nearest thing in the way is a person rather than a car. */
  person: boolean;
}

/**
 * The nearest thing in this car's path, whatever it is: a car, a person on
 * foot, or a wall.
 *
 * This replaces a set of yes/no probes at fixed points ahead of the bumper.
 * A probe can only answer "is something there?", which is the entire reason
 * the old driver could only stamp or lift: to follow a car properly you have
 * to know how far away it is AND how fast it is going, so you can close the
 * distance when it pulls away and ease off before you reach it. Everything is
 * projected onto the car's own heading, which is what makes an oncoming car
 * report a NEGATIVE lead speed and get braked for twice as hard as a slow one.
 */
function scanAhead(state: GameState, map: CityMap, v: VehicleState, horizon: number): Ahead {
  const t = getVehicleTuning(v.kind);
  // Length ahead, width across. A single `halfExtent` for both was survivable
  // while the collision box was also a square; against the real body it had
  // the follower believing it had six pixels of gap at the moment the two
  // bumpers touched, so a queue closed up until it collided and the wedged
  // driver reversed out. The obstacle model has to agree with the contact
  // model or the IDM is solving the wrong problem.
  const half = t.halfLength;
  const halfW = t.halfWidth;
  const cos = dCos(v.heading);
  const sin = dSin(v.heading);
  let gap = Infinity;
  let leadSpeed = 0;
  let person = false;

  // Buildings and water. Started at the bumper, not the centre, or a car is
  // permanently "half a car length" closer to every wall than it really is.
  const wall = rayWallDistance(map, v.pos.x + cos * half, v.pos.y + sin * half, cos, sin, horizon);
  if (wall < horizon) gap = wall;

  /** Fold one obstacle in, if it is genuinely in our path and closer. */
  const consider = (
    ox: number,
    oy: number,
    /** Their extent along OUR heading, and across it. */
    oFwd: number,
    oLat: number,
    speed: number,
    isPerson: boolean,
  ) => {
    const rx = ox - v.pos.x;
    const ry = oy - v.pos.y;
    const fwd = rx * cos + ry * sin;
    if (fwd <= 0) return; // behind us
    const lat = -rx * sin + ry * cos;
    // Our own width plus theirs: anything outside that is in another lane and
    // is not ours to worry about.
    if (lat > halfW + oLat || lat < -(halfW + oLat)) return;
    const g = fwd - half - oFwd;
    if (g >= gap) return;
    gap = g;
    leadSpeed = speed;
    person = isPerson;
  };

  for (const id of state.vehicles.ids) {
    if (id === v.id) continue;
    const other = state.vehicles.byId[id];
    if (!other) continue;
    const ot = getVehicleTuning(other.kind);
    if (Math.abs(other.pos.x - v.pos.x) > horizon || Math.abs(other.pos.y - v.pos.y) > horizon) {
      continue;
    }
    // Their box projected onto our axes: a car across the road is as wide as
    // it is long from where we are sitting.
    const dh = wrapAngle(other.heading - v.heading);
    const c = Math.abs(dCos(dh));
    const s = Math.abs(dSin(dh));
    const oFwd = ot.halfLength * c + ot.halfWidth * s;
    const oLat = ot.halfLength * s + ot.halfWidth * c;
    // Their speed resolved onto our heading. A car crossing us contributes
    // almost nothing; one coming the other way contributes its full speed as a
    // closing rate, which is exactly how it should read.
    const along = other.speed * dCos(dh);
    consider(other.pos.x, other.pos.y, oFwd, oLat, along, false);
  }
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped || ped.mode === 'dead') continue; // traffic does not queue behind a body
    consider(ped.pos.x, ped.pos.y, PLAYER_RADIUS, PLAYER_RADIUS, 0, true);
  }
  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p || p.mode !== 'foot') continue;
    consider(p.pos.x, p.pos.y, PLAYER_RADIUS, PLAYER_RADIUS, 0, true);
  }
  for (const id of state.cops.ids) {
    const cop = state.cops.byId[id];
    if (!cop || cop.vehicleId !== null) continue;
    consider(cop.pos.x, cop.pos.y, PLAYER_RADIUS, PLAYER_RADIUS, 0, true);
  }
  // A fresh object every time, deliberately. This used to return a shared
  // module-level CLEAR constant for the open-road case, and the caller folds
  // the junction-yield gap in by assigning to the result — so the first driver
  // ever to yield wrote a finite gap into the singleton and every "clear road"
  // reading in the process from then on reported a phantom obstacle. The whole
  // city stopped: 13% of traffic under way against 90%.
  return { gap, leadSpeed, person };
}

/**
 * The Intelligent Driver Model: how hard to press which pedal, as one number.
 *
 *   accel = A * [ 1 - (v/v0)^4 - (wanted/gap)^2 ]
 *   wanted = s0 + max(0, v*T + v*dv / (2*sqrt(A*B)))
 *
 * The first bracket term is the free road — ease off smoothly as you approach
 * your desired speed. The second is the car in front: `wanted` (s-star in the
 * literature) is the gap you WANT given your speed and how fast you are
 * closing, and the further inside it you are the harder you brake. dv is the
 * closing rate, so a leader pulling away shrinks the desired gap and you
 * accelerate after it.
 *
 * This is the standard model from traffic engineering (Treiber, Hennecke &
 * Helbing 2000) and it is what the driver here was missing. The previous rule
 * was "something within the braking distance? full reverse-thrust braking;
 * otherwise full throttle", which is a bang-bang controller: it cannot follow
 * anything, so traffic could only alternate between charging and stamping, and
 * a queue behaved as a row of independent cars each rediscovering the one in
 * front.
 *
 * Exact ops only, so it stays in lockstep: `Math.pow` is not IEEE-pinned, hence
 * the written-out fourth power, and `Math.sqrt` is exactly rounded so it is
 * allowed.
 */
function idmAccel(speed: number, desired: number, ahead: Ahead, t: TrafficTuning): number {
  const r = desired > 0 ? speed / desired : 1;
  const free = 1 - r * r * r * r;
  if (ahead.gap === Infinity) return t.comfortAccel * free;

  const dv = speed - ahead.leadSpeed; // closing rate; negative when it pulls away
  const wanted =
    t.minGap +
    Math.max(0, speed * t.timeHeadway + (speed * dv) / (2 * Math.sqrt(t.comfortAccel * t.comfortBrake)));
  // Never divide by a gap of zero: overlapping means "brake as hard as you can",
  // not "produce an infinity and poison the state hash".
  const s = ahead.gap > 0.5 ? ahead.gap : 0.5;
  const ratio = wanted / s;
  return t.comfortAccel * (free - ratio * ratio);
}

/**
 * Nearest road tile centre to a car that has ended up off the carriageway, or
 * null if there is none nearby.
 *
 * Sidewalks, parks and lots are not solid — a car can and does end up on them
 * after clipping a kerb mid-turn — so "off the road" is a routing problem to
 * steer out of, not a collision to brake for.
 */
function recoverTarget(map: CityMap, x: number, y: number): { x: number; y: number } | null {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= 3 && !best; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!drivableTile(map, tx + dx, ty + dy)) continue;
        const cx = (tx + dx + 0.5) * TILE_SIZE;
        const cy = (ty + dy + 0.5) * TILE_SIZE;
        const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (d < bestD) {
          bestD = d;
          best = { x: cx, y: cy };
        }
      }
    }
  }
  return best;
}

/**
 * Choose a direction to follow from where the car is standing: straight on if
 * that is open, otherwise a turn, and a U-turn only out of a dead end. Draws
 * from the sim rng, so every driver makes the same choices on every host and
 * in every replay.
 */
function chooseDir(state: GameState, map: CityMap, v: VehicleState, prefer: number): number {
  const t = getTrafficTuning();
  const right = (prefer + 1) % 4;
  const left = (prefer + 3) % 4;
  const canStraight = dirIsOpen(map, v.pos.x, v.pos.y, prefer);
  const canRight = dirIsOpen(map, v.pos.x, v.pos.y, right);
  const canLeft = dirIsOpen(map, v.pos.x, v.pos.y, left);

  let roll: number;
  [roll, state.rng] = nextFloat01(state.rng);

  if (canStraight) {
    // Mostly carry on. The occasional turn is what makes traffic circulate
    // instead of streaming down the same four avenues for ever.
    if (roll >= t.turnChance) return prefer;
    if (canRight && canLeft) return roll < t.turnChance / 2 ? right : left;
    if (canRight) return right;
    if (canLeft) return left;
    return prefer;
  }
  if (canRight && canLeft) return roll < 0.5 ? right : left;
  if (canRight) return right;
  if (canLeft) return left;
  return (prefer + 2) % 4; // dead end: turn around
}

/**
 * The wheel and the pedals for one physics tick: aim at a point down the
 * right-hand lane, brake for whatever is actually in the way.
 */
function laneControl(
  state: GameState,
  map: CityMap,
  v: VehicleState,
  driver: TrafficDriver,
): { throttle: number; steer: number; personBlocked: boolean; heldAtSignal: boolean } {
  const t = getTrafficTuning();
  const dirIdx = driver.dir >= 0 ? driver.dir : nearestCardinal(v.heading);
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const alongX = dirIdx === 0 || dirIdx === 2;

  // Aim a short way down the lane. Short, because the pursuit point is what
  // sets the turn radius, and a distant one reads as a wide lazy arc that
  // leaves the road entirely on a 32 px street.
  let targetX = v.pos.x + dx * t.lookAhead;
  let targetY = v.pos.y + dy * t.lookAhead;

  const lanes = laneOptions(map, v.pos.x, v.pos.y, dirIdx);
  if (!drivableAt(map, v.pos.x, v.pos.y)) {
    // Off the carriageway: get back on it before worrying about which side.
    const back = recoverTarget(map, v.pos.x, v.pos.y);
    if (back) {
      targetX = back.x;
      targetY = back.y;
    }
  } else if (!lanes) {
    // Standing INSIDE a junction, where the carriageway has no sides to keep
    // to. Aim at the lane we will be in when we come out the far side, which
    // is how a path-node driver traverses a junction: pick the next lane on
    // the route and drive at it. Holding the current heading instead — which
    // is what happened before — means every turn is taken by rotating on the
    // spot at the junction centre and then cutting the corner.
    const exit = junctionExit(map, v.pos.x, v.pos.y, dirIdx);
    if (exit) {
      targetX = exit.x;
      targetY = exit.y;
    }
  } else {
    // Take the first lane that is actually free, in preference order. A parked
    // car is 18 px wide in a 16 px lane, so without this every one of them is a
    // permanent roadblock.
    //
    // Looked for further ahead than the car is steering — a lane change wants
    // to start before the obstacle is on the bumper, or it becomes a stop
    // followed by a shuffle.
    const scan = t.lookAhead + Math.abs(v.speed) * t.brakeDistancePerSpeed;
    const probeX = v.pos.x + dx * scan;
    const probeY = v.pos.y + dy * scan;
    let lane = lanes[0] as number;
    for (const option of lanes) {
      const ox = alongX ? probeX : option;
      const oy = alongX ? option : probeY;
      if (!drivableAt(map, ox, oy) || vehicleAt(state, v, ox, oy)) continue;
      lane = option;
      break;
    }
    if (alongX) targetY = lane;
    else targetX = lane;
  }

  const err = wrapAngle(dAtan2(targetY - v.pos.y, targetX - v.pos.x) - v.heading);
  const steer = clamp(err * t.steerGain, -1, 1);

  // Corner speed: `turnSpeed` through a bend, cruise on the straight — and a
  // scared driver's straight is a lot faster than a calm one's. Corners stay
  // at `turnSpeed` either way: panic floors the accelerator, it does not
  // repeal the steering physics, and a driver that corners at double speed
  // leaves the road on every bend, which reads as broken rather than scared.
  //
  // A driver on an errand presses on too. Ambient cruise is a shopping trip;
  // an ambulance answering somebody bleeding out in the road at 62 px/s would
  // arrive after the funeral. Same ceiling as panic, for the same reason —
  // it is the fastest speed the lane-keeping is known to hold.
  const straight =
    driver.panic > 0 || driver.mission === 'goto' ? t.panicSpeed : t.cruiseSpeed;
  const desired = Math.abs(err) > TURN_ERROR ? t.turnSpeed : straight;

  // How hard to press which pedal, from one continuous model of what is in
  // front. Requested as an ACCELERATION and converted to a pedal position at
  // the end, so the same request means the same thing whatever the car's
  // engine and brakes happen to be worth.
  const ahead = scanAhead(state, map, v, t.scanHorizon);

  // A red light is a car that will never move. Folding it into the same Ahead
  // the car-following model already consumes means the driver eases to a halt
  // at the line and everybody behind queues behind it, using the braking
  // curve this model was tuned for — rather than a second, separate stopping
  // rule of the kind the gap-acceptance experiment above found so expensive.
  //
  // Panic overrides it. A driver fleeing gunfire does not wait at a red, and
  // one that did would look broken rather than frightened.
  let heldAtSignal = false;
  if (driver.panic === 0) {
    const line = stopLineGap(
      map,
      v.pos.x,
      v.pos.y,
      dirIdx,
      Math.abs(v.speed),
      getVehicleTuning(v.kind).halfExtent,
      state.tick,
      t.signals,
      t.comfortBrake,
    );
    if (line < ahead.gap) {
      ahead.gap = line;
      ahead.leadSpeed = 0;
      ahead.person = false;
    }
    heldAtSignal = line < Infinity;
  }

  const accel = idmAccel(v.speed, desired, ahead, t);
  const veh = getVehicleTuning(v.kind);
  const throttle =
    accel >= 0 ? Math.min(1, accel / veh.accel) : Math.max(-1, accel / veh.brake);

  // Coasting is not braking: below walking pace, asking for negative
  // acceleration means asking for reverse, and a queue of ambient cars slowly
  // reversing into each other is worse than any jam.
  const held = throttle < 0 && v.speed <= 0 ? 0 : throttle;
  return {
    throttle: held,
    steer,
    personBlocked: ahead.person && ahead.gap < STOP_GAP,
    heldAtSignal,
  };
}

/**
 * Within this Chebyshev distance a corner counts as reached. Generous on
 * purpose: the car drives a LANE, offset up to a tile and a half from the
 * route's centre-line corners, and a reach smaller than that offset leaves a
 * driver circling a corner it can never touch. Advancing a corner early is
 * harmless — the next corner is further along the same road.
 */
const CORNER_REACH = TILE_SIZE * 1.75;
/**
 * Manhattan distance from the current corner past which the plan is judged
 * lost — shunted off course, or recovered somewhere else entirely — and is
 * recomputed from wherever the car actually is.
 */
const REPATH_DIST = TILE_SIZE * 8;

/** The errand is over; melt back into the traffic. */
function endMission(driver: TrafficDriver): void {
  driver.mission = 'cruise';
  driver.route = null;
  driver.routeIdx = 0;
}

/**
 * One routing decision for a driver on an errand: advance past any corners
 * already reached, then point `driver.dir` down the open cardinal that leads
 * to the next one. The wheel, the pedals, the lane-keeping and the stuck
 * recovery are all the ordinary machinery in laneControl — a mission changes
 * which way the car means to go, never how it drives.
 *
 * Arrival reverts the driver to cruise: the primitive's contract is "get
 * there", and what happens there belongs to whatever assigned the errand
 * (see assignGoto). A driver knocked far off the plan re-plans from where it
 * is, and gives the errand up only if no road connects any more.
 */
function followRoute(map: CityMap, v: VehicleState, driver: TrafficDriver): void {
  const route = driver.route as number[];
  while (driver.routeIdx < route.length) {
    const cx = route[driver.routeIdx] as number;
    const cy = route[driver.routeIdx + 1] as number;
    if (Math.abs(v.pos.x - cx) >= CORNER_REACH || Math.abs(v.pos.y - cy) >= CORNER_REACH) break;
    driver.routeIdx += 2;
  }
  if (driver.routeIdx >= route.length) {
    endMission(driver);
    return;
  }

  const cx = route[driver.routeIdx] as number;
  const cy = route[driver.routeIdx + 1] as number;
  const dx = cx - v.pos.x;
  const dy = cy - v.pos.y;
  if (Math.abs(dx) + Math.abs(dy) > REPATH_DIST) {
    const destX = route[route.length - 2] as number;
    const destY = route[route.length - 1] as number;
    const fresh = planRoute(map, v.pos.x, v.pos.y, destX, destY);
    if (fresh) {
      driver.route = fresh;
      driver.routeIdx = 0;
    } else {
      endMission(driver);
    }
    return;
  }

  // The dominant axis first, the other as fallback — but only down open road.
  // With both closed the driver holds its heading and the junction-traversal
  // and recovery machinery carry it until one opens again.
  const primary = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
  const secondary = Math.abs(dx) >= Math.abs(dy) ? (dy >= 0 ? 1 : 3) : (dx >= 0 ? 0 : 2);
  if (dirIsOpen(map, v.pos.x, v.pos.y, primary)) driver.dir = primary;
  else if (dirIsOpen(map, v.pos.x, v.pos.y, secondary)) driver.dir = secondary;
}

/**
 * Send an AI-driven vehicle somewhere: the errand-driving primitive.
 *
 * Nothing in ambient traffic calls this — cruise is a random walk on purpose.
 * It exists for everything that needs a car to arrive: service vehicles
 * answering a casualty, gang cars heading home, mission targets making for a
 * getaway. Returns false when the vehicle is not AI-driven, is a wreck, or no
 * road connects it to the destination; true means the errand is accepted and
 * the driver will revert to 'cruise' at the destination.
 */
export function assignGoto(
  state: GameState,
  map: CityMap,
  vehicleId: number,
  x: number,
  y: number,
): boolean {
  const v = state.vehicles.byId[vehicleId];
  if (!v || !isAiDriver(v.driverId) || v.condition !== 'ok') return false;
  const route = planRoute(map, v.pos.x, v.pos.y, x, y);
  if (!route) return false;
  let driver = state.trafficDrivers[vehicleId];
  if (!driver) {
    driver = freshDriver(nearestCardinal(v.heading));
    state.trafficDrivers[vehicleId] = driver;
  }
  driver.mission = 'goto';
  driver.route = route;
  driver.routeIdx = 0;
  return true;
}

/**
 * Park an AI driver where it stands: it has arrived and has work to do.
 *
 * The companion to assignGoto — without it, arriving reverts the driver to
 * cruise and it simply drives off again, which is no use to anything that
 * needed the car to BE somewhere rather than merely reach it. Whatever set
 * the errand owns the release.
 */
export function holdAt(state: GameState, vehicleId: number): boolean {
  const driver = state.trafficDrivers[vehicleId];
  if (!driver) return false;
  driver.mission = 'tend';
  driver.route = null;
  driver.routeIdx = 0;
  return true;
}

/** Release a driver from an errand, tending or en route: back to traffic. */
export function releaseErrand(state: GameState, vehicleId: number): void {
  const driver = state.trafficDrivers[vehicleId];
  if (driver) endMission(driver);
}

/**
 * One tick of ambient traffic. Runs before player movement is integrated so
 * an AI car and a player car resolve their overlap the same way any two
 * vehicles do.
 */
export function stepTraffic(state: GameState, map: CityMap, events: SimEvent[]): void {
  const t = getTrafficTuning();
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId)) continue;

    // A burning or wrecked car has no driver left worth simulating.
    if (v.condition !== 'ok') {
      v.driverId = null;
      delete state.trafficDrivers[id];
      continue;
    }

    let driver = state.trafficDrivers[id];
    if (!driver) {
      driver = freshDriver(nearestCardinal(v.heading));
      state.trafficDrivers[id] = driver;
    }
    if (driver.panic > 0) driver.panic--;
    driver.trip++;

    // Stopped on the job. A tending driver has arrived at whatever it was
    // sent to and is busy: no routing, no turn lottery, pedals off, and it
    // rolls to a halt on its own friction. Whatever set the errand takes it
    // off 'tend' when the job is done — see sim/ambulance.ts.
    if (driver.mission === 'tend') {
      driver.stuck = 0;
      driveVehicle(v, 0, 0, map, state, state, events, false, 1);
      continue;
    }

    if (driver.stuck < 0) {
      // Backing out of somewhere. Bounded: it ends, and the driver then picks
      // a fresh direction from wherever it managed to reach. This is the only
      // path in the whole system that ever selects reverse.
      driver.stuck++;
      driveVehicle(v, -1, 0, map, state, state, events, false, 1);
      if (driver.stuck === 0) driver.dir = chooseDir(state, map, v, nearestCardinal(v.heading));
      continue;
    }

    // Routing at 10 Hz, staggered by id: hold the current intent while it still
    // leads somewhere, re-pick the moment it does not, and reconsider now and
    // then at a junction. This is the only part that is allowed to be coarse —
    // it decides which way the car is going, not where it is.
    if ((state.tick + id) % 3 === 0) {
      // An errand outranks wandering, but not fear: a panicked driver flees
      // wherever the road takes it and picks the route back up on calming
      // down — the repath rule covers however far the flight carried it.
      if (driver.panic === 0 && driver.mission === 'goto' && driver.route) {
        followRoute(map, v, driver);
      }
      if (driver.dir < 0 || !dirIsOpen(map, v.pos.x, v.pos.y, driver.dir)) {
        driver.dir = chooseDir(
          state,
          map,
          v,
          driver.dir < 0 ? nearestCardinal(v.heading) : driver.dir,
        );
      } else if (
        driver.panic === 0 &&
        driver.mission === 'cruise' &&
        (state.tick + id) % t.decisionCadenceTicks < 3
      ) {
        // A panicked driver does not window-shop for turns, and neither does
        // one with somewhere to be: the turn lottery is what makes CRUISE
        // circulate. Both hold their heading and turn only when they must.
        driver.dir = chooseDir(state, map, v, driver.dir);
      }
    }

    // Wheel, pedals and physics: every tick, steering recomputed each time so
    // the car tracks its lane instead of holding a stale wheel for 100 ms.
    const { throttle, steer, personBlocked, heldAtSignal } = laneControl(state, map, v, driver);
    driveVehicle(v, throttle, steer, map, state, state, events, false, 1);

    // Wedged? Count it, and past the limit back out. A driver waiting for
    // somebody to finish crossing gets three times the patience of one nosed
    // into a wall: people move on their own, and a car reversing away from a
    // pedestrian looks deranged.
    //
    // Waiting at a red is not being wedged at all, and must not accumulate.
    // A red runs 114 ticks against a patience of 90, so before this a car
    // that arrived just as the light changed would decide it was stuck and
    // REVERSE out of the queue — which is both absurd to watch and the thing
    // that made every lane behind it worse.
    if (heldAtSignal) {
      if (driver.stuck > 0) driver.stuck--;
      continue;
    }
    const patience = personBlocked ? t.blockedTimeoutTicks * 3 : t.blockedTimeoutTicks;
    if (Math.abs(v.speed) < WEDGED_SPEED) {
      driver.stuck++;
      // Held up by a PERSON, for long enough to be annoyed about it. Only a
      // person: leaning on the horn at a wall is not a thing drivers do, and
      // it would fire constantly in the alleys. Once per press, not once per
      // tick, or a blocked street becomes an air raid.
      if (personBlocked && driver.stuck === t.hornAfterTicks) {
        events.push({
          type: 'horn',
          tick: state.tick,
          x: Math.round(v.pos.x),
          y: Math.round(v.pos.y),
          kind: v.kind,
          playerId: null,
        });
      }
      if (driver.stuck >= patience) driver.stuck = -t.reverseTicks;
    } else if (driver.stuck > 0) {
      driver.stuck--;
    }
  }
}

/**
 * Maintain traffic density near players: spawn ahead of them at the edge of
 * what they can see, despawn what they have left far behind. A flat global
 * count would put two cars in view across a 114-screen city.
 */
/**
 * People getting into cars, and out of them again.
 *
 * Traffic used to spring into existence with its driver already aboard, and a
 * car that stopped being driven simply coasted — nobody was ever seen getting
 * in or out, which is the single biggest reason the crowd and the traffic read
 * as two unrelated simulations sharing a street.
 *
 * Three rules keep this from being expensive:
 *
 *  1. **One rng draw per tick for the whole pool**, not one per candidate.
 *     The draw picks an index into the eligible list, exactly the way
 *     `pickKind` spends one value per spawn.
 *  2. **Collect, then apply.** Boarding removes a ped and alighting inserts
 *     one, both while the other table is being read. Doing either inline
 *     would make the outcome depend on iteration order — the discipline
 *     `stepVehicleDamage` already follows for its detonation list.
 *  3. **Boarding is capped by the traffic target.** Without it, every ped who
 *     got into a car pushed the ambient-driver count past its ceiling and the
 *     population inflated: the spawner only ever counts UP to the target, and
 *     `session.ts` tops the crowd back up behind it.
 */
export function stepBoarding(state: GameState, map: CityMap): void {
  const t = getTrafficTuning();

  // --- who is getting out -------------------------------------------------
  //
  // A driver whose journey has run its course, stopped, AT A PARKING SPOT.
  // That last condition is the whole rule. Without it the first thing that
  // brings a car to a halt after its trip timer expires is a red light — so
  // drivers got out in the queue, left the car standing in the lane, and
  // everything behind them jammed. Traffic under way measured 0.54 down to
  // 0.44 before the spot was required.
  //
  // Parking spots are also where the parked stock the crowd gets INTO lives,
  // so the exchange is symmetric: people get out where cars park, and get in
  // where cars are parked.
  const alighting: number[] = [];
  let aiCount = 0;
  const spotReach = t.boardRadius * t.boardRadius;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId)) continue;
    aiCount++;
    const driver = state.trafficDrivers[id];
    if (!driver || driver.mission !== 'cruise' || driver.panic > 0) continue;
    if (driver.trip < t.tripTicks) continue;
    if (Math.abs(v.speed) > 6) continue;
    let parkable = false;
    for (const spot of map.parkingSpots) {
      const dx = spot.x - v.pos.x;
      const dy = spot.y - v.pos.y;
      if (dx * dx + dy * dy <= spotReach) {
        parkable = true;
        break;
      }
    }
    if (!parkable) continue;
    alighting.push(id);
  }

  // --- who is getting in --------------------------------------------------
  // Parked, empty, intact, and somebody civilian standing at the door.
  const boarding: Array<{ pedId: number; vehicleId: number }> = [];
  if (aiCount - alighting.length < t.count) {
    const reach = t.boardRadius * t.boardRadius;
    const pairs: Array<{ pedId: number; vehicleId: number }> = [];
    for (const pedId of state.peds.ids) {
      const ped = state.peds.byId[pedId];
      if (!ped || ped.mode !== 'walk' || ped.gangId !== 0) continue;
      for (const vid of state.vehicles.ids) {
        const v = state.vehicles.byId[vid];
        if (!v || v.driverId !== null || v.condition !== 'ok') continue;
        const dx = v.pos.x - ped.pos.x;
        const dy = v.pos.y - ped.pos.y;
        if (dx * dx + dy * dy > reach) continue;
        pairs.push({ pedId, vehicleId: vid });
        break; // one car per person; the nearest by id order will do
      }
    }
    if (pairs.length > 0) {
      let roll: number;
      [roll, state.rng] = nextFloat01(state.rng);
      // One boarding at most per tick, and only sometimes: a whole street
      // climbing into cars at once is not a city, it is a fire drill.
      if (roll < t.boardChance) {
        let pick: number;
        [pick, state.rng] = nextIntRange(state.rng, 0, pairs.length);
        boarding.push(pairs[pick] as { pedId: number; vehicleId: number });
      }
    }
  }

  // --- apply, in that order ----------------------------------------------
  for (const id of alighting) {
    const v = state.vehicles.byId[id];
    if (!v) continue;
    if (!ejectDriver(state, map, v, null)) continue;
    v.driverId = null;
    v.speed = 0;
    delete state.trafficDrivers[id];
  }
  for (const b of boarding) {
    const ped = state.peds.byId[b.pedId];
    const v = state.vehicles.byId[b.vehicleId];
    if (!ped || !v || v.driverId !== null) continue;
    removeEntity(state.peds, b.pedId);
    v.driverId = -(1000 + v.id); // the same negative-id convention as spawning
    state.trafficDrivers[v.id] = freshDriver(nearestCardinal(v.heading));
  }
}

export function stepTrafficPopulation(state: GameState, map: CityMap): void {
  const t = getTrafficTuning();
  const spawns = map.vehicleSpawns;
  if (spawns.length === 0) return;

  let aiCount = 0;
  const doomed: number[] = [];
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId)) continue;
    aiCount++;
    let nearest = Infinity;
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p) continue;
      nearest = Math.min(nearest, Math.hypot(p.pos.x - v.pos.x, p.pos.y - v.pos.y));
    }
    // A car on an errand is not set dressing: it despawns when the errand
    // ends, not when nobody happens to be watching it drive there — and that
    // covers standing at the scene of one as much as driving to it.
    const mission = state.trafficDrivers[id]?.mission;
    if (nearest > t.despawnDist && mission !== 'goto' && mission !== 'tend') {
      doomed.push(id);
    }
  }
  // Cull first so the count below reflects the cull.
  for (const id of doomed) {
    const v = state.vehicles.byId[id];
    if (!v) continue;
    v.driverId = null; // becomes an ordinary parked car, then is reused
  }
  aiCount -= doomed.length;

  // Drop bookkeeping for anything that no longer has an ambient driver, so the
  // record cannot grow for the lifetime of the process.
  for (const key of Object.keys(state.trafficDrivers)) {
    const vid = Number(key);
    const v = state.vehicles.byId[vid];
    if (!v || !isAiDriver(v.driverId)) delete state.trafficDrivers[vid];
  }
  // Same for the collision debounce, which is keyed on vehicles that can go
  // away without ever having had an ambient driver.
  for (const key of Object.keys(state.vehicleHitTick)) {
    const vid = Number(key);
    if (!state.vehicles.byId[vid]) delete state.vehicleHitTick[vid];
  }

  if (aiCount >= t.count) return;
  if (state.tick % t.spawnCadenceTicks !== 0) return;
  if (state.players.ids.length === 0) return;

  // Pick a kerbside point in the ring around a player: far enough to be out
  // of sight, near enough to matter.
  let pIdx: number;
  [pIdx, state.rng] = nextIntRange(state.rng, 0, state.players.ids.length);
  const player = state.players.byId[state.players.ids[pIdx] as number];
  if (!player) return;

  let offset: number;
  [offset, state.rng] = nextIntRange(state.rng, 0, spawns.length);
  for (let i = 0; i < spawns.length; i++) {
    const candidate = spawns[(offset + i) % spawns.length];
    if (!candidate) continue;
    const d = Math.hypot(candidate.x - player.pos.x, candidate.y - player.pos.y);
    if (d < t.spawnMinDist || d > t.spawnMaxDist) continue;

    const place = aiSpawnPlacement(state, map, candidate);
    if (!place) continue;
    // The kind is drawn HERE, after the spot is known good, so a rejected
    // candidate costs no random number and the stream stays fixed.
    putAiVehicle(state, pickKind(state), place);
    return;
  }
}

/** Where an AI-driven car goes down, and which way it sets off. */
export interface AiSpawnPlacement {
  x: number;
  y: number;
  /** Cardinal index the driver starts out following. */
  dir: number;
}

/**
 * Vet a kerbside spawn point for an AI car, and say where on it the car goes.
 *
 * A spawn has to face somewhere the car can actually drive, and the car is put
 * down in the LANE it belongs in rather than in the middle of the parking
 * spot: one born on the wrong side of the road spends its first seconds
 * crossing back over. Null when the spot will not take a car.
 *
 * Draws no random numbers and mutates nothing, so a caller may reject the
 * result without disturbing anything.
 */
export function aiSpawnPlacement(
  state: GameState,
  map: CityMap,
  spot: { x: number; y: number; heading: number },
  /**
   * Bearing the car wants to set off along, snapped to the nearest cardinal
   * with road down it. Omit and the spawn point's own heading decides — which
   * is right for ambient traffic, and wrong for anything with an errand: a van
   * put down facing away from the call has to complete a U-turn before it can
   * start, and a U-turn is taken at `turnSpeed`.
   */
  prefer?: number,
): AiSpawnPlacement | null {
  let dirIdx = nearestCardinal(spot.heading);
  if (prefer !== undefined) {
    let bestErr = Infinity;
    let best = -1;
    for (let i = 0; i < 4; i++) {
      if (!dirIsOpen(map, spot.x, spot.y, i)) continue;
      const err = Math.abs(wrapAngle((CARDINAL_ANGLE[i] as number) - prefer));
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best < 0) return null;
    dirIdx = best;
  } else if (!dirIsOpen(map, spot.x, spot.y, dirIdx)) {
    return null;
  }

  const lanes = laneOptions(map, spot.x, spot.y, dirIdx);
  const lane = lanes ? (lanes[0] as number) : null;
  const alongX = dirIdx === 0 || dirIdx === 2;
  const x = lane !== null && !alongX ? lane : spot.x;
  const y = lane !== null && alongX ? lane : spot.y;

  // Never spawn on top of an existing vehicle.
  for (const id of state.vehicles.ids) {
    const other = state.vehicles.byId[id];
    if (!other) continue;
    if (Math.abs(other.pos.x - x) < 30 && Math.abs(other.pos.y - y) < 30) return null;
  }
  return { x, y, dir: dirIdx };
}

/**
 * Put an AI-driven car on the road at a vetted placement, already rolling.
 *
 * Rolling, not stationary, because a car that has to accelerate from rest into
 * a lane it is not yet in reads as broken; and the driver record is created
 * here with the right direction rather than being inferred later from the
 * heading. Returns the new vehicle id.
 */
export function putAiVehicle(
  state: GameState,
  kind: string,
  place: AiSpawnPlacement,
): number {
  const t = getTrafficTuning();
  const id = state.nextEntityId++;
  const v = createVehicle(
    id,
    kind,
    { x: q8(place.x), y: q8(place.y) },
    CARDINAL_ANGLE[place.dir] as number,
  );
  v.speed = q8(t.cruiseSpeed * 0.6);
  v.driverId = -1000 - id; // negative => AI, and never -1
  state.trafficDrivers[id] = freshDriver(place.dir);
  insertEntity(state.vehicles, v);
  return id;
}

/**
 * Panic pass: gunfire and explosions this tick scare every ambient driver
 * within earshot into flooring it away from the noise.
 *
 * Runs AFTER the shooting systems (see step.ts ordering), because traffic
 * itself steps before weapons fire — so a driver reacts on the tick after the
 * bang, exactly one tick of reflex delay. The alternative, reordering traffic
 * after weapons, would let this tick's shots move this tick's cars — and every
 * car the player is following would react to the player's own gun before the
 * tracer had been drawn.
 *
 * Same stimulus model as the pedestrians (peds.ts): collect scare points from
 * the tick's events, nearest scare inside the radius wins. Drivers keep their
 * panic in `trafficDrivers`, so it costs the wire nothing.
 */
export function stepTrafficPanic(
  state: GameState,
  map: CityMap,
  tickEvents: readonly SimEvent[],
): void {
  const t = getTrafficTuning();
  let scares: Array<[number, number]> | null = null;
  for (const ev of tickEvents) {
    if (ev.type === 'shot') (scares ??= []).push([ev.x0, ev.y0]);
    else if (ev.type === 'explosion') (scares ??= []).push([ev.x, ev.y]);
  }
  if (!scares) return;

  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId)) continue;
    const driver = state.trafficDrivers[id];
    if (!driver) continue;
    for (const [sx, sy] of scares) {
      const dx = v.pos.x - sx;
      const dy = v.pos.y - sy;
      if (dx * dx + dy * dy >= t.panicRadius * t.panicRadius) continue;
      driver.panic = t.panicTicks;
      // Flee along the open cardinal pointing most nearly away from the
      // scare. Strict improvement keeps the tie-break on the lowest index,
      // so every host picks the same way out. No rng: panic must not shift
      // the draw stream for everything stepping after it.
      let bestDot = -Infinity;
      for (let i = 0; i < 4; i++) {
        if (!dirIsOpen(map, v.pos.x, v.pos.y, i)) continue;
        const [cx, cy] = CARDINALS[i] as readonly [number, number];
        const dot = cx * dx + cy * dy;
        if (dot > bestDot) {
          bestDot = dot;
          driver.dir = i;
        }
      }
      break;
    }
  }
}

/**
 * Where a person stands when they get out of a car, or null if neither door
 * opens onto anywhere they could stand.
 *
 * Kerb side first, then the other one. A car wedged hard against walls has
 * neither, and squeezing somebody out anyway would push them inside the
 * collision geometry.
 */
function doorSpot(map: CityMap, v: VehicleState): { x: number; y: number; side: number } | null {
  const across = v.heading + HALF_PI;
  const doorDist = getVehicleTuning(v.kind).halfExtent + PED_RADIUS + 2;
  for (const side of [1, -1]) {
    // q8 at birth: they stand still until their first step, and an off-grid
    // position on the wire is a standing hash desync (see the same note on
    // roadblock cars in police.ts).
    const spot = {
      x: q8(v.pos.x + dCos(across) * side * doorDist),
      y: q8(v.pos.y + dSin(across) * side * doorDist),
    };
    if (boxInSolid(map, spot, PED_RADIUS)) continue;
    return { ...spot, side };
  }
  return null;
}

/**
 * Put the driver of `v` on the pavement as a pedestrian, and take their
 * driver record away.
 *
 * `fleeFrom` is somebody to run from — a carjacker — or null for an ordinary
 * end-of-journey, where they simply walk off. Both directions of the
 * ped/vehicle exchange go through this and `boardVehicle` below, so there is
 * one definition of where a body goes when it changes table.
 */
export function ejectDriver(
  state: GameState,
  map: CityMap,
  v: VehicleState,
  fleeFrom: { x: number; y: number } | null,
): boolean {
  const door = doorSpot(map, v);
  if (!door) return false;
  const across = v.heading + HALF_PI;
  const ped = createPed(state.nextEntityId++, door, getTuning().peds.health);
  if (fleeFrom) {
    const dx = door.x - fleeFrom.x;
    const dy = door.y - fleeFrom.y;
    const d = Math.hypot(dx, dy);
    ped.dirX = d > 0.001 ? dx / d : dCos(across) * door.side;
    ped.dirY = d > 0.001 ? dy / d : dSin(across) * door.side;
    ped.mode = 'flee';
    ped.timer = getTuning().peds.fleeTicks;
  } else {
    // Off to whatever they were doing before they got in.
    ped.dirX = dCos(across) * door.side;
    ped.dirY = dSin(across) * door.side;
    ped.mode = 'walk';
    ped.timer = getTuning().peds.turnMinTicks;
  }
  insertEntity(state.peds, ped);
  return true;
}

/**
 * Drag an AI driver out and take the wheel. THE verb the genre is named
 * after, and it could not previously be expressed at all: no vehicle had an
 * occupant, so the only theft in the game was lifting an empty parked car.
 *
 * Returns the ejected driver's spawn position, or null if nothing was jacked.
 */
export function tryCarjack(
  state: GameState,
  map: CityMap,
  playerId: number,
): VehicleState | null {
  const p = state.players.byId[playerId];
  if (!p || p.mode !== 'foot') return null;

  let best: VehicleState | null = null;
  let bestD = Infinity;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId) || v.condition !== 'ok') continue;
    const d = Math.hypot(v.pos.x - p.pos.x, v.pos.y - p.pos.y);
    const reach = getVehicleTuning(v.kind).enterRadius;
    if (d <= reach && d < bestD) {
      best = v;
      bestD = d;
    }
  }
  if (!best) return null;

  best.driverId = playerId;
  delete state.trafficDrivers[best.id];
  best.speed = q8(best.speed * 0.4); // the scramble in costs you momentum

  // The person you dragged from the wheel exists: they land on the ground
  // beside the car and run. ROADMAP.md C2 specified this ("AI driver ejected
  // (becomes a fleeing ped)") and until now the driver simply vanished — the
  // headline verb of the genre played as theft from an empty chair. They try
  // the kerb side first, then the other door, and stay unspawned only if the
  // car is wedged so hard against walls that neither door opens — squeezing a
  // person into a wall would push them inside the collision geometry.
  ejectDriver(state, map, best, { x: p.pos.x, y: p.pos.y });

  p.mode = 'driving';
  p.vehicleId = best.id;
  p.vel.x = 0;
  p.vel.y = 0;
  p.pos.x = best.pos.x;
  p.pos.y = best.pos.y;
  return best;
}
