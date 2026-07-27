import { DT, PLAYER_RADIUS } from '../constants.js';
import { q8 } from '../math/vec.js';
import { nextFloat01, nextIntRange } from '../rng/prng.js';
import { getTuning } from '../tuning.js';
import type { GameState, PedState } from './state.js';
import { addHeat } from './state.js';
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
        const loud = Math.abs(v.speed) >= 140;
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
  removeEntity(state.peds, ped.id);
  const attacker = state.players.byId[attackerId];
  if (attacker) addHeat(attacker, getTuning().peds.heatPerPedKill);
  events.push({ type: 'pedDown', tick: state.tick, killerId: attackerId });
}

export { PED_RADIUS };
export const PED_PLAYER_RADIUS = PLAYER_RADIUS;
