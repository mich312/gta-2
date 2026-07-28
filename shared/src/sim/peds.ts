import { DT, PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { GameState, PedState, PlayerState } from './state.js';
import { addHeat, POWER_INVISIBLE } from './state.js';
import { creditGangKill, isHostile } from './respect.js';
import { applyDamage, rayWallDistance } from './weapons.js';
import { gangAt } from '../world/turf.js';
import { removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import { T_SIDEWALK, TILE_SIZE, type CityMap } from '../world/types.js';
import { isSolidTile, moveWithCollision } from '../world/collide.js';

const PED_RADIUS = 5;
/** A car this close scares a pedestrian whether it is moving or not. */
const NUDGE_RADIUS = 26;
const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

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
  const scares: Array<[number, number]> = [];
  for (const ev of tickEvents) {
    if (ev.type === 'shot') scares.push([ev.x0, ev.y0]);
    else if (ev.type === 'death') {
      const p = state.players.byId[ev.playerId];
      if (p) scares.push([p.pos.x, p.pos.y]);
    }
  }

  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped) continue;

    // Down but not out: they lie there while the clock runs, and either an
    // ambulance turns up or it does not.
    if (ped.mode === 'downed') {
      if (ped.timer > 0) ped.timer--;
      else removeEntity(state.peds, id);
      continue;
    }

    // Gang members with a grudge, on their own ground. Checked before the
    // panic rules, and it overrides them: somebody who has decided to shoot
    // at you does not also run away from the noise.
    if (ped.gangId !== 0 && stepHostileGangMember(state, map, ped, tickEvents)) continue;

    // Panic check (nearest scare inside radius wins).
    for (const [sx, sy] of scares) {
      const dx = ped.pos.x - sx;
      const dy = ped.pos.y - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < t.fleeRadius * t.fleeRadius && d2 > 0.0001) {
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
 * A gang member who wants you dead.
 *
 * Hostility is LOCAL by design — on their own turf they open fire, and
 * anywhere else they are merely unfriendly. Without that the whole city
 * turns into a shooting gallery the moment your standing dips, which is the
 * failure mode this mechanic has to be designed away from rather than
 * patched after.
 *
 * Reuses `timer` as the reload clock rather than adding a field: 200
 * pedestrians pay for every byte, and in this mode nothing else needs it.
 * Returns true when the ped acted, which skips the ordinary crowd rules.
 */
function stepHostileGangMember(
  state: GameState,
  map: CityMap,
  ped: PedState,
  events: SimEvent[],
): boolean {
  const rt = getTuning().respect;
  if (gangAt(map, ped.pos.x, ped.pos.y) !== ped.gangId) {
    // Off their patch: no ambush, whatever they think of you.
    if (ped.mode === 'hostile') ped.mode = 'walk';
    return false;
  }

  let target: PlayerState | null = null;
  let bestD = rt.gangSightRange;
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode !== 'foot') continue;
    if ((p.powerFlags & POWER_INVISIBLE) !== 0) continue;
    if (!isHostile(p, ped.gangId)) continue;
    const d = Math.hypot(p.pos.x - ped.pos.x, p.pos.y - ped.pos.y);
    if (d < bestD) {
      bestD = d;
      target = p;
    }
  }
  if (!target) {
    if (ped.mode === 'hostile') ped.mode = 'walk';
    return false;
  }

  ped.mode = 'hostile';
  if (ped.timer > 0) ped.timer--;

  const dx = target.pos.x - ped.pos.x;
  const dy = target.pos.y - ped.pos.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  ped.dirX = dx / d;
  ped.dirY = dy / d;

  // Close the gap unless already inside comfortable range.
  if (d > rt.gangFireRange * 0.7 && (state.tick + ped.id) % 3 === 0) {
    const vel = { x: ped.dirX * rt.gangChaseSpeed, y: ped.dirY * rt.gangChaseSpeed };
    moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
    ped.pos.x = q8(ped.pos.x);
    ped.pos.y = q8(ped.pos.y);
  }

  if (ped.timer === 0 && d <= rt.gangFireRange) {
    const weapon = getWeaponTuning(rt.gangWeapon);
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
      });
      if (wall >= d) applyDamage(state, target, weapon.damage, -1, 'gang', events);
      ped.timer = rt.gangFireCooldownTicks;
    }
  }
  return true;
}

/** Shots and cars kill pedestrians; that's a crime with a heat price. */
export function damagePed(
  state: GameState,
  ped: PedState,
  damage: number,
  attackerId: number,
  events: SimEvent[],
): void {
  ped.health -= damage;
  if (ped.health > 0) {
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
    ped.timer = Math.round(t.bleedOutSec * TICK_RATE);
    return;
  }
  removeEntity(state.peds, ped.id);
  const attacker = state.players.byId[attackerId];
  if (attacker) addHeat(attacker, getTuning().peds.heatPerPedKill);
  // Killing somebody's people is the loudest thing you can say to a gang,
  // and their rivals are listening.
  if (ped.gangId !== 0) creditGangKill(state, attackerId, ped.gangId, events);
  events.push({ type: 'pedDown', tick: state.tick, killerId: attackerId });
}

export { PED_RADIUS };
export const PED_PLAYER_RADIUS = PLAYER_RADIUS;
