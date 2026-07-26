import type { Vec2 } from '../math/vec.js';
import { T_BUILDING, T_WATER, TILE_SIZE, type CityMap } from './types.js';

const EPS = 0.001;

/** Tile-solidity predicate — pick the medium (ground movement vs boats). */
export type SolidFn = (map: CityMap, tx: number, ty: number) => boolean;

/** Solid for ground movement: buildings, open water, anything off-map. */
export function isSolidTile(map: CityMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  const t = map.tiles[ty * map.widthTiles + tx];
  return t === T_BUILDING || t === T_WATER;
}

/** Solid for boats: everything that isn't water. */
export function isSolidForBoat(map: CityMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  return map.tiles[ty * map.widthTiles + tx] !== T_WATER;
}

/** Blocks bullets and line of sight: buildings only — shots carry over water. */
export function isShotBlockingTile(map: CityMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  return map.tiles[ty * map.widthTiles + tx] === T_BUILDING;
}

export function isSolidAtWorld(map: CityMap, x: number, y: number): boolean {
  return isSolidTile(map, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
}

function solidInRange(
  map: CityMap,
  tx: number,
  ty1: number,
  ty2: number,
  vertical: boolean,
  solid: SolidFn,
): boolean {
  for (let t = ty1; t <= ty2; t++) {
    if (vertical ? solid(map, t, tx) : solid(map, tx, t)) return true;
  }
  return false;
}

/**
 * Axis-separated AABB-vs-tile movement for a box of half-extent `half`.
 * Mutates pos/vel: blocked axes clamp flush to the tile edge and zero their
 * velocity. Large deltas are sub-stepped (≤ half a tile per step) so fast
 * movers (vehicles) can never tunnel through a wall. Exact ops only — this
 * runs inside prediction.
 */
export function moveWithCollision(
  map: CityMap,
  pos: Vec2,
  vel: Vec2,
  half: number,
  dx: number,
  dy: number,
  solid: SolidFn = isSolidTile,
): void {
  const maxStep = TILE_SIZE / 2;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep));
  let sx = dx / steps;
  let sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    const [hitX, hitY] = moveOnce(map, pos, vel, half, sx, sy, solid);
    if (hitX) sx = 0;
    if (hitY) sy = 0;
    if (sx === 0 && sy === 0) break;
  }
}

/** One bounded sub-step. Returns [hitX, hitY]. */
function moveOnce(
  map: CityMap,
  pos: Vec2,
  vel: Vec2,
  half: number,
  dx: number,
  dy: number,
  solid: SolidFn,
): [boolean, boolean] {
  let hitX = false;
  let hitY = false;
  // X axis
  if (dx !== 0) {
    const nx = pos.x + dx;
    const ty1 = Math.floor((pos.y - half) / TILE_SIZE);
    const ty2 = Math.floor((pos.y + half - EPS) / TILE_SIZE);
    if (dx > 0) {
      const tx = Math.floor((nx + half) / TILE_SIZE);
      if (solidInRange(map, tx, ty1, ty2, false, solid)) {
        pos.x = tx * TILE_SIZE - half - EPS;
        vel.x = 0;
        hitX = true;
      } else {
        pos.x = nx;
      }
    } else {
      const tx = Math.floor((nx - half) / TILE_SIZE);
      if (solidInRange(map, tx, ty1, ty2, false, solid)) {
        pos.x = (tx + 1) * TILE_SIZE + half + EPS;
        vel.x = 0;
        hitX = true;
      } else {
        pos.x = nx;
      }
    }
  }
  // Y axis
  if (dy !== 0) {
    const ny = pos.y + dy;
    const tx1 = Math.floor((pos.x - half) / TILE_SIZE);
    const tx2 = Math.floor((pos.x + half - EPS) / TILE_SIZE);
    if (dy > 0) {
      const ty = Math.floor((ny + half) / TILE_SIZE);
      if (solidInRange(map, ty, tx1, tx2, true, solid)) {
        pos.y = ty * TILE_SIZE - half - EPS;
        vel.y = 0;
        hitY = true;
      } else {
        pos.y = ny;
      }
    } else {
      const ty = Math.floor((ny - half) / TILE_SIZE);
      if (solidInRange(map, ty, tx1, tx2, true, solid)) {
        pos.y = (ty + 1) * TILE_SIZE + half + EPS;
        vel.y = 0;
        hitY = true;
      } else {
        pos.y = ny;
      }
    }
  }
  return [hitX, hitY];
}

/** True if the box at pos overlaps any solid tile (sanity checks/tests). */
export function boxInSolid(map: CityMap, pos: Vec2, half: number, solid: SolidFn = isSolidTile): boolean {
  const tx1 = Math.floor((pos.x - half) / TILE_SIZE);
  const tx2 = Math.floor((pos.x + half - EPS) / TILE_SIZE);
  const ty1 = Math.floor((pos.y - half) / TILE_SIZE);
  const ty2 = Math.floor((pos.y + half - EPS) / TILE_SIZE);
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      if (solid(map, tx, ty)) return true;
    }
  }
  return false;
}
