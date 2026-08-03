import type { Vec2 } from '../math/vec.js';
import { BEV_NE, BEV_NONE, BEV_NW, BEV_SE, BEV_SW, bevelOther, inCutHalf, oppositeHalf } from './bevel.js';
import { T_BRIDGE, T_BUILDING, T_TREES, T_WATER, TILE_SIZE, type CityMap } from './types.js';

const EPS = 0.001;

/**
 * What a mover travels through. Land movers (people, cars) are stopped by
 * buildings and water; boats are stopped by everything that is not water.
 * A bridge tile carries both: road over the top, river underneath.
 *
 * This parameter threads through the whole collision path, which runs inside
 * client prediction — so every branch here must stay exact-op only and must
 * behave identically on both hosts.
 */
/**
 * What a vehicle moves through.
 *
 * 'air' is here so the type lines up with `VehicleTuning.medium`, but an
 * aircraft ON THE GROUND is a heavy thing on wheels and collides like one —
 * clearing the city is a property of altitude, not of the medium, and it is
 * handled where altitude is (`integrateVehicle`'s airborne path). So 'air'
 * deliberately falls through to the land rules here.
 */
export type Medium = 'land' | 'water' | 'air';

/** The whole-tile solidity rule, before bevels have their say. */
function plainSolid(tile: number, medium: Medium): boolean {
  if (medium === 'water') return tile !== T_WATER && tile !== T_BRIDGE;
  // Forest is solid like a building: woods are driven around, not through.
  return tile === T_BUILDING || tile === T_WATER || tile === T_TREES;
}

/**
 * Solid for movement in the given medium — the WHOLE tile, bevels ignored.
 *
 * Kept deliberately coarse: every placement pass, every wander/steering
 * heuristic and every "is this spot sane" check reads this, and they all
 * want the conservative answer. A bevelled water tile is still water to
 * anything deciding where to stand; only the movement solver below, which
 * knows exactly where a box is inside a tile, is allowed the finer one.
 * Outside the map is always solid.
 */
export function isSolidTile(
  map: CityMap,
  tx: number,
  ty: number,
  medium: Medium = 'land',
): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  const tile = map.tiles[ty * map.widthTiles + tx];
  const base = plainSolid(tile as number, medium);
  if (base) return true;
  // A tile whose cut half is solid — the water wedge bitten out of a
  // headland — still answers solid, so the conservative readers above
  // never send anybody to stand on a corner that is half sea.
  const code = map.bevel ? (map.bevel[ty * map.widthTiles + tx] as number) : BEV_NONE;
  if (code === BEV_NONE) return false;
  return plainSolid(bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty), medium);
}

/** No part of the tile is solid in this medium. */
export const PART_NONE = 0;
/** The whole tile is solid — the overwhelming default for solid ground. */
export const PART_FULL = 5;

/**
 * Which part of a tile is solid in the given medium: `PART_NONE`,
 * `PART_FULL`, or a `BEV_*` half code naming the solid half.
 *
 * This is where the diagonal shoreline meets the movement solver. On a
 * bevelled tile the two halves are different materials; whichever half's
 * material is solid in this medium is the wall, and its hypotenuse is a
 * 45° face you slide along rather than a staircase you snag on. When both
 * halves agree — a sand/grass bevel under a land mover — the answer
 * collapses back to FULL or NONE and the solver never notices the bevel.
 */
export function solidPartAt(
  map: CityMap,
  tx: number,
  ty: number,
  medium: Medium = 'land',
): number {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return PART_FULL;
  const i = ty * map.widthTiles + tx;
  const base = plainSolid(map.tiles[i] as number, medium);
  const code = map.bevel ? (map.bevel[i] as number) : BEV_NONE;
  if (code === BEV_NONE) return base ? PART_FULL : PART_NONE;
  const other = plainSolid(
    bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty),
    medium,
  );
  if (base === other) return base ? PART_FULL : PART_NONE;
  return other ? code : oppositeHalf(code);
}

/** Point query, bevel-exact: the diagonal itself counts as open. */
export function isSolidAtWorld(
  map: CityMap,
  x: number,
  y: number,
  medium: Medium = 'land',
): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  const part = solidPartAt(map, tx, ty, medium);
  if (part === PART_FULL) return true;
  if (part === PART_NONE) return false;
  return inCutHalf(part, x - tx * TILE_SIZE, y - ty * TILE_SIZE);
}

/**
 * The face a box's leading edge may not cross, moving along x into tile
 * (tx,ty). `y0..y1` is the box's y-extent; `sign` the direction of travel.
 * Answers ±Infinity when nothing in this tile is in the way.
 *
 * For a whole solid tile this is the tile face, exactly as before. For a
 * solid HALF it is the hypotenuse evaluated at the box corner nearest the
 * solid — a linear bound, exact ops only, which is what lets a mover pressed
 * against a diagonal shore advance along it as its other axis moves.
 */
function faceX(
  map: CityMap,
  tx: number,
  ty: number,
  y0: number,
  y1: number,
  sign: number,
  medium: Medium,
): number {
  const part = solidPartAt(map, tx, ty, medium);
  const open = sign > 0 ? Infinity : -Infinity;
  if (part === PART_NONE) return open;
  const x0 = tx * TILE_SIZE;
  const ty0 = ty * TILE_SIZE;
  const yLo = Math.max(y0, ty0) - ty0;
  const yHi = Math.min(y1, ty0 + TILE_SIZE) - ty0;
  if (yHi < yLo) return open;
  if (sign > 0) {
    // The solid's western extent across the box's rows.
    if (part === BEV_NE) return x0 + yLo;
    if (part === BEV_SE) return x0 + TILE_SIZE - yHi;
    return x0; // FULL, SW and NW all hug the west face.
  }
  // The solid's eastern extent.
  if (part === BEV_SW) return x0 + yHi;
  if (part === BEV_NW) return x0 + TILE_SIZE - yLo;
  return x0 + TILE_SIZE;
}

/** `faceX`'s twin for movement along y. */
function faceY(
  map: CityMap,
  tx: number,
  ty: number,
  x0: number,
  x1: number,
  sign: number,
  medium: Medium,
): number {
  const part = solidPartAt(map, tx, ty, medium);
  const open = sign > 0 ? Infinity : -Infinity;
  if (part === PART_NONE) return open;
  const y0 = ty * TILE_SIZE;
  const tx0 = tx * TILE_SIZE;
  const xLo = Math.max(x0, tx0) - tx0;
  const xHi = Math.min(x1, tx0 + TILE_SIZE) - tx0;
  if (xHi < xLo) return open;
  if (sign > 0) {
    // The solid's northern extent across the box's columns.
    if (part === BEV_SW) return y0 + xLo;
    if (part === BEV_SE) return y0 + TILE_SIZE - xHi;
    return y0; // FULL, NE and NW all hug the north face.
  }
  // The solid's southern extent.
  if (part === BEV_NE) return y0 + xHi;
  if (part === BEV_NW) return y0 + TILE_SIZE - xLo;
  return y0 + TILE_SIZE;
}

/**
 * Axis-separated AABB-vs-tile movement for a box of half-extent `half`.
 * Mutates pos/vel: blocked axes clamp flush to the blocking face — a tile
 * edge, or a bevel's hypotenuse where the shoreline runs diagonally — and
 * zero their velocity. Large deltas are sub-stepped (≤ half a tile per step)
 * so fast movers (vehicles) can never tunnel through a wall. Exact ops only —
 * this runs inside prediction.
 */
export function moveWithCollision(
  map: CityMap,
  pos: Vec2,
  vel: Vec2,
  half: number,
  dx: number,
  dy: number,
  medium: Medium = 'land',
): void {
  const maxStep = TILE_SIZE / 2;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep));
  let sx = dx / steps;
  let sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    const [hitX, hitY] = moveOnce(map, pos, vel, half, sx, sy, medium);
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
  medium: Medium = 'land',
): [boolean, boolean] {
  let hitX = false;
  let hitY = false;
  // X axis
  if (dx !== 0) {
    const nx = pos.x + dx;
    const y0 = pos.y - half;
    const y1 = pos.y + half - EPS;
    const ty1 = Math.floor(y0 / TILE_SIZE);
    const ty2 = Math.floor(y1 / TILE_SIZE);
    if (dx > 0) {
      const tx = Math.floor((nx + half) / TILE_SIZE);
      let limit = Infinity;
      for (let ty = ty1; ty <= ty2; ty++) {
        const b = faceX(map, tx, ty, y0, y1, 1, medium);
        if (b < limit) limit = b;
      }
      if (nx + half > limit) {
        pos.x = limit - half - EPS;
        vel.x = 0;
        hitX = true;
      } else {
        pos.x = nx;
      }
    } else {
      const tx = Math.floor((nx - half) / TILE_SIZE);
      let limit = -Infinity;
      for (let ty = ty1; ty <= ty2; ty++) {
        const b = faceX(map, tx, ty, y0, y1, -1, medium);
        if (b > limit) limit = b;
      }
      if (nx - half < limit) {
        pos.x = limit + half + EPS;
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
    const x0 = pos.x - half;
    const x1 = pos.x + half - EPS;
    const tx1 = Math.floor(x0 / TILE_SIZE);
    const tx2 = Math.floor(x1 / TILE_SIZE);
    if (dy > 0) {
      const ty = Math.floor((ny + half) / TILE_SIZE);
      let limit = Infinity;
      for (let tx = tx1; tx <= tx2; tx++) {
        const b = faceY(map, tx, ty, x0, x1, 1, medium);
        if (b < limit) limit = b;
      }
      if (ny + half > limit) {
        pos.y = limit - half - EPS;
        vel.y = 0;
        hitY = true;
      } else {
        pos.y = ny;
      }
    } else {
      const ty = Math.floor((ny - half) / TILE_SIZE);
      let limit = -Infinity;
      for (let tx = tx1; tx <= tx2; tx++) {
        const b = faceY(map, tx, ty, x0, x1, -1, medium);
        if (b > limit) limit = b;
      }
      if (ny - half < limit) {
        pos.y = limit + half + EPS;
        vel.y = 0;
        hitY = true;
      } else {
        pos.y = ny;
      }
    }
  }
  return [hitX, hitY];
}

/** True if the box at pos overlaps any solid part (sanity checks/tests). */
export function boxInSolid(
  map: CityMap,
  pos: Vec2,
  half: number,
  medium: Medium = 'land',
): boolean {
  const tx1 = Math.floor((pos.x - half) / TILE_SIZE);
  const tx2 = Math.floor((pos.x + half - EPS) / TILE_SIZE);
  const ty1 = Math.floor((pos.y - half) / TILE_SIZE);
  const ty2 = Math.floor((pos.y + half - EPS) / TILE_SIZE);
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      const part = solidPartAt(map, tx, ty, medium);
      if (part === PART_NONE) continue;
      if (part === PART_FULL) return true;
      // The box clipped to this tile, then its corner deepest into the
      // solid half: a box overlaps a half-plane iff that corner does.
      const bx0 = Math.max(pos.x - half, tx * TILE_SIZE) - tx * TILE_SIZE;
      const bx1 = Math.min(pos.x + half - EPS, (tx + 1) * TILE_SIZE) - tx * TILE_SIZE;
      const by0 = Math.max(pos.y - half, ty * TILE_SIZE) - ty * TILE_SIZE;
      const by1 = Math.min(pos.y + half - EPS, (ty + 1) * TILE_SIZE) - ty * TILE_SIZE;
      if (part === BEV_NE && bx1 > by0) return true;
      if (part === BEV_SW && bx0 < by1) return true;
      if (part === BEV_SE && bx1 + by1 > TILE_SIZE) return true;
      if (part === BEV_NW && bx0 + by0 < TILE_SIZE) return true;
    }
  }
  return false;
}
