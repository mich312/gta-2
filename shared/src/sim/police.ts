import { DT, PLAYER_RADIUS } from '../constants.js';
import { q8 } from '../math/vec.js';
import { HALF_PI, PI, dAtan2, dCos, dSin } from '../math/trig.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { CopState, GameState, PlayerState } from './state.js';
import { addHeat, createCop, wantedLevelOf } from './state.js';
import { insertEntity, removeEntity } from './entities.js';
import { createVehicle } from './state.js';
import { stepVehicleDriving } from './vehicle.js';
import { NULL_INPUT, type InputIntent } from './input.js';
import type { SimEvent } from './events.js';
import { applyDamage, rayWallDistance } from './weapons.js';
import type { CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';

/**
 * Wanted levels + deterministic pursuit AI. All in the sim: same seed, same
 * crimes => the same cops spawn at the same spots and make the same moves.
 * Cops steer greedily with wall-slide (the road grid makes this look
 * smarter than it is) and shoot only with line of sight.
 */

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

function hasLineOfSight(map: CityMap, from: CopState, to: PlayerState, range: number): boolean {
  const d = dist(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
  if (d > range) return false;
  if (d === 0) return true;
  const dirX = (to.pos.x - from.pos.x) / d;
  const dirY = (to.pos.y - from.pos.y) / d;
  return rayWallDistance(map, from.pos.x, from.pos.y, dirX, dirY, d) >= d;
}

/** True if any cop currently has line of sight to this player. */
export function anyCopSees(state: GameState, map: CityMap, p: PlayerState): boolean {
  const range = getTuning().police.sightRange;
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (cop && hasLineOfSight(map, cop, p, range)) return true;
  }
  return false;
}

function maybeSpawnCop(state: GameState, map: CityMap): void {
  const t = getTuning().police;
  if (state.cops.ids.length >= t.maxCopsTotal) return;
  // Spacing between arrivals, straight off the tick counter so it needs no
  // state of its own. Checked before any rng draw, so the stream stays fixed.
  if (state.tick % t.spawnCooldownTicks !== 0) return;

  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode === 'dead') continue;
    const wanted = wantedLevelOf(p);
    if (wanted === 0) continue;
    const assigned = state.cops.ids.filter(
      (cid) => state.cops.byId[cid]?.targetId === pid,
    ).length;
    const desired = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
    if (assigned >= desired) continue;

    // Deterministic spawn spot: walk the kerbside spawn list (dense, on
    // roads — cops arrive from the street) from an rng offset and take the
    // first point inside the ring around the fugitive.
    const spawns = map.vehicleSpawns;
    if (spawns.length === 0) return;
    let offset: number;
    [offset, state.rng] = nextIntRange(state.rng, 0, spawns.length);
    for (let i = 0; i < spawns.length; i++) {
      const candidate = spawns[(offset + i) % spawns.length];
      if (!candidate) continue;
      const d = dist(candidate.x, candidate.y, p.pos.x, p.pos.y);
      if (d < t.spawnMinDist || d > t.spawnMaxDist) continue;
      const cop = createCop(state.nextEntityId++, candidate, t.copHealth);
      cop.targetId = pid;
      insertEntity(state.cops, cop);
      // From carsFromStar upward, units ARRIVE by car. Motorising mid-chase
      // instead would drop a cruiser wherever the officer happened to be
      // standing — usually a pavement — where it wedges on the first tick.
      // A kerbside spawn point is on a road by construction.
      if (wanted >= t.carsFromStar) motorise(state, cop, candidate.heading);
      return; // at most one spawn per tick: a ramp, not a wall
    }
    return;
  }
}

function copFire(
  state: GameState,
  map: CityMap,
  cop: CopState,
  target: PlayerState,
  events: SimEvent[],
): void {
  const t = getTuning().police;
  const weapon = getWeaponTuning(t.weapon);
  if (!weapon) return;
  cop.fireCooldown = weapon.cooldownTicks;
  let roll: number;
  [roll, state.rng] = nextFloat01(state.rng);
  const angle =
    dAtan2(target.pos.y - cop.pos.y, target.pos.x - cop.pos.x) +
    (roll - 0.5) * 2 * weapon.spread;
  const dirX = dCos(angle);
  const dirY = dSin(angle);
  const wallDist = rayWallDistance(map, cop.pos.x, cop.pos.y, dirX, dirY, weapon.range);

  // Cops shoot players only (no cop-on-cop friendly fire).
  let hit: PlayerState | null = null;
  let hitDist = wallDist;
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode === 'dead') continue;
    const fx = p.pos.x - cop.pos.x;
    const fy = p.pos.y - cop.pos.y;
    const along = fx * dirX + fy * dirY;
    if (along < 0) continue;
    const perp2 = fx * fx + fy * fy - along * along;
    if (perp2 > PLAYER_RADIUS * PLAYER_RADIUS) continue;
    const d = along - Math.sqrt(PLAYER_RADIUS * PLAYER_RADIUS - perp2);
    if (d < hitDist) {
      hitDist = d;
      hit = p;
    }
  }
  events.push({
    type: 'shot',
    tick: state.tick,
    playerId: -cop.id,
    x0: Math.round(cop.pos.x),
    y0: Math.round(cop.pos.y),
    x1: Math.round(cop.pos.x + dirX * hitDist),
    y1: Math.round(cop.pos.y + dirY * hitDist),
  });
  if (hit) applyDamage(state, hit, weapon.damage, -1, 'police', events);
}

/** Consecutive blocked ticks before an officer abandons their cruiser. */
const STUCK_BAILOUT_TICKS = 25;

/** Cop cruisers are AI-driven like traffic, but with a distinct id band. */
function copDriverId(copId: number): number {
  return -100000 - copId;
}

/** Put an officer behind the wheel of a cruiser, facing along the road. */
function motorise(state: GameState, cop: CopState, heading: number): void {
  const t = getTuning().police;
  let cars = 0;
  for (const id of state.vehicles.ids) {
    if (state.vehicles.byId[id]?.kind === 'copcar') cars++;
  }
  if (cars >= t.maxCopCars) return;

  const id = state.nextEntityId++;
  const v = createVehicle(id, 'copcar', cop.pos, heading);
  v.driverId = copDriverId(cop.id);
  insertEntity(state.vehicles, v);
  cop.vehicleId = id;
}

/**
 * Drive a cruiser at its target. Deliberately cruder than the traffic AI —
 * a pursuit car cuts corners and rams; it is not obeying the road rules.
 */
function drivePursuit(
  state: GameState,
  map: CityMap,
  cop: CopState,
  target: PlayerState,
  events: SimEvent[],
): void {
  if (cop.vehicleId === null) return;
  const v = state.vehicles.byId[cop.vehicleId];
  if (!v || v.condition !== 'ok') {
    // Cruiser destroyed: the officer continues on foot.
    cop.vehicleId = null;
    return;
  }
  const t = getTuning().police;
  const want = dAtan2(target.pos.y - cop.pos.y, target.pos.x - cop.pos.x);
  let delta = want - v.heading;
  while (delta > PI) delta -= PI * 2;
  while (delta < -PI) delta += PI * 2;

  const d = dist(cop.pos.x, cop.pos.y, target.pos.x, target.pos.y);

  // Pull up and finish the job on foot. A cruiser gets an officer across the
  // city; it cannot follow a fugitive into a park interior or a plaza, and
  // without this the motorised response simply circles at a distance and
  // never closes — which is worse than the on-foot posse it replaced.
  if (d <= t.dismountDist) {
    v.driverId = null;
    cop.vehicleId = null;
    cop.stuckTicks = 0;
    return;
  }

  const input: InputIntent = {
    ...NULL_INPUT,
    up: Math.abs(v.speed) < t.copCarSpeed,
    left: delta < -0.06,
    right: delta > 0.06,
  };
  stepVehicleDriving(v, input, map, state, events);

  // "Not closing" rather than merely "not moving": the closing speed is the
  // forward velocity projected onto the direction of the target, so this
  // catches a wedged cruiser AND one orbiting at a constant distance. It has
  // to be SUSTAINED — a car clips a kerb constantly while turning, and
  // bailing on the first blocked tick strips every officer of their car
  // within seconds.
  // Accumulate-and-decay rather than reset: a cruiser nosed into a wall
  // bounces off it (crashDamp), so it alternates closing and not-closing and
  // a hard reset would never reach the threshold. Genuine progress closes on
  // most ticks and drains this back to zero.
  const closing = v.speed * dCos(delta);
  if (closing < 20) cop.stuckTicks += 2;
  else cop.stuckTicks = Math.max(0, cop.stuckTicks - 1);
  if (cop.stuckTicks >= STUCK_BAILOUT_TICKS) {
    v.driverId = null;
    cop.vehicleId = null;
    cop.stuckTicks = 0;
    return;
  }

  // The officer rides with the car.
  cop.pos.x = v.pos.x;
  cop.pos.y = v.pos.y;
  cop.vel.x = 0;
  cop.vel.y = 0;
}

/**
 * Throw two cruisers across the road ahead of a fugitive. Deterministic: the
 * spot is derived from the kerbside spawn list, walked from an rng offset,
 * exactly like ordinary cop spawns.
 */
function maybeRoadblock(state: GameState, map: CityMap, p: PlayerState): void {
  const t = getTuning().police;
  if (state.tick % t.roadblockCooldownTicks !== 0) return;
  if (wantedLevelOf(p) < t.roadblocksFromStar) return;
  let cars = 0;
  for (const id of state.vehicles.ids) {
    if (state.vehicles.byId[id]?.kind === 'copcar') cars++;
  }
  if (cars + 2 > t.maxCopCars + 2) return;

  // Ahead means ahead of travel if moving, otherwise ahead of aim.
  const speed = Math.hypot(p.vel.x, p.vel.y);
  const driving = p.vehicleId !== null ? state.vehicles.byId[p.vehicleId] : null;
  const heading = driving ? driving.heading : speed > 1 ? dAtan2(p.vel.y, p.vel.x) : p.aimAngle;
  const ax = p.pos.x + dCos(heading) * t.roadblockAheadDist;
  const ay = p.pos.y + dSin(heading) * t.roadblockAheadDist;

  const spawns = map.vehicleSpawns;
  if (spawns.length === 0) return;
  let offset: number;
  [offset, state.rng] = nextIntRange(state.rng, 0, spawns.length);
  for (let i = 0; i < spawns.length; i++) {
    const c = spawns[(offset + i) % spawns.length];
    if (!c) continue;
    if (dist(c.x, c.y, ax, ay) > 90) continue;
    // Across the road, not along it.
    const across = heading + HALF_PI;
    for (const side of [-1, 1]) {
      const id = state.nextEntityId++;
      const v = createVehicle(
        id,
        'copcar',
        { x: c.x + dCos(across) * side * 14, y: c.y + dSin(across) * side * 14 },
        across,
      );
      insertEntity(state.vehicles, v);
    }
    return;
  }
}

export function stepPolice(state: GameState, map: CityMap, events: SimEvent[]): void {
  const t = getTuning().police;

  // Wanted levels + decay while unseen.
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p) continue;
    if (p.heat > 0 && !anyCopSees(state, map, p)) {
      p.heat = Math.max(0, p.heat - (t.heatDecayPerSec * DT));
    }
    p.wantedLevel = wantedLevelOf(p);
  }

  maybeSpawnCop(state, map);
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (p && p.mode !== 'dead') maybeRoadblock(state, map, p);
  }

  const toRemove: number[] = [];
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop) continue;
    if (cop.fireCooldown > 0) cop.fireCooldown--;
    if (cop.carHitCooldown > 0) cop.carHitCooldown--;

    // Retarget: nearest living wanted player.
    let target: PlayerState | null = null;
    let bestD = Infinity;
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p || p.mode === 'dead' || wantedLevelOf(p) === 0) continue;
      const d = dist(cop.pos.x, cop.pos.y, p.pos.x, p.pos.y);
      if (d < bestD) {
        bestD = d;
        target = p;
      }
    }

    if (!target) {
      cop.targetId = null;
      cop.vel.x = 0;
      cop.vel.y = 0;
      cop.idleTicks++;
      if (cop.idleTicks >= t.despawnTicks) toRemove.push(cid);
      continue;
    }
    cop.idleTicks = 0;
    cop.targetId = target.id;

    // Escalation by KIND, not just count. Below carsFromStar the response is
    // the on-foot posse it always was; at and above it, officers arrive
    // motorised (see maybeSpawnCop) — which is what stops a car being a
    // guaranteed escape from a force whose top speed was 122 px/s against
    // the player's 330.
    if (cop.vehicleId !== null) {
      drivePursuit(state, map, cop, target, events);
      if (
        cop.fireCooldown === 0 &&
        bestD <= t.fireRange &&
        hasLineOfSight(map, cop, target, t.fireRange)
      ) {
        copFire(state, map, cop, target, events);
      }
      continue;
    }

    // Chase: greedy steering; axis-separated collision gives wall-slide.
    // Staggered 3-tick cadence like peds: NPC motion at 10 Hz, 3x step —
    // interpolation smooths it and delta traffic drops to a third.
    if (bestD > 24 && (state.tick + cid) % 3 === 0) {
      const dirX = (target.pos.x - cop.pos.x) / bestD;
      const dirY = (target.pos.y - cop.pos.y) / bestD;
      cop.vel.x = dirX * t.moveSpeed;
      cop.vel.y = dirY * t.moveSpeed;
      moveWithCollision(map, cop.pos, cop.vel, PLAYER_RADIUS, cop.vel.x * DT * 3, cop.vel.y * DT * 3);
      if (cop.vel.x === 0 && cop.vel.y === 0) {
        // Fully wedged in a corner: deterministic sidestep along a wall.
        let flip: number;
        [flip, state.rng] = nextFloat01(state.rng);
        const side = flip < 0.5 ? 1 : -1;
        const sx = -dirY * side * t.moveSpeed;
        const sy = dirX * side * t.moveSpeed;
        cop.vel.x = sx;
        cop.vel.y = sy;
        moveWithCollision(map, cop.pos, cop.vel, PLAYER_RADIUS, sx * DT * 3, sy * DT * 3);
      }
      cop.pos.x = q8(cop.pos.x);
      cop.pos.y = q8(cop.pos.y);
      cop.vel.x = q8(cop.vel.x);
      cop.vel.y = q8(cop.vel.y);
    } else if (bestD <= 24) {
      cop.vel.x = 0;
      cop.vel.y = 0;
    }

    if (
      cop.fireCooldown === 0 &&
      bestD <= t.fireRange &&
      hasLineOfSight(map, cop, target, t.fireRange)
    ) {
      copFire(state, map, cop, target, events);
    }
  }
  for (const cid of toRemove) {
    const cop = state.cops.byId[cid];
    if (cop && cop.vehicleId !== null) {
      const v = state.vehicles.byId[cop.vehicleId];
      if (v) v.driverId = null; // abandoned cruiser, still a car
    }
    removeEntity(state.cops, cid);
  }
}
