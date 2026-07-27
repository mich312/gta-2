import { DT } from '../constants.js';
import { HALF_PI, PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { q8, q256 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTrafficTuning, getVehicleTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { T_ROAD, TILE_SIZE, type CityMap } from '../world/types.js';
import { stepVehicleDriving } from './vehicle.js';
import type { InputIntent } from './input.js';
import { NULL_INPUT } from './input.js';
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
 * Traffic steers by probing the road grid rather than following a graph: look
 * ahead along the current heading, and at a junction pick a legal turn. The
 * grid does the heavy lifting, the same trick the police AI uses.
 *
 * Cars move on the same staggered 3-tick cadence as pedestrians and cops:
 * NPC motion at 10 Hz, interpolated smooth on the client, at a third of the
 * delta traffic. That is what keeps a city's worth of moving vehicles inside
 * the bandwidth gate.
 */

/** AI drivers are negative ids; -1 is reserved for "the streets". */
export function isAiDriver(driverId: number | null): boolean {
  return driverId !== null && driverId < -1;
}

function isRoadAt(map: CityMap, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
  return map.tiles[ty * map.widthTiles + tx] === T_ROAD;
}

/** Is anything solid or occupied directly ahead? */
function blockedAhead(state: GameState, map: CityMap, v: VehicleState, dist: number): boolean {
  const ax = v.pos.x + dCos(v.heading) * dist;
  const ay = v.pos.y + dSin(v.heading) * dist;
  if (!isRoadAt(map, ax, ay)) return true;
  const half = getVehicleTuning(v.kind).halfExtent * 2;
  for (const id of state.vehicles.ids) {
    if (id === v.id) continue;
    const other = state.vehicles.byId[id];
    if (!other) continue;
    if (Math.abs(other.pos.x - ax) < half && Math.abs(other.pos.y - ay) < half) return true;
  }
  return false;
}

/**
 * One tick of ambient traffic. Runs before player movement is integrated so
 * an AI car and a player car resolve their overlap the same way any two
 * vehicles do.
 */
export function stepTraffic(
  state: GameState,
  map: CityMap,
  events: SimEvent[],
): void {
  const t = getTrafficTuning();

  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || !isAiDriver(v.driverId)) continue;

    // A burning or wrecked car has no driver left worth simulating.
    if (v.condition !== 'ok') {
      v.driverId = null;
      continue;
    }

    // 10 Hz, staggered by id — the same cadence peds and cops use, for the
    // same reason: NPC motion does not need 30 Hz and the wire does not want
    // to pay for it.
    if ((state.tick + id) % 3 !== 0) continue;

    let steer = 0;
    let throttle = 1;

    const lookAhead = t.lookAhead + Math.abs(v.speed) * t.brakeDistancePerSpeed;
    if (blockedAhead(state, map, v, lookAhead)) {
      throttle = -1; // brake
    }

    // Junction decisions on a fixed cadence, so a car does not dither at
    // every crossroad it clips.
    if ((state.tick + id) % t.decisionCadenceTicks < 3) {
      const left = { x: v.pos.x + dCos(v.heading - HALF_PI) * t.turnProbe, y: v.pos.y + dSin(v.heading - HALF_PI) * t.turnProbe };
      const right = { x: v.pos.x + dCos(v.heading + HALF_PI) * t.turnProbe, y: v.pos.y + dSin(v.heading + HALF_PI) * t.turnProbe };
      const straight = isRoadAt(
        map,
        v.pos.x + dCos(v.heading) * t.turnProbe,
        v.pos.y + dSin(v.heading) * t.turnProbe,
      );
      const canLeft = isRoadAt(map, left.x, left.y);
      const canRight = isRoadAt(map, right.x, right.y);

      let roll: number;
      [roll, state.rng] = nextFloat01(state.rng);
      if (!straight && (canLeft || canRight)) {
        // Forced turn at a T-junction or dead end.
        const goLeft = canLeft && (!canRight || roll < 0.5);
        v.heading = q256(wrapAngle(v.heading + (goLeft ? -HALF_PI : HALF_PI)));
      } else if ((canLeft || canRight) && roll < t.turnChance) {
        const goLeft = canLeft && (!canRight || roll < t.turnChance / 2);
        v.heading = q256(wrapAngle(v.heading + (goLeft ? -HALF_PI : HALF_PI)));
      } else if (!straight && !canLeft && !canRight) {
        // Cul-de-sac: turn around.
        v.heading = q256(wrapAngle(v.heading + PI));
      }
    }

    // Lane keeping: nudge back toward the centreline of the road tile.
    const cx = (Math.floor(v.pos.x / TILE_SIZE) + 0.5) * TILE_SIZE;
    const cy = (Math.floor(v.pos.y / TILE_SIZE) + 0.5) * TILE_SIZE;
    const nx = -dSin(v.heading);
    const ny = dCos(v.heading);
    const lateral = (cx - v.pos.x) * nx + (cy - v.pos.y) * ny;
    if (Math.abs(lateral) > t.laneHalfWidth) steer = lateral > 0 ? 1 : -1;

    // Cap ambient speed well below the player's top end: traffic should be
    // overtakeable, and a city of cars all doing 330 is not a city.
    const cruise = t.cruiseSpeed;
    if (throttle > 0 && v.speed >= cruise) throttle = 0;

    const input: InputIntent = {
      ...NULL_INPUT,
      up: throttle > 0,
      down: throttle < 0,
      left: steer < 0,
      right: steer > 0,
    };
    // Three ticks of driving in one, matching the cadence gate above.
    for (let i = 0; i < 3; i++) stepVehicleDriving(v, input, map, state, events);
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
    if (v) v.driverId = null; // becomes an ordinary parked car, then is reused
  }
  aiCount -= doomed.length;

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

    // Never spawn on top of an existing vehicle.
    let clear = true;
    for (const id of state.vehicles.ids) {
      const other = state.vehicles.byId[id];
      if (!other) continue;
      if (Math.abs(other.pos.x - candidate.x) < 30 && Math.abs(other.pos.y - candidate.y) < 30) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    // Reuse a parked car standing at that spot if there is one; otherwise
    // take over the nearest idle vehicle so the table does not grow forever.
    const id = state.nextEntityId++;
    const v: VehicleState = {
      id,
      kind: 'car',
      pos: { x: q8(candidate.x), y: q8(candidate.y) },
      heading: q256(candidate.heading),
      speed: q8(getTrafficTuning().cruiseSpeed * 0.6),
      driverId: -1000 - id, // negative => AI, and never -1
      health: getVehicleTuning('car').health,
      condition: 'ok',
      fuseAtTick: null,
    };
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
  best.speed = q8(best.speed * 0.4); // the scramble in costs you momentum
  p.mode = 'driving';
  p.vehicleId = best.id;
  p.vel.x = 0;
  p.vel.y = 0;
  p.pos.x = best.pos.x;
  p.pos.y = best.pos.y;
  return best;
}
