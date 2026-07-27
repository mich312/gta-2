import { HALF_PI, PI, dAtan2, dCos, dSin, wrapAngle } from '../math/trig.js';
import { clamp, q8 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTrafficTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, TrafficDriver, VehicleState } from './state.js';
import { createVehicle } from './state.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import {
  CARDINALS,
  CARDINAL_ANGLE,
  dirIsOpen,
  drivableAt,
  drivableTile,
  nearestCardinal,
} from './roadgrid.js';
import { isSolidAtWorld } from '../world/collide.js';
import { driveVehicle } from './vehicle.js';
import type { SimEvent } from './events.js';

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
 * Decisions run on the same staggered 3-tick cadence as pedestrians and cops
 * (NPC thinking at 10 Hz), while the physics still integrates every tick and
 * the client interpolates it smooth. That is what keeps a city's worth of
 * moving vehicles inside the bandwidth gate.
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
/** Heading error past which a driver lifts off and takes the corner slowly. */
const TURN_ERROR = 0.35;
/** Speed below which a car that ought to be moving counts as wedged. */
const WEDGED_SPEED = 12;

/** AI drivers are negative ids; -1 is reserved for "the streets". */
export function isAiDriver(driverId: number | null): boolean {
  return driverId !== null && driverId < -1;
}

/**
 * The two lane centres of the carriageway under the car, measured across the
 * direction of travel: `keep` is the right-hand lane, where it belongs, and
 * `other` is the oncoming half — available for an overtake and nothing else.
 *
 * Null when the car is not on a road at all, which is the signal to hold the
 * current heading rather than steer at a phantom lane.
 */
function laneCentres(
  map: CityMap,
  x: number,
  y: number,
  dirIdx: number,
): { keep: number; other: number } | null {
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

  const centre = ((lo + hi + 1) / 2) * TILE_SIZE;
  const halfWidth = ((hi - lo + 1) / 2) * TILE_SIZE;
  // A one-tile lane has no sides to keep to: everybody shares the middle.
  const offset = hi === lo ? 0 : halfWidth / 2;
  const sign = RIGHT_SIGN[dirIdx] as number;
  return { keep: centre + sign * offset, other: centre - sign * offset };
}

/** Is another vehicle sitting on this point? */
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
): { throttle: number; steer: number } {
  const t = getTrafficTuning();
  const dirIdx = driver.dir >= 0 ? driver.dir : nearestCardinal(v.heading);
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const alongX = dirIdx === 0 || dirIdx === 2;

  // Aim a short way down the lane. Short, because the pursuit point is what
  // sets the turn radius, and a distant one reads as a wide lazy arc that
  // leaves the road entirely on a 32 px street.
  let targetX = v.pos.x + dx * t.lookAhead;
  let targetY = v.pos.y + dy * t.lookAhead;

  const lanes = laneCentres(map, v.pos.x, v.pos.y, dirIdx);
  if (!drivableAt(map, v.pos.x, v.pos.y)) {
    // Off the carriageway: get back on it before worrying about which side.
    const back = recoverTarget(map, v.pos.x, v.pos.y);
    if (back) {
      targetX = back.x;
      targetY = back.y;
    }
  } else if (lanes) {
    // Overtake: if our own lane is occupied ahead and the other half of the
    // road is clear, use it. A parked car is 18 px wide in a 16 px lane, so
    // without this every one of them is a permanent roadblock.
    //
    // Looked for further ahead than the car is steering — a lane change wants
    // to start before the obstacle is on the bumper, or it becomes a stop
    // followed by a shuffle.
    const scan = t.lookAhead + Math.abs(v.speed) * t.brakeDistancePerSpeed;
    const probeX = v.pos.x + dx * scan;
    const probeY = v.pos.y + dy * scan;
    const keepX = alongX ? probeX : lanes.keep;
    const keepY = alongX ? lanes.keep : probeY;
    const otherX = alongX ? probeX : lanes.other;
    const otherY = alongX ? lanes.other : probeY;
    const useOther =
      vehicleAt(state, v, keepX, keepY) &&
      drivableAt(map, otherX, otherY) &&
      !vehicleAt(state, v, otherX, otherY);
    if (alongX) targetY = useOther ? lanes.other : lanes.keep;
    else targetX = useOther ? lanes.other : lanes.keep;
  }

  const err = wrapAngle(dAtan2(targetY - v.pos.y, targetX - v.pos.x) - v.heading);
  const steer = clamp(err * t.steerGain, -1, 1);

  // What is in the way, measured along the nose rather than along the lane:
  // this part is about not hitting things, not about where we want to be. Only
  // buildings, water and other cars stop a car — kerbs and grass do not, and
  // braking for them is what left the old traffic parked at every junction it
  // clipped a corner of.
  const half = getVehicleTuning(v.kind).halfExtent;
  const cos = dCos(v.heading);
  const sin = dSin(v.heading);
  const gap = half + t.brakeDistance + Math.abs(v.speed) * t.brakeDistancePerSpeed;
  const solid = isSolidAtWorld(map, v.pos.x + cos * (half + 5), v.pos.y + sin * (half + 5));
  const blocked = solid || vehicleAt(state, v, v.pos.x + cos * gap, v.pos.y + sin * gap);

  // Corner speed. `turnSpeed` has sat in the tuning file since the beginning
  // with nothing reading it; this is what it was for.
  const cruise = Math.abs(err) > TURN_ERROR ? t.turnSpeed : t.cruiseSpeed;

  let throttle = 1;
  if (blocked) {
    // Brake — and once stopped, hold the car still rather than leaning on the
    // pedal, because past a standstill "brake" means "reverse".
    throttle = v.speed > WEDGED_SPEED ? -1 : 0;
  } else if (v.speed >= cruise) {
    throttle = v.speed > cruise * 1.25 ? -0.6 : 0;
  }
  return { throttle, steer };
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

    // 10 Hz decisions, staggered by id.
    if ((state.tick + id) % 3 !== 0) continue;

    let driver = state.trafficDrivers[id];
    if (!driver) {
      driver = { dir: nearestCardinal(v.heading), stuck: 0 };
      state.trafficDrivers[id] = driver;
    }

    if (driver.stuck < 0) {
      // Backing out of somewhere. Bounded: it ends, and the driver then picks
      // a fresh direction from wherever it managed to reach. This is the only
      // path in the whole system that ever selects reverse.
      driver.stuck++;
      for (let i = 0; i < 3; i++) driveVehicle(v, -1, 0, map, state, events, false, 1);
      if (driver.stuck === 0) driver.dir = chooseDir(state, map, v, nearestCardinal(v.heading));
      continue;
    }

    // Routing: hold the current intent while it still leads somewhere, re-pick
    // the moment it does not, and reconsider now and then at a junction.
    if (driver.dir < 0 || !dirIsOpen(map, v.pos.x, v.pos.y, driver.dir)) {
      driver.dir = chooseDir(state, map, v, driver.dir < 0 ? nearestCardinal(v.heading) : driver.dir);
    } else if ((state.tick + id) % t.decisionCadenceTicks < 3) {
      driver.dir = chooseDir(state, map, v, driver.dir);
    }

    // Three physics ticks, steering recomputed for each so the car tracks its
    // lane instead of holding a stale wheel for 100 ms.
    for (let i = 0; i < 3; i++) {
      const ctrl = laneControl(state, map, v, driver);
      driveVehicle(v, ctrl.throttle, ctrl.steer, map, state, events, false, 1);
    }

    // Wedged? Count it, and past the limit back out.
    if (Math.abs(v.speed) < WEDGED_SPEED) {
      driver.stuck++;
      if (driver.stuck >= t.blockedTimeoutTicks) driver.stuck = -t.reverseTicks;
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
    if (nearest > t.despawnDist) doomed.push(id);
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

    // A spawn has to face somewhere the car can actually drive, and the car is
    // put down in the lane it belongs in rather than in the middle of the
    // parking spot: one born on the wrong side of the road spends its first
    // seconds crossing back over, which is the very thing this pass is about.
    const dirIdx = nearestCardinal(candidate.heading);
    if (!dirIsOpen(map, candidate.x, candidate.y, dirIdx)) continue;
    const lanes = laneCentres(map, candidate.x, candidate.y, dirIdx);
    const alongX = dirIdx === 0 || dirIdx === 2;
    const x = lanes && !alongX ? lanes.keep : candidate.x;
    const y = lanes && alongX ? lanes.keep : candidate.y;

    // Never spawn on top of an existing vehicle.
    let clear = true;
    for (const id of state.vehicles.ids) {
      const other = state.vehicles.byId[id];
      if (!other) continue;
      if (Math.abs(other.pos.x - x) < 30 && Math.abs(other.pos.y - y) < 30) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    const id = state.nextEntityId++;
    const v = createVehicle(id, 'car', { x: q8(x), y: q8(y) }, CARDINAL_ANGLE[dirIdx] as number);
    v.speed = q8(t.cruiseSpeed * 0.6);
    v.driverId = -1000 - id; // negative => AI, and never -1
    state.trafficDrivers[id] = { dir: dirIdx, stuck: 0 };
    state.vehicles.ids.push(id);
    state.vehicles.ids.sort((a, b) => a - b);
    state.vehicles.byId[id] = v;
    return;
  }
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
  void map;
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
  p.mode = 'driving';
  p.vehicleId = best.id;
  p.vel.x = 0;
  p.vel.y = 0;
  p.pos.x = best.pos.x;
  p.pos.y = best.pos.y;
  return best;
}
