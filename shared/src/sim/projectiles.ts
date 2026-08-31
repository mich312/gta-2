import { DT, PLAYER_RADIUS } from '../constants.js';
import { q8 } from '../math/vec.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { GameState, ProjectileState, VehicleState } from './state.js';
import { removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';
import { blast, vehicleHitRadius } from './vehicleDamage.js';
import { copCanBeShot, rayCircleDistance, rayWallDistance } from './weapons.js';
import { slickVehicle } from './fittings.js';
import { onTheGround } from './bodies.js';

/** Dropped by a car fitting rather than thrown: no flight, just patience. */
const DROPS: Record<string, 'mine' | 'slick'> = { mine: 'mine', slick: 'slick' };

/**
 * Things with a flight time: rockets, grenades, molotovs.
 *
 * The whole reason this is an entity table rather than a ray with a delay is
 * that a projectile is *observable* — you can see the rocket coming, and step
 * out of the way of a grenade that landed short. That only works if every
 * client is shown the same object in the same place, which means state, which
 * means the six touch points.
 *
 * Movement is SWEPT, not sampled. A rocket covers 14 px in a tick and a
 * person is 8 px wide, so testing only where it lands each tick flies it
 * straight through roughly half the people it is aimed at — the projectile
 * arrives on the far side with the target untouched. Both the wall test and
 * the entity test therefore run along the segment travelled, using the same
 * two primitives the hitscan path uses.
 *
 * Determinism: fixed slot after `stepWeapons` (which spawns them) and before
 * `stepVehicleImpacts`, iterating in sorted-id order. It draws no random
 * numbers at all, so inserting it shifted no downstream rng draw.
 */
export function stepProjectiles(state: GameState, map: CityMap, events: SimEvent[]): void {
  // Frozen before anything detonates: a blast can destroy vehicles and hurt
  // players, and a list built while that happens would depend on order.
  const detonating: Array<{ id: number; x: number; y: number }> = [];

  for (const id of state.projectiles.ids) {
    const pr = state.projectiles.byId[id];
    if (!pr) continue;

    // Mines and oil slicks: laid in the road by a car fitting, with no
    // tuning in weapons.json because they are not weapons you carry. They do
    // not move; they wait for somebody to drive over them.
    const drop = DROPS[pr.kind];
    if (drop) {
      const ft = getTuning().fittings;
      const radius = drop === 'mine' ? ft.mineRadius : ft.slickRadius;
      const victim = vehicleOver(state, pr.pos.x, pr.pos.y, radius, pr.ownerId);
      if (victim) {
        removeEntity(state.projectiles, id);
        if (drop === 'mine') {
          blast(state, pr.pos.x, pr.pos.y, ft.mineBlastRadius, ft.mineBlastDamage, pr.ownerId, events);
        } else {
          // Which way it throws you is fixed by the car's id, so both hosts
          // agree without spending an rng draw on it.
          slickVehicle(victim, victim.id % 2 === 0 ? 1 : -1);
        }
        continue;
      }
      if (state.tick >= pr.fuseAtTick) removeEntity(state.projectiles, id);
      continue;
    }

    // A broken prop that goes off: it does not fly, it just waits one tick
    // and detonates. `damageProp` leaves one of these behind rather than
    // blasting inline, because `blast` calls `damageProp` and a chain of
    // barrels would otherwise recurse to a depth both hosts must agree on.
    if (propBlastOf(pr.kind)) {
      if (state.tick >= pr.fuseAtTick) detonating.push({ id, x: pr.pos.x, y: pr.pos.y });
      continue;
    }

    const tuning = getWeaponTuning(pr.kind)?.projectile;
    if (!tuning) {
      // Tuning changed out from under a live projectile: drop it rather than
      // leave it flying forever with no way to go off.
      detonating.push({ id, x: pr.pos.x, y: pr.pos.y });
      continue;
    }

    const speed = Math.sqrt(pr.vel.x * pr.vel.x + pr.vel.y * pr.vel.y);
    if (speed > 0) {
      const travel = speed * DT;
      const dirX = pr.vel.x / speed;
      const dirY = pr.vel.y / speed;
      const wallDist = rayWallDistance(map, pr.pos.x, pr.pos.y, dirX, dirY, travel);
      const hitDist = nearestHitAlong(state, pr, dirX, dirY, Math.min(travel, wallDist));
      const stopped = Math.min(travel, wallDist, hitDist);

      pr.pos.x = q8(pr.pos.x + dirX * stopped);
      pr.pos.y = q8(pr.pos.y + dirY * stopped);

      if (hitDist <= travel || wallDist < travel) {
        // Rockets burst on contact; grenades drop where they hit and keep
        // cooking, which is what makes one bounced round a corner behave
        // like a grenade.
        if (tuning.detonateOnImpact) {
          detonating.push({ id, x: pr.pos.x, y: pr.pos.y });
          continue;
        }
        pr.vel.x = 0;
        pr.vel.y = 0;
      } else {
        pr.vel.x = q8(pr.vel.x * tuning.drag);
        pr.vel.y = q8(pr.vel.y * tuning.drag);
      }
    }

    if (state.tick >= pr.fuseAtTick) detonating.push({ id, x: pr.pos.x, y: pr.pos.y });
  }

  for (const d of detonating) {
    const pr = state.projectiles.byId[d.id];
    if (!pr) continue;
    const prop = propBlastOf(pr.kind);
    const tuning = prop
      ? { blastRadius: prop.radius, blastDamage: prop.damage }
      : getWeaponTuning(pr.kind)?.projectile;
    removeEntity(state.projectiles, d.id);
    if (!tuning) continue;
    blast(state, d.x, d.y, tuning.blastRadius, tuning.blastDamage, pr.ownerId, events);
  }
}

/**
 * The blast a `prop:<kind>` marker carries, or null for anything else.
 *
 * The prefix keeps prop detonations out of `weapons.json`, where a barrel has
 * no business being — it is not something anybody carries, buys or fires.
 */
function propBlastOf(kind: string): { radius: number; damage: number } | null {
  if (!kind.startsWith('prop:')) return null;
  return getTuning().props.kinds[kind.slice(5)]?.blast ?? null;
}

/**
 * Distance along this tick's path to the first thing it runs into, or
 * Infinity. Same iteration order as every other hit test: players, cops,
 * vehicles.
 */
/** The first vehicle sitting on this point, ignoring the one that laid it. */
function vehicleOver(
  state: GameState,
  x: number,
  y: number,
  radius: number,
  ownerId: number,
): VehicleState | null {
  for (const vid of state.vehicles.ids) {
    const v = state.vehicles.byId[vid];
    if (!v || v.condition === 'wreck') continue;
    // A mine and a slick are both things lying in the ROAD. Nothing flying
    // over one drives onto it.
    if (!onTheGround(v)) continue;
    // Your own car is exempt while you are still in it: driving away over
    // your own mine is a bug, not a lesson.
    if (v.driverId === ownerId) continue;
    const dx = v.pos.x - x;
    const dy = v.pos.y - y;
    const r = radius + vehicleHitRadius(v);
    if (dx * dx + dy * dy <= r * r) return v;
  }
  return null;
}

function nearestHitAlong(
  state: GameState,
  pr: ProjectileState,
  dirX: number,
  dirY: number,
  maxDist: number,
): number {
  let best = Infinity;
  const consider = (d: number): void => {
    if (d <= maxDist && d < best) best = d;
  };
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    // The thrower is exempt: a rocket must not detonate in its owner's face
    // on the tick it leaves the tube.
    if (!p || p.mode === 'dead' || p.id === pr.ownerId) continue;
    consider(rayCircleDistance(pr.pos.x, pr.pos.y, dirX, dirY, p.pos.x, p.pos.y, PLAYER_RADIUS));
  }
  for (const cid of state.cops.ids) {
    const c = state.cops.byId[cid];
    // A body does not fuse a rocket. Same rule as the hitscan path, now the
    // same predicate — this loop's "same iteration order as every other hit
    // test" was true of the order and false of the filter.
    if (!copCanBeShot(c)) continue;
    consider(rayCircleDistance(pr.pos.x, pr.pos.y, dirX, dirY, c.pos.x, c.pos.y, PLAYER_RADIUS));
  }
  for (const vid of state.vehicles.ids) {
    const v = state.vehicles.byId[vid];
    if (!v || v.condition === 'wreck') continue;
    // The car you are firing from is not a target, or every drive-by rocket
    // would burst against your own door.
    if (v.driverId === pr.ownerId) continue;
    consider(
      rayCircleDistance(pr.pos.x, pr.pos.y, dirX, dirY, v.pos.x, v.pos.y, vehicleHitRadius(v)),
    );
  }
  return best;
}
