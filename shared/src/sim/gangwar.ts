import { DT } from '../constants.js';
import { q8 } from '../math/vec.js';
import { getTuning, getWeaponTuning } from '../tuning.js';
import type { GameState, PedState } from './state.js';
import type { SimEvent } from './events.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';
import { gangAt, rivalsOf } from '../world/turf.js';
import { damagePed, PED_RADIUS } from './peds.js';
import { rayWallDistance } from './weapons.js';

/**
 * Gangs that fight each other, not only you.
 *
 * `peds.ts` already makes a gang member hostile to the PLAYER on their own
 * ground when your standing with them is low enough, and `turf.ts` already
 * knows who hates whom. The missing half was that two gangs who hate each
 * other would walk straight past one another, which is what made the turf map
 * a colouring-in exercise rather than a map of a dispute.
 *
 * Three things had to be got right, and each one is a trap:
 *
 * **Cost.** 200 pedestrians compared pairwise is 20,000 distance checks a
 * tick, on a server with players waiting. They are bucketed by turf cell —
 * a grid the map already carries — and only pairs inside a cell and its four
 * neighbours are considered. O(n) with a small constant.
 *
 * **Attribution.** A gang member shot by another gang member must credit
 * NOBODY, or standing in the right postcode earns you respect for free. Shots
 * fired here carry a negative attacker id, which `creditGangKill` already
 * refuses; the test for it is the most important one in this file.
 *
 * **Restraint.** A city where gangs fight constantly kills every gang member
 * in minutes and leaves the streets empty. Fights only start on contested
 * ground, only `maxConcurrentFights` run at once, and one that nobody wins
 * inside `fightTimeoutTicks` breaks off.
 */

/** Which turf cell a point is in, as a single index. */
function cellOf(map: CityMap, x: number, y: number): number {
  const span = map.turfCellTiles * TILE_SIZE;
  const cx = Math.floor(x / span);
  const cy = Math.floor(y / span);
  return cy * map.turfCellsWide + cx;
}

/**
 * One tick of gang-on-gang violence.
 *
 * Runs after `stepPeds`, at its own fixed slot, so a ped that has already
 * acted this tick as a civilian or as a player-hostile is not also acting
 * here. It draws no random numbers at all.
 */
export function stepGangFights(state: GameState, map: CityMap, events: SimEvent[]): void {
  const gt = getTuning().gangs;
  const rt = getTuning().respect;
  if (gt.maxConcurrentFights <= 0) return;

  // Bucket gang members by turf cell, in ascending id order so the lists are
  // a pure function of the state rather than of iteration luck.
  const buckets = new Map<number, number[]>();
  let fighting = 0;
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped || ped.gangId === 0 || ped.mode === 'downed') continue;
    if (ped.mode === 'fighting') fighting++;
    const cell = cellOf(map, ped.pos.x, ped.pos.y);
    const list = buckets.get(cell);
    if (list) list.push(id);
    else buckets.set(cell, [id]);
  }
  if (buckets.size === 0) return;

  const reach2 = gt.engageRadius * gt.engageRadius;
  const weapon = getWeaponTuning(rt.gangWeapon);

  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped || ped.gangId === 0 || ped.mode === 'downed' || ped.mode === 'hostile') continue;

    // Contested ground only. A gang standing on its own turf is at home, and
    // a city where everybody brawls on their own doorstep is a city at war
    // with itself rather than one with a border dispute.
    const here = gangAt(map, ped.pos.x, ped.pos.y);
    if (gt.contestedOnly && here === ped.gangId) {
      if (ped.mode === 'fighting') ped.mode = 'walk';
      continue;
    }

    const foes = rivalsOf(ped.gangId);
    if (foes.length === 0) continue;

    // Nearest rival in this cell or the four around it.
    let target: PedState | null = null;
    let bestD2 = reach2;
    const cell = cellOf(map, ped.pos.x, ped.pos.y);
    for (const nb of [0, 1, -1, map.turfCellsWide, -map.turfCellsWide]) {
      const list = buckets.get(cell + nb);
      if (!list) continue;
      for (const otherId of list) {
        if (otherId === id) continue;
        const other = state.peds.byId[otherId];
        if (!other || !foes.includes(other.gangId)) continue;
        const dx = other.pos.x - ped.pos.x;
        const dy = other.pos.y - ped.pos.y;
        const d2 = dx * dx + dy * dy;
        // Ties broken by ascending id, which the list order already gives us.
        if (d2 < bestD2) {
          bestD2 = d2;
          target = other;
        }
      }
    }

    if (!target) {
      if (ped.mode === 'fighting') {
        ped.mode = 'walk';
        ped.timer = 0;
      }
      continue;
    }

    // The city-wide cap. Somebody already fighting keeps going; a new fight
    // only starts if there is room for one.
    if (ped.mode !== 'fighting') {
      if (fighting >= gt.maxConcurrentFights) continue;
      fighting++;
      ped.mode = 'fighting';
      ped.timer = 0;
    }

    const dx = target.pos.x - ped.pos.x;
    const dy = target.pos.y - ped.pos.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    ped.dirX = dx / d;
    ped.dirY = dy / d;
    if (ped.timer > 0) ped.timer--;

    // Close, on the same 3-tick cadence the crowd walks on.
    if (d > rt.gangFireRange * 0.7 && (state.tick + ped.id) % 3 === 0) {
      const vel = { x: ped.dirX * rt.gangChaseSpeed, y: ped.dirY * rt.gangChaseSpeed };
      moveWithCollision(map, ped.pos, vel, PED_RADIUS, vel.x * DT * 3, vel.y * DT * 3);
      ped.pos.x = q8(ped.pos.x);
      ped.pos.y = q8(ped.pos.y);
    }

    if (ped.timer === 0 && d <= rt.gangFireRange && weapon) {
      const wall = rayWallDistance(map, ped.pos.x, ped.pos.y, ped.dirX, ped.dirY, d);
      events.push({
        type: 'shot',
        tick: state.tick,
        // Negative, like the police and like a player-hostile gang member:
        // a shot nobody can be blamed for by name.
        playerId: -ped.id,
        x0: Math.round(ped.pos.x),
        y0: Math.round(ped.pos.y),
        x1: Math.round(ped.pos.x + ped.dirX * Math.min(wall, d)),
        y1: Math.round(ped.pos.y + ped.dirY * Math.min(wall, d)),
      });
      if (wall >= d) {
        // -1: nobody gets the credit, and nobody gets the respect. This is
        // the line that stops standing in the right postcode being an
        // earning strategy.
        damagePed(state, target, weapon.damage, -1, events);
        events.push({
          type: 'gangFight',
          tick: state.tick,
          gangId: ped.gangId,
          rivalId: target.gangId,
          x: Math.round(ped.pos.x),
          y: Math.round(ped.pos.y),
        });
      }
      ped.timer = rt.gangFireCooldownTicks;
    }
  }
}
