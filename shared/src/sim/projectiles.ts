import { DT, PLAYER_RADIUS } from '../constants.js';
import { q8 } from '../math/vec.js';
import { getWeaponTuning } from '../tuning.js';
import type { GameState, ProjectileState } from './state.js';
import { removeEntity } from './entities.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';
import { blast, vehicleHitRadius } from './vehicleDamage.js';
import { rayCircleDistance, rayWallDistance } from './weapons.js';

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
    const tuning = getWeaponTuning(pr.kind)?.projectile;
    removeEntity(state.projectiles, d.id);
    if (!tuning) continue;
    blast(state, d.x, d.y, tuning.blastRadius, tuning.blastDamage, pr.ownerId, events);
  }
}

/**
 * Distance along this tick's path to the first thing it runs into, or
 * Infinity. Same iteration order as every other hit test: players, cops,
 * vehicles.
 */
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
    if (!c) continue;
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
