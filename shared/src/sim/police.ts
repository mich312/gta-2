import { DT, PLAYER_RADIUS } from '../constants.js';
import { clamp, q8 } from '../math/vec.js';
import { HALF_PI, PI, dAtan2, dCos, dSin, wrapAngle } from '../math/trig.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { CopState, GameState, PlayerState, VehicleState } from './state.js';
import { addHeat, createCop, wantedLevelOf, POWER_INVISIBLE, POWER_JAIL_CARD } from './state.js';
import { insertEntity, removeEntity } from './entities.js';
import { createVehicle } from './state.js';
import { driveVehicle } from './vehicle.js';
import type { SimEvent } from './events.js';
import { applyDamage, bustPlayer, damageCop, rayWallDistance } from './weapons.js';
import { isFriendly } from './respect.js';
import { gangAt } from '../world/turf.js';
import type { CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';
import { CARDINAL_ANGLE, dirIsOpen, nearestCardinal } from './roadgrid.js';

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

/**
 * Which force answers a given wanted level, and what it is made of.
 *
 * The ladder is the point: at the bottom it is patrol officers with sidearms,
 * and at the top it is the army with rifles. More of the same is not
 * escalation — a fifth patrolman is the same problem as the fourth.
 */
export function copKindFor(wanted: number): string {
  const t = getTuning().police;
  if (wanted <= 0) return t.tiers[0] ?? 'patrol';
  return t.tiers[Math.min(t.tiers.length, wanted) - 1] ?? 'patrol';
}

function copStats(kind: string): { health: number; weapon: string; moveSpeed: number } {
  const t = getTuning().police;
  // Fall back to the flat numbers so a police.json without a `kinds` block
  // still produces a working force rather than an invisible one.
  return t.kinds[kind] ?? { health: t.copHealth, weapon: t.weapon, moveSpeed: t.moveSpeed };
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
      const kind = copKindFor(wanted);
      const stats = copStats(kind);
      const cop = createCop(state.nextEntityId++, candidate, stats.health, kind);
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

/**
 * Arrest instead of shoot, when the officer is close enough to put hands on
 * a player who is on foot and not going anywhere fast.
 *
 * This is the risk calculus the whole mechanic rests on: standing still next
 * to an officer is survivable and expensive, running is dangerous and keeps
 * your multiplier. Only officers on foot make arrests — a cruiser at speed
 * has nobody to get out and do it.
 *
 * Returns true when the arrest lands, in which case the caller must not also
 * fire: one officer, one action per cadence.
 */
function tryBust(state: GameState, cop: CopState, target: PlayerState, events: SimEvent[]): boolean {
  const t = getTuning().police;
  if (target.mode !== 'foot') return false;
  if (dist(cop.pos.x, cop.pos.y, target.pos.x, target.pos.y) > t.bustRadius) return false;
  const speed = Math.sqrt(target.vel.x * target.vel.x + target.vel.y * target.vel.y);
  if (speed > t.bustSpeedMax) return false;
  // The card is spent here, not at the station: it buys you the walk away,
  // and the heat goes with it.
  if ((target.powerFlags & POWER_JAIL_CARD) !== 0) {
    target.powerFlags &= ~POWER_JAIL_CARD;
    target.heat = 0;
    target.wantedLevel = 0;
    events.push({ type: 'jailCardUsed', tick: state.tick, playerId: target.id });
    return true;
  }
  bustPlayer(state, target, cop.id, events);
  return true;
}

function copFire(
  state: GameState,
  map: CityMap,
  cop: CopState,
  target: PlayerState,
  events: SimEvent[],
): void {
  const t = getTuning().police;
  const weapon = getWeaponTuning(copStats(cop.kind).weapon) ?? getWeaponTuning(t.weapon);
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

/**
 * Cruiser trouble, measured in `cop.stuckTicks`.
 *
 * The counter accumulates while a cruiser is not gaining on its target and
 * drains while it is, because a car clips a kerb constantly during a chase and
 * reacting to a single blocked tick strips every officer of their car within
 * seconds. Two thresholds: back out of whatever it is nosed into, and — if
 * that does not help — abandon the car and continue on foot.
 *
 * While the counter is NEGATIVE the cruiser is mid-reverse; it counts up to
 * zero and then rejoins the chase. Same idiom as ambient traffic.
 */
const STUCK_REVERSE_TICKS = 12;
const STUCK_BAILOUT_TICKS = 45;
/** How long a recovery reverse lasts. Bounded, like traffic's. */
const REVERSE_TICKS = 9;
/** Where the counter resumes after a reverse: one chance, then bail out. */
const STUCK_AFTER_REVERSE = STUCK_BAILOUT_TICKS - 6;
/** Steering per radian of heading error, before clamping to full lock. */
const PURSUIT_STEER_GAIN = 3;
/** Heading error past which a cruiser needs a U-turn rather than a corner. */
const PURSUIT_UTURN_ERROR = 2;
/** Speed it takes that U-turn at, so the radius fits inside a street. */
const PURSUIT_UTURN_SPEED = 24;
/** Below this speed a cruiser that ought to be moving is wedged. */
const PURSUIT_WEDGED_SPEED = 12;
/** How far ahead the direct line to the target is checked for a wall. */
const PURSUIT_CLEAR_LOOK = 96;
/** Multiple of `dismountDist` within which a walled-off target is walked to. */
const PURSUIT_FOOT_DIST_FACTOR = 2;

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
 * The direction a cruiser should point when the straight line to its target
 * runs through a building: whichever cardinal has road down it and comes
 * closest to the bearing of the target, with a nudge in favour of carrying
 * straight on so a cruiser does not dither at a junction.
 *
 * This is the whole of the pursuit "route planner", and deliberately so — the
 * road grid is regular enough that greedy is indistinguishable from clever
 * over the two or three blocks a chase lasts.
 */
function detourDir(map: CityMap, v: VehicleState, want: number): number | null {
  const current = nearestCardinal(v.heading);
  let best: number | null = null;
  let bestErr = Infinity;
  for (let i = 0; i < 4; i++) {
    if (!dirIsOpen(map, v.pos.x, v.pos.y, i)) continue;
    const err =
      Math.abs(wrapAngle((CARDINAL_ANGLE[i] as number) - want)) - (i === current ? 0.25 : 0);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

/**
 * Drive a cruiser at its target. Deliberately cruder than the traffic AI — a
 * pursuit car cuts corners, uses both lanes and rams; it is not obeying the
 * road rules. It does, however, have to be able to drive.
 *
 * What it did before: full throttle whenever it was under the speed limit and
 * a bang-bang wheel with a 0.06 rad deadband, aimed straight at the target
 * whatever stood between them. So a cruiser that arrived facing the wrong way
 * drove a wide circle instead of turning round, one nosed into a wall sat
 * there bouncing off it, and one with a building between it and the fugitive
 * drove into that building until the bail-out took its car away. The
 * motorised response mostly consisted of officers losing their cars.
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
  const d = dist(cop.pos.x, cop.pos.y, target.pos.x, target.pos.y);

  /** The officer rides with the car. */
  const ride = (): void => {
    cop.pos.x = v.pos.x;
    cop.pos.y = v.pos.y;
    cop.vel.x = 0;
    cop.vel.y = 0;
  };

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

  // Backing out of whatever it got wedged in. Reversing inverts the steering,
  // so the wheel goes the other way to swing the nose towards the target.
  if (cop.stuckTicks < 0) {
    cop.stuckTicks++;
    const away = wrapAngle(want - v.heading);
    driveVehicle(v, -1, away > 0 ? -1 : 1, map, state, state, events, false, 1);
    if (cop.stuckTicks === 0) cop.stuckTicks = STUCK_AFTER_REVERSE;
    ride();
    return;
  }

  // Aim at the target, unless there is a building in the way — then follow the
  // road grid around it rather than driving into it.
  const look = Math.min(d, PURSUIT_CLEAR_LOOK);
  const blocked = rayWallDistance(map, v.pos.x, v.pos.y, dCos(want), dSin(want), look) < look;

  // Close, but with a wall in between: the fugitive is inside a building, a
  // plaza or a park interior, and no amount of driving will help. Park it and
  // go in on foot. Without this an officer circles the block indefinitely —
  // never near enough to dismount, never blocked enough to give up on the car.
  if (blocked && d <= t.dismountDist * PURSUIT_FOOT_DIST_FACTOR) {
    v.driverId = null;
    cop.vehicleId = null;
    cop.stuckTicks = 0;
    return;
  }
  let aim = want;
  if (blocked) {
    const dir = detourDir(map, v, want);
    if (dir !== null) aim = CARDINAL_ANGLE[dir] as number;
  }
  const err = wrapAngle(aim - v.heading);

  // Ease off for a corner: a cruiser cannot turn at 300 px/s, and a chase that
  // understeers past every junction never catches anybody. Pointing the wrong
  // way entirely means a U-turn, and the turn radius is speed/turnRate — so
  // walking pace and full lock comes round inside a two-tile street, where
  // 300 px/s would describe a circle the width of a block.
  const absErr = Math.abs(err);
  const cruise =
    absErr > PURSUIT_UTURN_ERROR
      ? PURSUIT_UTURN_SPEED
      : t.copCarSpeed * (absErr > 1.2 ? 0.3 : absErr > 0.5 ? 0.6 : 1);
  const throttle = v.speed < cruise ? 1 : v.speed > cruise * 1.2 ? -1 : 0;
  const steer = clamp(err * PURSUIT_STEER_GAIN, -1, 1);
  driveVehicle(v, throttle, steer, map, state, state, events, false, 1);

  // "Not closing" rather than merely "not moving": closing speed is the
  // forward velocity projected onto the bearing of the TARGET, not of the
  // detour, so an honest drive round a block still counts as making no
  // progress — it just counts slowly, while being wedged counts fast.
  const closing = v.speed * dCos(wrapAngle(want - v.heading));
  if (throttle > 0 && Math.abs(v.speed) < PURSUIT_WEDGED_SPEED) {
    cop.stuckTicks += 3;
    if (cop.stuckTicks >= STUCK_REVERSE_TICKS && cop.stuckTicks < STUCK_BAILOUT_TICKS) {
      cop.stuckTicks = -REVERSE_TICKS;
      ride();
      return;
    }
  } else if (closing < 10) {
    cop.stuckTicks += 1;
  } else {
    cop.stuckTicks = Math.max(0, cop.stuckTicks - 2);
  }
  if (cop.stuckTicks >= STUCK_BAILOUT_TICKS) {
    v.driverId = null;
    cop.vehicleId = null;
    cop.stuckTicks = 0;
    return;
  }

  ride();
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
    // Across the road, not along it. Quantised at birth: a roadblock car
    // parks and never moves, so nothing downstream ever q8s its position —
    // and an off-grid value on the wire is a permanent hash desync for every
    // client that can see it (the codec's whole contract is that the sim
    // only ships grid values).
    const across = heading + HALF_PI;
    for (const side of [-1, 1]) {
      const id = state.nextEntityId++;
      const v = createVehicle(
        id,
        'copcar',
        { x: q8(c.x + dCos(across) * side * 14), y: q8(c.y + dSin(across) * side * 14) },
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
      // Invisible suspects are not acquired. Officers already chasing lose
      // the target too — that is the point of the power-up.
      if ((p.powerFlags & POWER_INVISIBLE) !== 0) continue;
      const d = dist(cop.pos.x, cop.pos.y, p.pos.x, p.pos.y);
      if (d < bestD) {
        bestD = d;
        target = p;
      }
    }

    // A gang that owes you does not stand by while you are chased across
    // their ground: their people shoot at the officers instead. This is the
    // originals' "gangs protect you from the police", and it costs nothing
    // extra — the hostility machinery already exists, pointed the other way.
    if (target && isFriendly(target, gangAt(map, cop.pos.x, cop.pos.y))) {
      const rt = getTuning().respect;
      const weapon = getWeaponTuning(rt.gangWeapon);
      if (weapon && state.tick % rt.gangFireCooldownTicks === cop.id % rt.gangFireCooldownTicks) {
        for (const pedId of state.peds.ids) {
          const ped = state.peds.byId[pedId];
          if (!ped || ped.gangId === 0) continue;
          if (gangAt(map, ped.pos.x, ped.pos.y) !== ped.gangId) continue;
          if (!isFriendly(target, ped.gangId)) continue;
          const d = dist(ped.pos.x, ped.pos.y, cop.pos.x, cop.pos.y);
          if (d > rt.gangFireRange) continue;
          damageCop(state, cop, weapon.damage, target.id, events);
          break; // one volley per officer per cadence
        }
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
    //
    // Every tick, not the staggered 10 Hz the crowd uses. An officer runs at
    // 122 px/s, so stepping three ticks at once and standing still for the
    // other two moved him in twelve-pixel jumps — and a pursuer is the one NPC
    // the player is watching most closely. There are only ever a handful of
    // them on foot, so the delta traffic this costs is nothing; the 200-strong
    // crowd is where that argument still bites, and it keeps its 10 Hz.
    if (bestD > 24) {
      const moveSpeed = copStats(cop.kind).moveSpeed;
      const dirX = (target.pos.x - cop.pos.x) / bestD;
      const dirY = (target.pos.y - cop.pos.y) / bestD;
      cop.vel.x = dirX * moveSpeed;
      cop.vel.y = dirY * moveSpeed;
      moveWithCollision(map, cop.pos, cop.vel, PLAYER_RADIUS, cop.vel.x * DT, cop.vel.y * DT);
      if (cop.vel.x === 0 && cop.vel.y === 0) {
        // Fully wedged in a corner: deterministic sidestep along a wall.
        let flip: number;
        [flip, state.rng] = nextFloat01(state.rng);
        const side = flip < 0.5 ? 1 : -1;
        const sx = -dirY * side * moveSpeed;
        const sy = dirX * side * moveSpeed;
        cop.vel.x = sx;
        cop.vel.y = sy;
        moveWithCollision(map, cop.pos, cop.vel, PLAYER_RADIUS, sx * DT, sy * DT);
      }
      cop.pos.x = q8(cop.pos.x);
      cop.pos.y = q8(cop.pos.y);
      cop.vel.x = q8(cop.vel.x);
      cop.vel.y = q8(cop.vel.y);
    } else {
      cop.vel.x = 0;
      cop.vel.y = 0;
    }

    // Hands before bullets: an officer within reach of a stationary suspect
    // arrests them. Checked before the fire test so a point-blank cop never
    // shoots somebody they could have taken in.
    if (cop.fireCooldown === 0 && tryBust(state, cop, target, events)) {
      cop.fireCooldown = getWeaponTuning(copStats(cop.kind).weapon)?.cooldownTicks ?? 0;
      continue;
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
