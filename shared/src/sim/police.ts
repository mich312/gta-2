import { DT, PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { clamp, q8 } from '../math/vec.js';
import { HALF_PI, PI, dAtan2, dCos, dSin, wrapAngle } from '../math/trig.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { CopKindTuning } from '../tuning.js';
import type { CopState, GameState, PlayerState, VehicleState } from './state.js';
import {
  addHeat,
  createCop,
  wantedLevelOf,
  POWER_INVISIBLE,
  POWER_JAIL_CARD,
  UNSEEN_CAP,
} from './state.js';
import { insertEntity, removeEntity } from './entities.js';
import { createVehicle } from './state.js';
import { driveVehicle, vehiclesOverlap } from './vehicle.js';
import type { SimEvent } from './events.js';
import { applyDamage, bustPlayer, copIsDown, damageCop, rayWallDistance } from './weapons.js';
import { isFriendly } from './respect.js';
import { gangAt } from '../world/turf.js';
import type { CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';
import { pushOutOfVehicles } from './bodies.js';
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
    // A body witnesses nothing. Without this the officer you just shot went on
    // reporting your car thefts from the pavement for the next forty seconds.
    if (cop && !copIsDown(cop) && copSees(map, cop, p, range)) return true;
  }
  return false;
}

/**
 * Whether this officer can see that player, allowing for the one thing that
 * makes somebody unseeable regardless of geometry.
 *
 * Invisibility already dropped a pursuit at the retarget step; it has to drop
 * *sight* too, or an invisible fugitive standing in the open kept the
 * cool-down clock pinned at zero and could never lose the heat they took the
 * power-up to lose.
 */
function copSees(map: CityMap, cop: CopState, p: PlayerState, range: number): boolean {
  if ((p.powerFlags & POWER_INVISIBLE) !== 0) return false;
  return hasLineOfSight(map, cop, p, range);
}

/**
 * Is this player getting away, and for how long have they been?
 *
 * `unseenTicks` is the whole of P1b: the counter resets to 0 on any officer's
 * line of sight and otherwise climbs, and everything downstream — whether the
 * heat decays, how fast, and whether the dispatcher sends anybody new — reads
 * it rather than asking "is somebody looking at them right now".
 *
 * Called once per player per tick, before anything that reads the result.
 */
function updateSight(state: GameState, map: CityMap, p: PlayerState): void {
  // The clock runs only while there is something for it to decide. With no
  // heat there is nothing to decay and nobody to call off, so it parks at
  // zero — which matters on the wire rather than in the sim: a counter that
  // ticked regardless would put a player-table delta on every frame for
  // every player standing still doing nothing, which is most of them, most
  // of the time. There is a test.
  if (p.heat <= 0) {
    p.unseenTicks = 0;
    return;
  }
  if (anyCopSees(state, map, p)) {
    p.unseenTicks = 0;
    return;
  }
  if (p.unseenTicks < UNSEEN_CAP) p.unseenTicks++;
}

/** True while nobody official has had eyes on this player for long enough. */
export function isCoolingDown(p: PlayerState): boolean {
  return p.unseenTicks >= getTuning().police.wantedCooldownTicks;
}

/**
 * The radio.
 *
 * A unit is dispatched to where the suspect was reported, and by the time it
 * has driven three streets the suspect is somewhere else. On its own that
 * makes the police unable to find a moving target at all: a probe of the
 * three-star chase had two cars circling 300 px away — just outside the 260 px
 * they can see — for the whole of a wave, then giving up, having never once
 * had eyes on a player walking in a straight line.
 *
 * What was missing is the thing every real dispatcher does: while the suspect
 * is still *hot*, the units en route get updated coordinates. The old code got
 * this for free by being omniscient, and P1 removed omniscience without
 * putting anything in its place.
 *
 * The gate is `isCoolingDown`, so this cannot undo the escape. `unseenTicks`
 * resets on any sighting AND on any fresh offence (`addHeat`), which is
 * exactly the right definition of hot: keep committing crimes, or stay in
 * view, and the radio keeps talking. Go quiet for `wantedCooldownTicks` and
 * it stops — the units already out keep looking with the last position they
 * were given, and the search runs down as before.
 */
function radioUpdate(state: GameState, p: PlayerState): void {
  const t = getTuning().police;
  if (state.tick % t.spawnCooldownTicks !== 0) return;
  if (isCoolingDown(p)) return;
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop || cop.targetId !== p.id || copIsDown(cop)) continue;
    cop.lastSeenX = q8(p.pos.x);
    cop.lastSeenY = q8(p.pos.y);
    // Back on the trail: the clock that gives up is about losing the
    // suspect, and a unit with a current position has not lost them.
    cop.searchTicks = 0;
    cop.searchDir = -1;
  }
}

/** Officers still on their feet, for the spawn budget. Bodies are not police. */
function liveCopCount(state: GameState): number {
  let n = 0;
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (cop && !copIsDown(cop)) n++;
  }
  return n;
}

/**
 * Did anybody official notice?
 *
 * Seen, or heard. Line of sight is the old rule and still the strongest one;
 * `noiseRadius` is what a shot carries as a sound, through walls, and is what
 * makes a silenced weapon worth carrying — the same kill at a fraction of the
 * attention. A loud weapon in an empty street is still a crime; a quiet one
 * with a patrol car round the corner still is too.
 */
export function noticedBy(
  state: GameState,
  map: CityMap,
  p: PlayerState,
  noiseRadius: number,
): boolean {
  const range = getTuning().police.sightRange;
  const n2 = noiseRadius * noiseRadius;
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop) continue;
    const dx = cop.pos.x - p.pos.x;
    const dy = cop.pos.y - p.pos.y;
    if (dx * dx + dy * dy <= n2) return true;
    if (hasLineOfSight(map, cop, p, range)) return true;
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

function copStats(kind: string): CopKindTuning {
  const t = getTuning().police;
  // Fall back to the flat numbers so a police.json without a `kinds` block
  // still produces a working force rather than an invisible one — and to the
  // pre-P2 behaviour for the fields it will not have: one flat cooldown,
  // everybody closing to arrest reach, no shields.
  return (
    t.kinds[kind] ?? {
      health: t.copHealth,
      weapon: t.weapon,
      moveSpeed: t.moveSpeed,
      preferredRange: 0,
      burstCount: 0,
      burstPauseTicks: 0,
      frontalDamage: 1,
    }
  );
}

/**
 * The units a given wanted level turns out, flattened into arrival order.
 *
 * A wave is a COMPOSITION, which is the whole difference between this and the
 * drip it replaces: one officer every 18 ticks, all of the same kind, for as
 * long as you stayed wanted. Pressure with no shape. A wave arrives together,
 * from one direction, and is followed by a gap — and the gap is not a
 * kindness, it is what makes P1's cool-down reachable without making the
 * police weak. See GTA.md P3a.
 *
 * Falls back to `copKindFor`'s ladder when police.json carries no `waves`
 * block, so the old behaviour survives its own data being absent.
 */
function waveUnits(wanted: number): Array<{ kind: string; vehicle: string | null }> {
  const t = getTuning().police;
  const spec = t.waves[String(wanted)] ?? t.waves[String(Math.min(6, Math.max(1, wanted)))];
  if (!spec || spec.length === 0) {
    const kind = copKindFor(wanted);
    return [{ kind, vehicle: wanted >= t.carsFromStar ? 'copcar' : null }];
  }
  const out: Array<{ kind: string; vehicle: string | null }> = [];
  for (const entry of spec) {
    for (let i = 0; i < entry.count; i++) out.push({ kind: entry.kind, vehicle: entry.vehicle });
  }
  return out;
}

/**
 * A deterministic offset into the kerbside spawn list for one wave.
 *
 * Hashed rather than drawn, and that is the point: every unit of a wave
 * computes the SAME anchor from the same two integers, so a wave lands as a
 * line of cars along one street instead of scattering to four corners. It
 * also takes an rng draw out of the spawner, which used to consume one per
 * officer.
 */
function waveAnchor(since: number, wave: number, len: number): number {
  let h = Math.imul(since | 0, 0x27d4eb2d) ^ Math.imul(wave + 1, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) % Math.max(1, len);
}

function maybeSpawnCop(state: GameState, map: CityMap): void {
  const t = getTuning().police;
  if (liveCopCount(state) >= t.maxCopsTotal) return;
  // Spacing between arrivals, straight off the tick counter so it needs no
  // state of its own. Checked before any rng draw, so the stream stays fixed.
  if (state.tick % t.spawnCooldownTicks !== 0) return;

  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode === 'dead') continue;
    const wanted = wantedLevelOf(p);
    if (wanted === 0) continue;
    // Two different counts, because they answer two different questions.
    //
    // `onIt` is how many units are actually ON this suspect — in contact, or
    // recently enough out of it to still be warm. It is what the dispatch
    // budget is measured against, and it deliberately excludes an officer who
    // has been searching empty streets for eight seconds: before this, six
    // units combing the wrong block counted as a full response, so the force
    // stopped answering a suspect standing in plain view three streets away.
    //
    // `assignedAny` is how many are out on this call at all, warm or cold,
    // and it is what the suppression below reads. Splitting them is what lets
    // "stop reinforcing a lost search" and "keep the pressure up on a live
    // one" be true at the same time.
    let onIt = 0;
    let assignedAny = 0;
    for (const cid of state.cops.ids) {
      const c = state.cops.byId[cid];
      if (!c || c.targetId !== pid || copIsDown(c)) continue;
      assignedAny++;
      if (c.searchTicks < t.searchGiveUpTicks * SEARCH_WARM_FRACTION) onIt++;
    }
    const desired = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
    if (onIt >= desired) continue;

    // A search that has lost you is not reinforced. This is the line that
    // closes P1's loop: the spawner's old job was to put a fresh pair of eyes
    // 260 px from a fugitive every 0.6 s, which is precisely what kept the
    // decay gate shut and made an escape impossible. Officers already out
    // keep looking — the force does not forget you, it just stops being fed.
    //
    // `assigned > 0` is load-bearing and was learned the hard way. Without
    // it the suppression also blocks the FIRST car: commit a crime on an
    // empty street, and three seconds later nobody can see you, so nobody is
    // sent, so nobody can ever see you. The police simply never turn out.
    // Dispatching the first unit is the crime being reported; suppressing the
    // second is the search being called off.
    if (assignedAny > 0 && isCoolingDown(p)) continue;

    // Where this player is in the rhythm. Derived from two integers already
    // in the state and already in the hash — no counter, nothing to drift.
    const since = p.wantedSinceTick >= 0 ? p.wantedSinceTick : state.tick;
    const elapsed = state.tick - since;
    const wave = Math.floor(elapsed / t.wavePeriodTicks);
    const intoWave = elapsed - wave * t.wavePeriodTicks;
    const units = waveUnits(wanted);
    // Which unit of this wave is due now. Past the end of the list the
    // street goes quiet until the next wave: THAT is the lull, and it is the
    // half of the feature that does the work.
    const unitIndex = Math.floor(intoWave / t.spawnCooldownTicks);
    if (unitIndex >= units.length) continue;
    const unit = units[unitIndex] as { kind: string; vehicle: string | null };

    // The wave's units come off consecutive kerbside points from one anchor,
    // so a response arrives along a street rather than materialising around
    // the fugitive from every side at once.
    const spawns = map.vehicleSpawns;
    if (spawns.length === 0) return;
    const anchor = waveAnchor(since, wave, spawns.length);
    let found = 0;
    for (let i = 0; i < spawns.length; i++) {
      const candidate = spawns[(anchor + i) % spawns.length];
      if (!candidate) continue;
      const d = dist(candidate.x, candidate.y, p.pos.x, p.pos.y);
      if (d < t.spawnMinDist || d > t.spawnMaxDist) continue;
      // Take the unitIndex-th valid point, not the first: two units of the
      // same wave must not be handed the same patch of kerb.
      if (found++ < unitIndex) continue;
      const stats = copStats(unit.kind);
      const cop = createCop(state.nextEntityId++, candidate, stats.health, unit.kind);
      cop.targetId = pid;
      // The call coming in: dispatch knows where the suspect was reported,
      // not where they are. That is what a unit drives to, and if the suspect
      // has moved on by the time it arrives, it searches and eventually gives
      // up — see the search block in stepPolice. Without this a fresh unit
      // would drive to (0, 0).
      cop.lastSeenX = q8(p.pos.x);
      cop.lastSeenY = q8(p.pos.y);
      insertEntity(state.cops, cop);
      // Units ARRIVE in whatever the wave says they arrive in. Motorising
      // mid-chase instead would drop a vehicle wherever the officer happened
      // to be standing — usually a pavement — where it wedges on the first
      // tick. A kerbside spawn point is on a road by construction.
      if (unit.vehicle) motorise(state, cop, candidate.heading, unit.vehicle);
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

  // Burst cadence. An officer used to fire on a flat cooldown, so their peak
  // damage and their sustained damage were the same number — and ten federal
  // agents at 45 DPS apiece deleted a full-health player in under half a
  // second. Three rounds and a beat halves the sustained rate without making
  // any single volley less frightening, and the beats are the gaps a player
  // moves in. See GTA.md P2b.
  const burst = copStats(cop.kind).burstCount;
  if (burst > 0) {
    cop.burstLeft = cop.burstLeft > 0 ? cop.burstLeft - 1 : burst - 1;
    cop.fireCooldown =
      cop.burstLeft > 0 ? weapon.cooldownTicks : weapon.cooldownTicks + copStats(cop.kind).burstPauseTicks;
  } else {
    cop.fireCooldown = weapon.cooldownTicks;
  }

  let roll: number;
  [roll, state.rng] = nextFloat01(state.rng);
  // Accuracy that falls off, which is the single biggest lever in P2 and the
  // fair one: it never makes an officer miss somebody standing still at
  // point-blank range, and it stops a cordon deleting a car crossing a
  // junction at 200 px/s. Both terms are computed from sim state and the roll
  // is still the same single draw, so the rng stream is unchanged.
  const d = dist(cop.pos.x, cop.pos.y, target.pos.x, target.pos.y);
  const targetSpeed = Math.hypot(target.vel.x, target.vel.y);
  const spread =
    weapon.spread *
    (1 + t.rangeSpread * Math.min(1, d / Math.max(1, t.fireRange))) *
    (1 + t.speedSpread * Math.min(1, targetSpeed / Math.max(1, t.spreadReferenceSpeed)));
  const angle =
    dAtan2(target.pos.y - cop.pos.y, target.pos.x - cop.pos.x) + (roll - 0.5) * 2 * spread;
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
    noise: weapon.noiseRadius,
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

/**
 * How far into its search an officer still counts as being on the suspect,
 * for the dispatch budget. Past this they are looking rather than chasing,
 * and a fresh unit is warranted.
 */
const SEARCH_WARM_FRACTION = 0.5;

/** Cop cruisers are AI-driven like traffic, but with a distinct id band. */
function copDriverId(copId: number): number {
  return -100000 - copId;
}

/**
 * Put an officer behind the wheel, facing along the road.
 *
 * The vehicle is whatever the wave said (P3b), not always a cruiser — which
 * is what lets an army wave turn up in armour without a second code path.
 * The budget is per KIND for the same reason: `maxCopCars` is a sensible
 * number of patrol cars and an absurd number of tanks.
 */
function motorise(state: GameState, cop: CopState, heading: number, kind = 'copcar'): void {
  const t = getTuning().police;
  let cars = 0;
  for (const id of state.vehicles.ids) {
    if (state.vehicles.byId[id]?.kind === kind) cars++;
  }
  if (cars >= (t.vehicleCaps[kind] ?? t.maxCopCars)) return;

  const id = state.nextEntityId++;
  const v = createVehicle(id, kind, cop.pos, heading);
  // Not on top of something else. Two officers who happened to arrive on the
  // same spot were each given a cruiser at that spot, so the pair spent the
  // chase interpenetrating and shuffling apart at walking pace instead of
  // driving anywhere. The officer without room simply stays on foot.
  for (const other of state.vehicles.ids) {
    const o = state.vehicles.byId[other];
    if (o && vehiclesOverlap(v, o)) {
      state.nextEntityId--;
      return;
    }
  }
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
  /** Where to drive: the fugitive if visible, else where they were last seen. */
  goalX: number,
  goalY: number,
  seen: boolean,
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
  const want = dAtan2(goalY - cop.pos.y, goalX - cop.pos.x);
  const d = dist(cop.pos.x, cop.pos.y, goalX, goalY);

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
  //
  // Only when the fugitive is actually IN VIEW. A unit that has lost you is
  // driving to a moving search point, and getting out of the car every time
  // it reaches one would strip the whole force of its cars within seconds of
  // the first corner you turned.
  if (seen && d <= t.dismountDist) {
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

  // There used to be a third exit here: close, but with a wall in between —
  // park and go in on foot. P1a made it unreachable and it has been removed.
  // `blocked` and `seen` are the same ray test over different lengths, so
  // "there is a wall in the way" and "the officer can see them" cannot both
  // hold, and a fugitive inside a building is now handled by the thing that
  // actually models it: the officer cannot see them, so they search the area
  // and give up. Leaving the branch in would have been a condition that reads
  // as live and never fires.
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
  const wanted = wantedLevelOf(p);
  if (wanted < t.roadblocksFromStar) return;
  // What gets thrown across the road is whatever this level turns out in. At
  // the top of the ladder that is armour, and armour across a street is a
  // different problem from two cruisers across a street — which is the whole
  // of "the military at five stars" as far as roadblocks are concerned.
  const kind = t.roadblockVehicle[String(wanted)] ?? 'copcar';
  let cars = 0;
  for (const id of state.vehicles.ids) {
    if (state.vehicles.byId[id]?.kind === kind) cars++;
  }
  if (cars + 2 > (t.vehicleCaps[kind] ?? t.maxCopCars) + 2) return;

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
        kind,
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

  // Wanted levels, and the heat coming off once you have been out of sight
  // long enough. The clock is what makes an escape possible at all — see
  // GTA.md P1b and `updateSight`.
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p) continue;
    updateSight(state, map, p);
    // The wave clock. It starts when you become wanted, stops when you stop
    // being, and RESTARTS whenever the level goes up — because a new star is
    // a new call, and a bigger force that waits out the lull before turning
    // out is a wanted level that means nothing for ten seconds. It does not
    // restart when the level falls: a chase that goes 2 -> 4 -> 2 is one
    // call-out with one rhythm, not three.
    //
    // `p.wantedLevel` still holds last tick's value here; it is assigned at
    // the bottom of this loop.
    const level = wantedLevelOf(p);
    if (level === 0) p.wantedSinceTick = -1;
    else if (p.wantedSinceTick < 0 || level > p.wantedLevel) p.wantedSinceTick = state.tick;
    if (p.heat > 0 && isCoolingDown(p)) {
      // Ramped, not flat. The rate climbs with every further second clean, so
      // the first stars come off slowly and a long clean run finishes the job
      // — a flat 5/s put a five-star escape at 100 s, which is long enough
      // that nobody ever discovered it was possible.
      const clean = (p.unseenTicks - t.wantedCooldownTicks) * DT;
      const rate = Math.min(t.heatDecayMax, t.heatDecayPerSec * (1 + t.heatDecayRamp * clean));
      p.heat = Math.max(0, p.heat - rate * DT);
    }
    p.wantedLevel = wantedLevelOf(p);
  }

  maybeSpawnCop(state, map);
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode === 'dead') continue;
    radioUpdate(state, p);
    maybeRoadblock(state, map, p);
  }

  const toRemove: number[] = [];
  const corpseTicks = Math.round(getTuning().peds.corpseSec * TICK_RATE);
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop) continue;

    // A body on the tarmac. It lies there for the same span a pedestrian's
    // does, on the same counter the living use to time out — a corpse is
    // idle by definition, so no extra field is needed to clock it.
    if (copIsDown(cop)) {
      cop.idleTicks++;
      if (cop.idleTicks >= corpseTicks) toRemove.push(cid);
      continue;
    }

    if (cop.fireCooldown > 0) cop.fireCooldown--;
    if (cop.carHitCooldown > 0) cop.carHitCooldown--;

    // Who this officer is after.
    //
    // Not "the nearest wanted player", which is what it used to be and is the
    // other half of why nobody could be given the slip: an officer who had
    // just lost you re-acquired you on the next tick from across a building,
    // because proximity was the whole test. Now there are exactly two ways to
    // have a target — you were DISPATCHED to one (maybeSpawnCop assigns it,
    // with a last-known position: that is the call coming in), or you can SEE
    // one. Everything else is a search, and a search can fail.
    const held = cop.targetId === null ? null : state.players.byId[cop.targetId];
    const holdable =
      held !== undefined &&
      held !== null &&
      held.mode !== 'dead' &&
      wantedLevelOf(held) > 0 &&
      // Invisibility drops a pursuit OUTRIGHT, rather than merely blocking
      // sight and leaving the officer to search you out over the next eight
      // seconds. That is the difference between the power-up doing what it
      // says and being a slightly better street corner: it lasts 15 s, and
      // spending half of it waiting for a search to expire is not an escape.
      (held.powerFlags & POWER_INVISIBLE) === 0 &&
      cop.searchTicks < t.searchGiveUpTicks;
    let target: PlayerState | null = holdable ? (held as PlayerState) : null;
    if (!target) {
      // Nothing to hold on to: look up. Only somebody actually in view is
      // acquired — an invisible suspect is not, which is the point of the
      // power-up, and `copSees` is where that is enforced for sight as well
      // as for acquisition.
      let bestSeen = Infinity;
      for (const pid of state.players.ids) {
        const p = state.players.byId[pid];
        if (!p || p.mode === 'dead' || wantedLevelOf(p) === 0) continue;
        if (!copSees(map, cop, p, t.sightRange)) continue;
        const d = dist(cop.pos.x, cop.pos.y, p.pos.x, p.pos.y);
        if (d < bestSeen) {
          bestSeen = d;
          target = p;
        }
      }
      // A fresh acquisition starts in contact, wherever the search had got to.
      if (target) {
        cop.searchTicks = 0;
        cop.searchDir = -1;
      }
    }
    const bestD = target ? dist(cop.pos.x, cop.pos.y, target.pos.x, target.pos.y) : Infinity;

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
          if (!ped || ped.gangId === 0 || ped.mode === 'dead') continue;
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

    // Contact, or the lack of it. Everything below steers at `goal`, which is
    // the fugitive while they are in view and the last place they were seen
    // once they are not. This is the whole of P1a: an officer who cannot see
    // you does not know where you are.
    const seen = copSees(map, cop, target, t.sightRange);
    if (seen) {
      cop.lastSeenX = q8(target.pos.x);
      cop.lastSeenY = q8(target.pos.y);
      cop.searchTicks = 0;
      cop.searchDir = -1;
    } else {
      cop.searchTicks++;
    }
    // Out of contact and standing where they last saw you: cast about.
    //
    // The sweep is done by MOVING the last-seen point one street-length down
    // an open cardinal, so the ordinary chase code below — on foot or at the
    // wheel — drives the search without knowing it is a search. A cruiser
    // sweeps further per leg than a man on foot, which is what makes losing a
    // car harder than losing a pedestrian, and it is the same road-grid test
    // (`dirIsOpen`) the pursuit detour already uses.
    if (!seen && dist(cop.pos.x, cop.pos.y, cop.lastSeenX, cop.lastSeenY) <= t.searchArriveDist) {
      let roll: number;
      [roll, state.rng] = nextIntRange(state.rng, 0, 4);
      // Carrying straight on is preferred, so a search reads as walking down
      // a street rather than as pacing on the spot.
      let picked = cop.searchDir >= 0 && dirIsOpen(map, cop.pos.x, cop.pos.y, cop.searchDir)
        ? cop.searchDir
        : roll;
      if (roll === 0 || !dirIsOpen(map, cop.pos.x, cop.pos.y, picked)) {
        for (let i = 0; i < 4; i++) {
          const d = (roll + i) % 4;
          if (dirIsOpen(map, cop.pos.x, cop.pos.y, d)) {
            picked = d;
            break;
          }
        }
      }
      cop.searchDir = picked;
      const angle = CARDINAL_ANGLE[picked] as number;
      // One leg is what this unit covers in `searchWanderTicks` — so a
      // cruiser sweeps a couple of blocks where a man on foot sweeps a
      // frontage, and (not incidentally) a driving leg is longer than
      // `dismountDist`, which is what keeps a searching cruiser in its car.
      const legSpeed =
        cop.vehicleId !== null ? t.copCarSpeed * t.carSearchSpeedScale : copStats(cop.kind).moveSpeed;
      const stride = t.searchWanderTicks * legSpeed * DT;
      cop.lastSeenX = q8(cop.pos.x + dCos(angle) * stride);
      cop.lastSeenY = q8(cop.pos.y + dSin(angle) * stride);
    }

    const goalX = seen ? target.pos.x : cop.lastSeenX;
    const goalY = seen ? target.pos.y : cop.lastSeenY;
    const goalD = dist(cop.pos.x, cop.pos.y, goalX, goalY);

    // Escalation by KIND, not just count. Below carsFromStar the response is
    // the on-foot posse it always was; at and above it, officers arrive
    // motorised (see maybeSpawnCop) — which is what stops a car being a
    // guaranteed escape from a force whose top speed was 122 px/s against
    // the player's 330.
    if (cop.vehicleId !== null) {
      drivePursuit(state, map, cop, target, goalX, goalY, seen, events);
      if (seen && cop.fireCooldown === 0 && bestD <= t.fireRange) {
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
    // Close to just inside arrest reach, never flush. The standoff used to
    // be a flat 24 px against a bustRadius of 22, so an officer who had
    // finished approaching stood half a pixel outside hands-on range and
    // shot a stationary suspect forever — whether an arrest ever landed
    // depended on where the last 4 px stride happened to fall.
    // How close this officer wants to be. Patrol and SWAT close to arrest
    // reach, as everybody used to; riflemen hold a cordon at `preferredRange`
    // instead, which is what stops a five-star response being ten people in a
    // huddle around you all at minimum range. A unit that has LOST the suspect
    // ignores its standoff — you cannot cordon somebody you cannot find, and
    // the search has to be allowed to walk right up to the last-seen point.
    const standoff = seen ? Math.max(t.bustRadius - 2, copStats(cop.kind).preferredRange) : t.bustRadius - 2;
    if (goalD > standoff) {
      const moveSpeed = copStats(cop.kind).moveSpeed;
      const dirX = (goalX - cop.pos.x) / goalD;
      const dirY = (goalY - cop.pos.y) / goalD;
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
      // An officer on foot is as solid against a car as anybody else: without
      // this a pursuer walked through the roadblock his own force put down.
      pushOutOfVehicles(cop.pos, cop.vel, PLAYER_RADIUS, state, map, cop.vehicleId);
      cop.pos.x = q8(cop.pos.x);
      cop.pos.y = q8(cop.pos.y);
      cop.vel.x = q8(cop.vel.x);
      cop.vel.y = q8(cop.vel.y);
    } else {
      cop.vel.x = 0;
      cop.vel.y = 0;
    }

    // Nothing below happens to somebody the officer cannot see. Both an
    // arrest and a shot used to be pure geometry, so a suspect standing on
    // the far side of a shopfront could be nicked through it.
    if (!seen) continue;

    // Hands before bullets: an officer within reach of a stationary suspect
    // arrests them. Checked before the fire test so a point-blank cop never
    // shoots somebody they could have taken in.
    if (cop.fireCooldown === 0 && tryBust(state, cop, target, events)) {
      cop.fireCooldown = getWeaponTuning(copStats(cop.kind).weapon)?.cooldownTicks ?? 0;
      continue;
    }

    if (cop.fireCooldown === 0 && bestD <= t.fireRange) {
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
