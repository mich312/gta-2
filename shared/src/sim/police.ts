import { DT, PLAYER_RADIUS } from '../constants.js';
import { q8 } from '../math/vec.js';
import { dAtan2, dCos, dSin } from '../math/trig.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { CopState, GameState, PlayerState } from './state.js';
import { addHeat, createCop, wantedLevelOf } from './state.js';
import { insertEntity, removeEntity } from './entities.js';
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

function maybeSpawnCop(state: GameState, map: CityMap): void {
  const t = getTuning().police;
  if (state.cops.ids.length >= t.maxCopsTotal) return;

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

export function stepPolice(state: GameState, map: CityMap, events: SimEvent[]): void {
  const t = getTuning().police;

  // Wanted levels + decay while unseen.
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p) continue;
    if (p.heat > 0) {
      const seen = state.cops.ids.some((cid) => {
        const cop = state.cops.byId[cid];
        return cop ? hasLineOfSight(map, cop, p, t.sightRange) : false;
      });
      if (!seen) p.heat = Math.max(0, p.heat - (t.heatDecayPerSec * DT));
    }
    p.wantedLevel = wantedLevelOf(p);
  }

  maybeSpawnCop(state, map);

  const toRemove: number[] = [];
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop) continue;
    if (cop.fireCooldown > 0) cop.fireCooldown--;

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
  for (const cid of toRemove) removeEntity(state.cops, cid);
}
