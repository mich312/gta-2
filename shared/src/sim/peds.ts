import { DT, PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { GameState, PedState, PickupState, PlayerState } from './state.js';
import { addHeat, createPickup, POWER_INVISIBLE } from './state.js';
import { creditGangKill, isHostile } from './respect.js';
import { applyDamage, rayWallDistance } from './weapons.js';
import { gangAt } from '../world/turf.js';
import { insertEntity, removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import { T_SIDEWALK, TILE_SIZE, type CityMap } from '../world/types.js';
import { isSolidTile, moveWithCollision } from '../world/collide.js';
import { onTheGround, pushOutOfVehicles } from './bodies.js';

const PED_RADIUS = 5;
/** A car this close scares a pedestrian whether it is moving or not. */
const NUDGE_RADIUS = 26;
const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Is this pedestrian carrying?
 *
 * A pure function of the id, exactly like gang membership and like who goes
 * down alive rather than dying: no field on the wire, no random draw at
 * spawn, and every host agrees without being told.
 */
export function pedIsArmed(pedId: number): boolean {
  const every = Math.max(1, Math.round(getTuning().peds.armedOneIn));
  return pedId % every === 0;
}

function prefersTile(map: CityMap, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  return map.tiles[ty * map.widthTiles + tx] === T_SIDEWALK;
}

/** Pick a wander direction: sidewalk-continuing directions strongly preferred. */
function pickDirection(state: GameState, map: CityMap, ped: PedState): void {
  const options: Array<[number, number]> = [];
  for (const [dx, dy] of DIRS) {
    const aheadX = ped.pos.x + dx * TILE_SIZE * 1.5;
    const aheadY = ped.pos.y + dy * TILE_SIZE * 1.5;
    if (isSolidTile(map, Math.floor(aheadX / TILE_SIZE), Math.floor(aheadY / TILE_SIZE))) continue;
    if (prefersTile(map, aheadX, aheadY)) {
      options.push([dx, dy], [dx, dy]); // double weight for staying on pavement
    } else {
      options.push([dx, dy]);
    }
  }
  if (options.length === 0) {
    ped.dirX = -ped.dirX;
    ped.dirY = -ped.dirY;
    return;
  }
  let pick: number;
  [pick, state.rng] = nextIntRange(state.rng, 0, options.length);
  const dir = options[pick] as [number, number];
  ped.dirX = dir[0];
  ped.dirY = dir[1];
}

/**
 * Pedestrian crowds: wander the sidewalks, flee gunfire and roaring engines.
 * Deliberately simple per-ped logic — 200 of them must cost almost nothing,
 * and the road grid does the visual heavy lifting.
 */
export function stepPeds(
  state: GameState,
  map: CityMap,
  tickEvents: SimEvent[],
): void {
  const t = getTuning().peds;

  // Panic sources from this tick: gunshots and deaths.
  // Each scare carries its own reach now: a shotgun clears a street that a
  // silenced pistol does not disturb at all (M2). A death still uses the
  // crowd's own radius — seeing a body is not a question of how loud it was.
  const scares: Array<[number, number, number]> = [];
  for (const ev of tickEvents) {
    if (ev.type === 'shot') scares.push([ev.x0, ev.y0, ev.noise]);
    else if (ev.type === 'death') {
      const p = state.players.byId[ev.playerId];
      if (p) scares.push([p.pos.x, p.pos.y, t.fleeRadius]);
    }
  }

  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped) continue;

    // A body in the street. It lies there long enough to be part of what you
    // did — a shooting used to erase its own victim on the frame it happened —
    // and is then cleared away.
    if (ped.mode === 'dead') {
      if (ped.timer > 0) ped.timer--;
      else removeEntity(state.peds, id);
      continue;
    }

    // Down but not out: they lie there while the clock runs, and either an
    // ambulance turns up or it does not. Before everything else, including
    // the escort rules — somebody bleeding on the pavement is not following
    // anybody anywhere.
    if (ped.mode === 'downed') {
      if (ped.timer > 0) ped.timer--;
      else leaveBody(state, ped);
      continue;
    }

    // Somebody you are meant to be protecting. Overrides the crowd rules: an
    // escortee who wandered off because a car went past would fail the
    // mission for reasons the player could do nothing about.
    if (ped.escortOf !== null && stepEscortee(state, map, ped)) continue;

    // People with a reason to shoot at you, checked before the panic rules and
    // overriding them: somebody who has decided to shoot at you does not also
    // run away from the noise. Two reasons qualify — a gang member on their
    // own ground, and anybody armed whom you have already shot at.
    if (stepArmedPed(state, map, ped, tickEvents)) continue;

    // Panic check (nearest scare inside radius wins).
    for (const [sx, sy, reach] of scares) {
      const dx = ped.pos.x - sx;
      const dy = ped.pos.y - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < reach * reach && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        ped.dirX = dx / d;
        ped.dirY = dy / d;
        ped.mode = 'flee';
        ped.timer = t.fleeTicks;
        break;
      }
    }
    // Speeding cars nearby scatter the crowd — and so does one right on top of
    // you at any speed, which is what gets a pedestrian off the road again
    // after traffic has stopped for them. Without it a single jaywalker holds
    // up the street indefinitely.
    if (ped.mode === 'walk') {
      for (const vid of state.vehicles.ids) {
        const v = state.vehicles.byId[vid];
        if (!v) continue;
        // A parked, empty car is street furniture, not a threat. Before this
        // it scared people off the pavement beside it, which among other
        // things meant nobody could ever stand close enough to get IN one
        // (J3): boarding wants a walking pedestrian, and this made every
        // pedestrian near a parked car a fleeing one.
        if (v.driverId === null && v.speed === 0) continue;
        // Neither is an aeroplane at cruise height. This rule is "something is
        // about to drive into me", and it was measuring the distance to the
        // shadow: a helicopter crossing the city parted the crowd beneath it
        // the whole way, which read as the entire population running from a
        // dot in the sky. What is overhead is not in the road.
        if (!onTheGround(v)) continue;
        const loud = Math.abs(v.speed) >= 84;
        const dx = ped.pos.x - v.pos.x;
        const dy = ped.pos.y - v.pos.y;
        const d2 = dx * dx + dy * dy;
        if (!loud && d2 > NUDGE_RADIUS * NUDGE_RADIUS) continue;
        if (d2 < 90 * 90 && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          ped.dirX = dx / d;
          ped.dirY = dy / d;
          ped.mode = 'flee';
          ped.timer = t.fleeTicks;
          break;
        }
      }
    }

    if (ped.timer > 0) ped.timer--;
    if (ped.mode === 'flee' && ped.timer === 0) {
      ped.mode = 'walk';
      pickDirection(state, map, ped);
      let next: number;
      [next, state.rng] = nextIntRange(state.rng, t.turnMinTicks, t.turnMaxTicks);
      ped.timer = next;
    } else if (ped.mode === 'walk' && ped.timer === 0) {
      pickDirection(state, map, ped);
      let next: number;
      [next, state.rng] = nextIntRange(state.rng, t.turnMinTicks, t.turnMaxTicks);
      ped.timer = next;
    }

    // Peds move on a staggered 3-tick cadence (10 Hz, 3x step): background
    // NPCs don't need 30 Hz motion, the client interpolates it smooth, and
    // it cuts their snapshot-delta traffic to a third.
    if ((state.tick + id) % 3 === 0) {
      const speed = ped.mode === 'flee' ? t.fleeSpeed : t.walkSpeed;
      const vel = { x: ped.dirX * speed, y: ped.dirY * speed };
      moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
      pushOutOfVehicles(ped.pos, vel, PED_RADIUS, state, map);
      ped.pos.x = q8(ped.pos.x);
      ped.pos.y = q8(ped.pos.y);
      if (vel.x === 0 && vel.y === 0 && speed > 0) {
        // Walked into a wall: turn now instead of grinding.
        ped.timer = 0;
      }
    }
  }
}

/**
 * Who, if anybody, this pedestrian wants dead — and on what terms.
 *
 * Two quite different mechanics share one shooter. A gang member on their own
 * turf opens fire on sight at anybody their gang has fallen out with, and
 * hostility is LOCAL by design: off their patch they are merely unfriendly.
 * Without that the whole city turns into a shooting gallery the moment your
 * standing dips. An armed civilian has no politics at all — they only ever
 * shoot back, at whoever shot them, and only while the grudge lasts.
 */
function acquireTarget(
  state: GameState,
  map: CityMap,
  ped: PedState,
): PlayerState | null {
  const canSee = (p: PlayerState | undefined): p is PlayerState =>
    !!p && p.mode === 'foot' && (p.powerFlags & POWER_INVISIBLE) === 0;

  // A grudge is personal and outlives line of sight; the clock is what ends it.
  if (ped.targetId !== null) {
    const held = state.players.byId[ped.targetId];
    if (canSee(held)) {
      const d = Math.hypot(held.pos.x - ped.pos.x, held.pos.y - ped.pos.y);
      if (d <= getTuning().peds.armedSightRange) return held;
    }
    return null;
  }

  if (ped.gangId === 0) return null;
  const rt = getTuning().respect;
  if (gangAt(map, ped.pos.x, ped.pos.y) !== ped.gangId) return null; // off their patch
  let target: PlayerState | null = null;
  let bestD = rt.gangSightRange;
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!canSee(p)) continue;
    if (!isHostile(p, ped.gangId)) continue;
    const d = Math.hypot(p.pos.x - ped.pos.x, p.pos.y - ped.pos.y);
    if (d < bestD) {
      bestD = d;
      target = p;
    }
  }
  return target;
}

/**
 * A pedestrian who is shooting at somebody.
 *
 * Reuses `timer` as the reload clock rather than adding a field: 200
 * pedestrians pay for every byte, and in this mode nothing else needs it.
 * Returns true when the ped acted, which skips the ordinary crowd rules.
 */
function stepArmedPed(
  state: GameState,
  map: CityMap,
  ped: PedState,
  events: SimEvent[],
): boolean {
  const gangMember = ped.gangId !== 0;
  if (!gangMember && ped.targetId === null) return false;
  if (!gangMember && !pedIsArmed(ped.id)) {
    ped.targetId = null;
    return false;
  }

  const t = getTuning().peds;
  const rt = getTuning().respect;
  // A grudge runs on its own clock, so it can lapse while the shooting is
  // going on rather than only when the crowd rules next get a look in.
  if (ped.targetId !== null) {
    if (ped.timer > 0) ped.timer--;
    // Lapsed: hand `timer` back to the wander rules at zero, so the next tick
    // picks a fresh direction instead of standing about.
    else ped.targetId = null;
  }

  const target = acquireTarget(state, map, ped);
  if (!target) {
    if (ped.mode === 'hostile') ped.mode = 'walk';
    // A grudge OWNS `timer` while it runs, and the wander rules below reset
    // that counter every time it reaches zero — so falling through to them
    // with a grudge outstanding meant the clock never ran out and an armed
    // civilian stayed angry for the rest of the session. Somebody who has
    // lost sight of the person shooting at them backs off instead, on their
    // own clock, and rejoins the crowd when it lapses.
    if (ped.targetId === null) return false;
    ped.mode = 'flee';
    if ((state.tick + ped.id) % 3 === 0) {
      const speed = getTuning().peds.fleeSpeed;
      const vel = { x: ped.dirX * speed, y: ped.dirY * speed };
      moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
      pushOutOfVehicles(ped.pos, vel, PED_RADIUS, state, map);
      ped.pos.x = q8(ped.pos.x);
      ped.pos.y = q8(ped.pos.y);
      if (vel.x === 0 && vel.y === 0) {
        // Backed into a wall: turn round rather than grind along it.
        ped.dirX = -ped.dirX;
        ped.dirY = -ped.dirY;
      }
    }
    return true;
  }

  // Gang members shoot their own gun on their own cadence; a civilian who has
  // been shot at reaches for whatever they were carrying.
  const holdingGrudge = ped.targetId !== null;
  const weaponId = holdingGrudge ? t.weapon : rt.gangWeapon;
  const fireRange = holdingGrudge ? t.armedFireRange : rt.gangFireRange;
  const chaseSpeed = holdingGrudge ? t.armedChaseSpeed : rt.gangChaseSpeed;
  const cooldown = holdingGrudge ? t.armedFireCooldownTicks : rt.gangFireCooldownTicks;

  ped.mode = 'hostile';
  // A gang member's reload rides on the same counter, but only when there is
  // no grudge clock already running on it.
  if (!holdingGrudge && ped.timer > 0) ped.timer--;

  const dx = target.pos.x - ped.pos.x;
  const dy = target.pos.y - ped.pos.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  ped.dirX = dx / d;
  ped.dirY = dy / d;

  // Close the gap unless already inside comfortable range.
  if (d > fireRange * 0.7 && (state.tick + ped.id) % 3 === 0) {
    const vel = { x: ped.dirX * chaseSpeed, y: ped.dirY * chaseSpeed };
    moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
      pushOutOfVehicles(ped.pos, vel, PED_RADIUS, state, map);
    ped.pos.x = q8(ped.pos.x);
    ped.pos.y = q8(ped.pos.y);
  }

  // The reload is a cadence off the tick counter while a grudge owns `timer`:
  // one counter, two clocks, and the id offset keeps a crowd from volleying.
  const ready = holdingGrudge
    ? (state.tick + ped.id) % Math.max(1, Math.round(cooldown)) === 0
    : ped.timer === 0;
  if (ready && d <= fireRange) {
    const weapon = getWeaponTuning(weaponId);
    if (weapon) {
      const wall = rayWallDistance(map, ped.pos.x, ped.pos.y, ped.dirX, ped.dirY, d);
      events.push({
        type: 'shot',
        tick: state.tick,
        // Negative ids mark a shot nobody can be blamed for by name, exactly
        // as the police do.
        playerId: -ped.id,
        x0: Math.round(ped.pos.x),
        y0: Math.round(ped.pos.y),
        x1: Math.round(ped.pos.x + ped.dirX * Math.min(wall, d)),
        y1: Math.round(ped.pos.y + ped.dirY * Math.min(wall, d)),
        noise: weapon.noiseRadius,
      });
      if (wall >= d) {
        applyDamage(state, target, weapon.damage, -1, holdingGrudge ? 'ped' : 'gang', events);
      }
      if (!holdingGrudge) ped.timer = rt.gangFireCooldownTicks;
    }
  }
  return true;
}

/**
 * Tagging along behind whoever you have been assigned to.
 *
 * A change of destination rather than a new walker: the same collision-aware
 * step the crowd already uses, aimed at a player instead of at a wander
 * heading. Falls back to standing still when close enough, so an escortee
 * does not shove the person they are following around the pavement.
 *
 * Returns false when there is nobody to follow any more, which drops them
 * back into the ordinary crowd rules rather than freezing them.
 */
function stepEscortee(state: GameState, map: CityMap, ped: PedState): boolean {
  const lead = ped.escortOf === null ? undefined : state.players.byId[ped.escortOf];
  if (!lead || lead.mode === 'dead') {
    ped.escortOf = null;
    ped.mode = 'walk';
    return false;
  }
  ped.mode = 'following';
  const dx = lead.pos.x - ped.pos.x;
  const dy = lead.pos.y - ped.pos.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.001) return true;
  ped.dirX = dx / d;
  ped.dirY = dy / d;
  // Close enough is close enough: pushing in reads as harassment.
  if (d < ESCORT_KEEP) return true;
  if ((state.tick + ped.id) % 3 !== 0) return true;
  const t = getTuning().peds;
  const speed = d > ESCORT_KEEP * 3 ? t.fleeSpeed : t.walkSpeed;
  const vel = { x: ped.dirX * speed, y: ped.dirY * speed };
  moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
      pushOutOfVehicles(ped.pos, vel, PED_RADIUS, state, map);
  ped.pos.x = q8(ped.pos.x);
  ped.pos.y = q8(ped.pos.y);
  return true;
}

/** How close an escortee tries to stay, px. */
const ESCORT_KEEP = 34;

/** Turn a pedestrian into a body on the pavement, on the corpse clock. */
function leaveBody(state: GameState, ped: PedState): void {
  ped.health = 0;
  ped.mode = 'dead';
  ped.targetId = null;
  ped.timer = Math.round(getTuning().peds.corpseSec * TICK_RATE);
}

/**
 * Drop a gun where somebody fell. Not a respawning crate: it is created here,
 * it is removed when taken, and `respawnAtTick` carries its expiry — see
 * PickupState. Returns the pickup so callers can point events at it.
 */
export function dropWeapon(
  state: GameState,
  pos: { x: number; y: number },
  weaponId: string,
  ammo: number,
): PickupState | null {
  if (!getWeaponTuning(weaponId)) return null;
  const pu = createPickup(
    state.nextEntityId++,
    'weapon',
    { x: q8(pos.x), y: q8(pos.y) },
    weaponId,
    ammo,
  );
  pu.respawnAtTick = state.tick + Math.round(getTuning().peds.dropLifeSec * TICK_RATE);
  insertEntity(state.pickups, pu);
  return pu;
}

/** Shots and cars kill pedestrians; that's a crime with a heat price. */
export function damagePed(
  state: GameState,
  ped: PedState,
  damage: number,
  attackerId: number,
  events: SimEvent[],
  /**
   * Under the wheels rather than shot. It is a lesser crime, and it has to
   * be, because driving is the game's main verb and the city is full of
   * people: at a flat 80 heat a kill, running over two pedestrians you never
   * saw was most of a star, four was three stars, and the wanted ladder
   * became something you climbed by accident on the way somewhere. See
   * GTA.md P2d.
   */
  byCar = false,
): void {
  // A body is a body. Shooting one again is desecration, not a second kill.
  if (ped.mode === 'dead') return;
  ped.health -= damage;
  if (ped.health > 0) {
    // Somebody armed shoots back rather than running; everybody else runs.
    // The grudge is against whoever pulled the trigger, and it is what turns
    // a crowd from scenery into a reason to pick your fights.
    const attacker = state.players.byId[attackerId];
    if (attacker && ped.mode !== 'downed' && pedIsArmed(ped.id)) {
      ped.mode = 'hostile';
      ped.targetId = attackerId;
      ped.timer = getTuning().peds.grudgeTicks;
      return;
    }
    // Getting shot at close range is definitely a scare.
    ped.mode = 'flee';
    ped.timer = getTuning().peds.fleeTicks;
    return;
  }
  const t = getTuning().peds;
  // Not everybody dies. One in three goes down alive, which turns your
  // violence into somebody else's work — see the ambulance job.
  if (ped.mode !== 'downed' && ped.id % Math.max(1, Math.round(t.downOneIn)) === 0) {
    ped.health = 1;
    ped.mode = 'downed';
    ped.targetId = null;
    ped.timer = Math.round(t.bleedOutSec * TICK_RATE);
    return;
  }
  // The body stays. Everything downstream — heat, respect, the frenzy count —
  // still fires exactly once, on the tick they went down.
  leaveBody(state, ped);
  if (pedIsArmed(ped.id)) dropWeapon(state, ped.pos, t.weapon, Math.round(t.dropAmmo));
  // What they were carrying, on the ground beside them. A crate rather than
  // a number, because money is not sim state: the server prices it off the
  // pickupTaken event, through the same capped chokepoint every other earning
  // path goes through — which is what stops this becoming the farm. Only for
  // a killer who exists: a car that ran somebody over on its own robs nobody.
  if (attackerId >= 0) {
    insertEntity(
      state.pickups,
      createPickup(state.nextEntityId++, 'cash', { x: ped.pos.x, y: ped.pos.y }),
    );
  }
  const attacker = state.players.byId[attackerId];
  if (attacker) addHeat(attacker, byCar ? t.heatPerRoadKill : t.heatPerPedKill);
  // Killing somebody's people is the loudest thing you can say to a gang,
  // and their rivals are listening.
  if (ped.gangId !== 0) creditGangKill(state, attackerId, ped.gangId, events);
  events.push({
    type: 'pedDown',
    tick: state.tick,
    killerId: attackerId,
    x: Math.round(ped.pos.x),
    y: Math.round(ped.pos.y),
  });
}

export { PED_RADIUS };
export const PED_PLAYER_RADIUS = PLAYER_RADIUS;
