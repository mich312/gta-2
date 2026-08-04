import type { Vec2 } from '../math/vec.js';
import { BEV_NE, BEV_NONE, BEV_NW, BEV_SE, BEV_SW, bevelOther, inCutHalf, oppositeHalf } from './bevel.js';
import {
  T_BRIDGE,
  T_BUILDING,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type CityMap,
  type ShoreIndex,
} from './types.js';

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

/** The whole-tile solidity rule, before bevels or the shore have their say. */
function plainSolid(tile: number, medium: Medium): boolean {
  if (medium === 'water') return tile !== T_WATER && tile !== T_BRIDGE;
  // Forest is solid like a building: woods are driven around, not through.
  return tile === T_BUILDING || tile === T_WATER || tile === T_TREES;
}

/**
 * Solid by MATERIAL, with the water question left to the shore.
 *
 * What a land mover is stopped by that has nothing to do with the coastline.
 * A boat has no such category — the only thing that stops a hull is land —
 * which is why this answers false for it.
 */
function materialSolid(tile: number, medium: Medium): boolean {
  if (medium === 'water') return false;
  return tile === T_BUILDING || tile === T_TREES;
}

/* ------------------------------------------------------------------ */
/* The shore, as a wall                                                */
/* ------------------------------------------------------------------ */

/**
 * The shore edges collision should consult in this tile, as a range into the
 * index, or null where there are none and the tile byte still decides.
 *
 * A bridge deck always answers null. The rings are traced from the tile
 * plane, where a deck is not water, so the sea has a deck-shaped hole in it
 * (WORLDGEN.md §17.11); `buildShoreIndex` drops the edges that bound one, and
 * this drops any genuine shoreline edge that happens to cross a deck tile at
 * an abutment. A deck is a deck in both media: a car drives its length and a
 * boat passes under it, and neither is a question about the waterline.
 */
function shoreRange(map: CityMap, tx: number, ty: number): readonly [number, number] | null {
  const idx = map.shoreIndex;
  if (idx === undefined) return null;
  const i = ty * map.widthTiles + tx;
  const from = idx.offset[i] as number;
  const to = idx.offset[i + 1] as number;
  if (from === to) return null;
  if (map.tiles[i] === T_BRIDGE) return null;
  return [from, to];
}

/**
 * Is the point on the solid side of this tile's shore edges?
 *
 * Within one tile the water is the UNION of its edges' water half-planes.
 * That is exact where the shoreline turns a corner out to sea — a headland's
 * two edges bound water on both sides of it — and errs toward solid where it
 * turns a corner inland, by up to the width of a notch narrower than a tile.
 * Erring toward solid is the direction this file already errs in everywhere
 * else, and a sub-tile notch filled in is a notch nothing could have entered.
 */
function shoreSolidAt(
  map: CityMap,
  range: readonly [number, number],
  x: number,
  y: number,
  medium: Medium,
): boolean {
  const idx = map.shoreIndex as ShoreIndex;
  let wet = false;
  for (let k = range[0]; k < range[1]; k++) {
    const e = idx.items[k] as number;
    if ((idx.nx[e] as number) * x + (idx.ny[e] as number) * y >= (idx.c[e] as number)) {
      wet = true;
      break;
    }
  }
  // A hull is stopped by everything the wheels are not.
  return medium === 'water' ? !wet : wet;
}

/**
 * Does the box clipped to this tile overlap the shore's solid side?
 *
 * A box meets a half-plane exactly when its corner deepest along the normal
 * does, so a land mover's answer is four multiplications per edge. A hull's
 * solid is the intersection, so its answer is whether anything survives the
 * clip — the same polygon `shoreFace` measures.
 */
function shoreOverlaps(
  map: CityMap,
  range: readonly [number, number],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  medium: Medium,
): boolean {
  const idx = map.shoreIndex as ShoreIndex;
  if (medium === 'water') return clipDry(map, range, x0, y0, x1, y1) > 0;
  for (let k = range[0]; k < range[1]; k++) {
    const e = idx.items[k] as number;
    const nx = idx.nx[e] as number;
    const ny = idx.ny[e] as number;
    const c = idx.c[e] as number;
    if (nx * (nx > 0 ? x1 : x0) + ny * (ny > 0 ? y1 : y0) >= c) return true;
  }
  return false;
}

/**
 * How far into a tile the half-plane `nx*x + ny*y >= c` reaches along one
 * axis, over the span `[lo, hi]` across it.
 *
 * The general case of what `faceX` has been doing for bevels all along: a
 * bevel is this with a slope of exactly one, switched on a byte instead of
 * read from an edge. `nAlong` and `nAcross` are the normal's components along
 * and across the axis of travel, so one function serves both axes. `sign > 0`
 * asks for the near face of the solid, `sign < 0` for the far one; the answer
 * is ±Infinity when nothing in this tile is in the way.
 *
 * The bound is linear in the across-coordinate, so its extremes over the span
 * are at the ends of the span and there is nothing to search. One division,
 * exactly rounded, and no other inexact operation.
 */
function planeFace(
  nAlong: number,
  nAcross: number,
  c: number,
  a0: number,
  a1: number,
  lo: number,
  hi: number,
  sign: number,
): number {
  const open = sign > 0 ? Infinity : -Infinity;
  if (nAlong === 0) {
    // The half-plane does not vary along the axis of travel: it either covers
    // part of this span or none of it.
    const reached = nAcross > 0 ? nAcross * hi >= c : nAcross < 0 ? nAcross * lo >= c : c <= 0;
    if (!reached) return open;
    return sign > 0 ? a0 : a1;
  }
  const b0 = (c - nAcross * lo) / nAlong;
  const b1 = (c - nAcross * hi) / nAlong;
  const bMin = b0 < b1 ? b0 : b1;
  const bMax = b0 < b1 ? b1 : b0;
  if (nAlong > 0) {
    // Solid is everything at or beyond the bound.
    if (sign > 0) return bMin >= a1 ? open : bMin > a0 ? bMin : a0;
    return bMin <= a1 ? a1 : open;
  }
  // nAlong < 0: solid is everything at or before the bound.
  if (sign > 0) return bMax >= a0 ? a0 : open;
  return bMax < a0 ? open : bMax < a1 ? bMax : a1;
}

/**
 * The dry part of a rect inside one tile, as a convex polygon.
 *
 * For a land mover the water is the UNION of its tile's edges' half-planes,
 * which any single edge can answer for. For a hull the land is the
 * INTERSECTION of their complements, which none of them can — and nearly half
 * this city's shore tiles carry more than one edge, so approximating that
 * intersection puts invisible walls in open water where a coast turns a
 * corner. So it is computed rather than approximated: Sutherland–Hodgman, the
 * rect clipped by each dry half-plane in turn. At most four half-planes
 * against a rectangle, so at most eight vertices.
 *
 * Returns the vertex count, 0 when nothing in the rect is dry, and leaves the
 * polygon in the module scratch below.
 */
const CLIP_MAX = 16;
const clipX = new Float64Array(CLIP_MAX);
const clipY = new Float64Array(CLIP_MAX);
const clipNextX = new Float64Array(CLIP_MAX);
const clipNextY = new Float64Array(CLIP_MAX);

function clipDry(
  map: CityMap,
  range: readonly [number, number],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const idx = map.shoreIndex as ShoreIndex;
  let n = 4;
  clipX[0] = x0;
  clipY[0] = y0;
  clipX[1] = x1;
  clipY[1] = y0;
  clipX[2] = x1;
  clipY[2] = y1;
  clipX[3] = x0;
  clipY[3] = y1;
  for (let k = range[0]; k < range[1] && n > 0; k++) {
    const e = idx.items[k] as number;
    const nx = idx.nx[e] as number;
    const ny = idx.ny[e] as number;
    const c = idx.c[e] as number;
    let m = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const px = clipX[j] as number;
      const py = clipY[j] as number;
      const qx = clipX[i] as number;
      const qy = clipY[i] as number;
      const dp = nx * px + ny * py - c;
      const dq = nx * qx + ny * qy - c;
      if (dp <= 0 !== dq <= 0 && m < CLIP_MAX) {
        const t = dp / (dp - dq);
        clipNextX[m] = px + (qx - px) * t;
        clipNextY[m] = py + (qy - py) * t;
        m++;
      }
      if (dq <= 0 && m < CLIP_MAX) {
        clipNextX[m] = qx;
        clipNextY[m] = qy;
        m++;
      }
    }
    n = m;
    for (let i = 0; i < n; i++) {
      clipX[i] = clipNextX[i] as number;
      clipY[i] = clipNextY[i] as number;
    }
  }
  return n;
}

/**
 * The face the shore presents in one tile, or ±Infinity for none.
 *
 * Two different questions wearing one name. A land mover is stopped by the
 * union of the water half-planes, so the blocking face is the nearest of them
 * and each can be answered on its own — the fast path, and the one every car,
 * pedestrian and bullet in the game takes. A hull is stopped by the land,
 * which is what all the half-planes agree on, so its face comes off the
 * clipped polygon.
 */
function shoreFace(
  map: CityMap,
  range: readonly [number, number],
  a0: number,
  a1: number,
  lo: number,
  hi: number,
  sign: number,
  medium: Medium,
  alongX: boolean,
  lead: number,
): number {
  const idx = map.shoreIndex as ShoreIndex;
  const open = sign > 0 ? Infinity : -Infinity;
  // A face the leading edge has already passed is a wall behind the mover and
  // cannot stop it. This has to be applied to each edge SEPARATELY, before
  // they are combined: a tile where the shore turns holds one edge whose
  // water is ahead and another whose water is behind, and letting the one
  // behind into the union hides the one that should block.
  const ahead = (f: number): boolean => (sign > 0 ? f >= lead : f <= lead);
  if (medium === 'water') {
    const n = alongX
      ? clipDry(map, range, a0, lo, a1, hi)
      : clipDry(map, range, lo, a0, hi, a1);
    if (n === 0) return open;
    let limit = open;
    for (let i = 0; i < n; i++) {
      const v = (alongX ? clipX[i] : clipY[i]) as number;
      if (sign > 0 ? v < limit : v > limit) limit = v;
    }
    return ahead(limit) ? limit : open;
  }
  let limit = open;
  for (let k = range[0]; k < range[1]; k++) {
    const e = idx.items[k] as number;
    const nx = idx.nx[e] as number;
    const ny = idx.ny[e] as number;
    const c = idx.c[e] as number;
    const f = alongX
      ? planeFace(nx, ny, c, a0, a1, lo, hi, sign)
      : planeFace(ny, nx, c, a0, a1, lo, hi, sign);
    if (!ahead(f)) continue;
    if (sign > 0 ? f < limit : f > limit) limit = f;
  }
  return limit;
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

/**
 * Point query, exact to the shoreline: the waterline itself counts as solid,
 * a bevel's diagonal as open.
 *
 * Where the tile carries shore edges they are the whole answer to "is this
 * water" and the tile's own byte only still supplies its walls; everywhere
 * else this is the bevel query it has always been.
 */
export function isSolidAtWorld(
  map: CityMap,
  x: number,
  y: number,
  medium: Medium = 'land',
): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  const range = shoreRange(map, tx, ty);
  if (range !== null) {
    if (materialSolid(map.tiles[ty * map.widthTiles + tx] as number, medium)) return true;
    return shoreSolidAt(map, range, x, y, medium);
  }
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
  lead: number,
): number {
  const open = sign > 0 ? Infinity : -Infinity;
  const range = shoreRange(map, tx, ty);
  if (range !== null) {
    const x0w = tx * TILE_SIZE;
    const ty0w = ty * TILE_SIZE;
    const lo = Math.max(y0, ty0w);
    const hi = Math.min(y1, ty0w + TILE_SIZE);
    if (hi < lo) return open;
    const shore = shoreFace(map, range, x0w, x0w + TILE_SIZE, lo, hi, sign, medium, true, lead);
    // The byte still owns the walls, and a wall fills its tile: union with
    // the shore by taking whichever face comes first.
    if (!materialSolid(map.tiles[ty * map.widthTiles + tx] as number, medium)) return shore;
    return sign > 0 ? Math.min(shore, x0w) : Math.max(shore, x0w + TILE_SIZE);
  }
  const part = solidPartAt(map, tx, ty, medium);
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
  lead: number,
): number {
  const open = sign > 0 ? Infinity : -Infinity;
  const range = shoreRange(map, tx, ty);
  if (range !== null) {
    const y0w = ty * TILE_SIZE;
    const tx0w = tx * TILE_SIZE;
    const lo = Math.max(x0, tx0w);
    const hi = Math.min(x1, tx0w + TILE_SIZE);
    if (hi < lo) return open;
    const shore = shoreFace(map, range, y0w, y0w + TILE_SIZE, lo, hi, sign, medium, false, lead);
    if (!materialSolid(map.tiles[ty * map.widthTiles + tx] as number, medium)) return shore;
    return sign > 0 ? Math.min(shore, y0w) : Math.max(shore, y0w + TILE_SIZE);
  }
  const part = solidPartAt(map, tx, ty, medium);
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
 * Push a box back out of shore it has ended up inside.
 *
 * Resolving the axes in turn cannot avoid this. `faceX` clamps x against the
 * rows the box is in, then y moves it to different rows, and against a SLOPED
 * face the wall is somewhere else there — so a diagonal step into a bay can
 * finish with a corner in the sea. Against tiles the problem does not exist,
 * because a tile's faces are square to the axes and moving along one never
 * changes where the other one is; it arrives with the shoreline and has to be
 * answered here rather than designed away.
 *
 * Measured before this existed: one move in sixty near a shore ended inside
 * the water, by 0.9 px at the median and 14 px at the worst — a car's length
 * of it, which is a thing you would see. Afterwards, none.
 *
 * The push is along the deepest violated edge's normal, repeated a few times
 * because a corner can violate two at once. It moves the mover and not its
 * velocity: this is not a collision, it is the correction for having resolved
 * one, and a mover that has just been stopped by a wall should not also be
 * launched away from it.
 */
function resolveShore(map: CityMap, pos: Vec2, half: number, medium: Medium): void {
  const idx = map.shoreIndex;
  if (idx === undefined || medium === 'water') return;
  const w = map.widthTiles;
  for (let iter = 0; iter < 3; iter++) {
    let worst = 0;
    let px = 0;
    let py = 0;
    const tx1 = Math.floor((pos.x - half) / TILE_SIZE);
    const tx2 = Math.floor((pos.x + half - EPS) / TILE_SIZE);
    const ty1 = Math.floor((pos.y - half) / TILE_SIZE);
    const ty2 = Math.floor((pos.y + half - EPS) / TILE_SIZE);
    for (let ty = ty1; ty <= ty2; ty++) {
      for (let tx = tx1; tx <= tx2; tx++) {
        const range = shoreRange(map, tx, ty);
        if (range === null) continue;
        for (let k = range[0]; k < range[1]; k++) {
          const e = idx.items[k] as number;
          const nx = idx.nx[e] as number;
          const ny = idx.ny[e] as number;
          // The corner deepest into the water, clipped to this tile — the
          // same point `shoreOverlaps` tests, so the two cannot disagree
          // about whether there is anything to resolve.
          const cx = nx > 0
            ? Math.min(pos.x + half - EPS, (tx + 1) * TILE_SIZE)
            : Math.max(pos.x - half + EPS, tx * TILE_SIZE);
          const cy = ny > 0
            ? Math.min(pos.y + half - EPS, (ty + 1) * TILE_SIZE)
            : Math.max(pos.y - half + EPS, ty * TILE_SIZE);
          const d = (nx * cx + ny * cy - (idx.c[e] as number)) * (idx.inv[e] as number);
          if (d > worst) {
            worst = d;
            px = nx * (idx.inv[e] as number);
            py = ny * (idx.inv[e] as number);
          }
        }
      }
    }
    if (worst <= 0) return;
    pos.x -= px * (worst + EPS);
    pos.y -= py * (worst + EPS);
  }
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
    resolveShore(map, pos, half, medium);
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
      // Every column the leading edge SWEEPS, not only the one it lands in.
      // A tile used to be all solid or all open, so testing the destination
      // was enough; a tile crossed by a shoreline has solid part-way into it,
      // and a mover already standing in one would walk into the half of it
      // that is sea. At most two columns: a sub-step is half a tile.
      //
      // `lead` is what keeps that honest. A tile the mover is standing IN
      // also holds the face it came past to get there, and a wall behind you
      // does not stop you — without the guard, walking away from a shore
      // clamps you back through it.
      const lead = pos.x + half;
      const txFrom = Math.floor(lead / TILE_SIZE);
      const txTo = Math.floor((nx + half) / TILE_SIZE);
      let limit = Infinity;
      for (let tx = txFrom; tx <= txTo; tx++) {
        for (let ty = ty1; ty <= ty2; ty++) {
          const b = faceX(map, tx, ty, y0, y1, 1, medium, lead);
          if (b < limit && b >= lead) limit = b;
        }
      }
      if (nx + half > limit) {
        pos.x = limit - half - EPS;
        vel.x = 0;
        hitX = true;
      } else {
        pos.x = nx;
      }
    } else {
      const lead = pos.x - half;
      const txFrom = Math.floor((nx - half) / TILE_SIZE);
      const txTo = Math.floor(lead / TILE_SIZE);
      let limit = -Infinity;
      for (let tx = txFrom; tx <= txTo; tx++) {
        for (let ty = ty1; ty <= ty2; ty++) {
          const b = faceX(map, tx, ty, y0, y1, -1, medium, lead);
          if (b > limit && b <= lead) limit = b;
        }
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
      const lead = pos.y + half;
      const tyFrom = Math.floor(lead / TILE_SIZE);
      const tyTo = Math.floor((ny + half) / TILE_SIZE);
      let limit = Infinity;
      for (let ty = tyFrom; ty <= tyTo; ty++) {
        for (let tx = tx1; tx <= tx2; tx++) {
          const b = faceY(map, tx, ty, x0, x1, 1, medium, lead);
          if (b < limit && b >= lead) limit = b;
        }
      }
      if (ny + half > limit) {
        pos.y = limit - half - EPS;
        vel.y = 0;
        hitY = true;
      } else {
        pos.y = ny;
      }
    } else {
      const lead = pos.y - half;
      const tyFrom = Math.floor((ny - half) / TILE_SIZE);
      const tyTo = Math.floor(lead / TILE_SIZE);
      let limit = -Infinity;
      for (let ty = tyFrom; ty <= tyTo; ty++) {
        for (let tx = tx1; tx <= tx2; tx++) {
          const b = faceY(map, tx, ty, x0, x1, -1, medium, lead);
          if (b > limit && b <= lead) limit = b;
        }
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
      const range = shoreRange(map, tx, ty);
      if (range !== null) {
        // Trimmed at BOTH ends, unlike the tile path below: the shore is a
        // sloped face a mover comes to rest exactly on, so the box has to be
        // open at the near corner as well as the far one.
        const bx0 = Math.max(pos.x - half + EPS, tx * TILE_SIZE);
        const bx1 = Math.min(pos.x + half - EPS, (tx + 1) * TILE_SIZE);
        const by0 = Math.max(pos.y - half + EPS, ty * TILE_SIZE);
        const by1 = Math.min(pos.y + half - EPS, (ty + 1) * TILE_SIZE);
        if (materialSolid(map.tiles[ty * map.widthTiles + tx] as number, medium)) return true;
        if (shoreOverlaps(map, range, bx0, by0, bx1, by1, medium)) return true;
        continue;
      }
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
