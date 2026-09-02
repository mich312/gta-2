import type { Vec2 } from '../math/vec.js';
import { BEV_NE, BEV_NONE, BEV_NW, BEV_SE, BEV_SW, bevelOther, inCutHalf, oppositeHalf } from './bevel.js';
import { T_BRIDGE, T_BUILDING, T_TREES, T_WATER, TILE_SIZE, type CityMap } from './types.js';
import { TREE_Z, wallTopAt } from './volume.js';

const EPS = 0.001;

/**
 * How far past a face a mover must be before that face stops counting as
 * something in front of it. Half a pixel: far above the slack a flush clamp
 * leaves, far below anything a mover can be genuinely embedded by.
 *
 * Both bounds matter. A face already behind you must not block, or a mover
 * that starts inside a solid — spawned in one, or shunted through by a car —
 * is clamped back in every tick instead of being able to walk out the way it
 * came. But "behind you" cannot be read off the leading edge exactly: the
 * axes move one at a time and a sloped face is a function of the OTHER axis,
 * so the x step slides the y face by a fraction of a pixel and a box that was
 * flush comes out a hair inside. Read strictly, that hair reads as "behind"
 * and the mover sinks (§43).
 */
const FLUSH = 0.5;

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

/**
 * The whole-tile solidity rule, before bevels have their say.
 *
 * `z0` is the mover's feet and `top` the top of whatever stands on the tile
 * (3D.md X2): a building or a wood is a wall only to a mover whose feet are
 * below its roof or canopy, and somebody falling out of a helicopter over a
 * low block lands on it instead of being stopped by it. Water is a wall at
 * every height — nothing on land has business over open sea — and on a map
 * with no heights `top` is infinite, so every wall reaches every mover and
 * the flat answers stand.
 */
function plainSolid(tile: number, medium: Medium, z0 = 0, top = Infinity): boolean {
  if (medium === 'water') return tile !== T_WATER && tile !== T_BRIDGE;
  // Forest is solid like a building: woods are driven around, not through.
  if (tile === T_BUILDING || tile === T_TREES) return z0 < top;
  return tile === T_WATER;
}

/**
 * The top of a bevelled tile's OTHER half.
 *
 * The ground field records the height of the tile's own material, and on a
 * water/trees bevel that is the water's — eight px below the ground. Testing
 * the tree wedge against that would put every mover above its "canopy" and
 * open the wedge; the wood stands at its own height whichever half of the
 * tile it occupies. On a flat map there is no field and every wall is
 * infinite, as before.
 */
function otherTop(map: CityMap, other: number): number {
  if (!map.ground) return Infinity;
  return other === T_TREES ? TREE_Z : Infinity;
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
  z0 = 0,
): boolean {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  const tile = map.tiles[ty * map.widthTiles + tx];
  const top = wallTopAt(map, tx, ty);
  const base = plainSolid(tile as number, medium, z0, top);
  if (base) return true;
  // A tile whose BEVELLED half is solid — the water wedge bitten out of a
  // headland — still answers solid, so the conservative readers above
  // never send anybody to stand on a corner that is half sea.
  //
  // The coast CURVE is deliberately not consulted here, and the quay is why:
  // the curve crosses every tile of the waterfront, and answering "solid" for
  // all of them would close it to anybody on foot. A tile the curve crosses
  // is half open, and half open is what the movement solver below is for.
  // Measured, letting it stay coarse costs the placement passes nothing —
  // spots overlapping solid move by at most one across three seeds, in both
  // directions (§43.4).
  const code = map.bevel ? (map.bevel[ty * map.widthTiles + tx] as number) : BEV_NONE;
  if (code === BEV_NONE) return false;
  const other = bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty);
  return plainSolid(other, medium, z0, otherTop(map, other));
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
  z0 = 0,
): number {
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return PART_FULL;
  const i = ty * map.widthTiles + tx;
  const top = wallTopAt(map, tx, ty);
  const base = plainSolid(map.tiles[i] as number, medium, z0, top);
  const code = map.bevel ? (map.bevel[i] as number) : BEV_NONE;
  if (code === BEV_NONE) return base ? PART_FULL : PART_NONE;
  const otherTile = bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, tx, ty);
  const other = plainSolid(otherTile, medium, z0, otherTop(map, otherTile));
  if (base === other) return base ? PART_FULL : PART_NONE;
  return other ? code : oppositeHalf(code);
}

/**
 * The coast's own line through a tile, as the SOLID half-plane for this
 * medium: solid where `CUT.nx * lx + CUT.ny * ly > CUT.c`, with `(lx, ly)`
 * in px from the tile's top-left corner. False when the curve has nothing
 * to say about this tile, and the bevels answer as they always have.
 *
 * **This is the single definition the whole solver reads** (WORLDGEN.md §43).
 * `faceX`, `faceY`, `boxInSolid` and `isSolidAtWorld` each derive their own
 * question from it rather than approximating it separately, which is the
 * thing §41.4 found missing when a solver built elsewhere was ported in: its
 * point test, box test and depenetration push were three rules reconciled
 * afterwards, and they left movers standing in the sea.
 *
 * Written into module scratch rather than returned, because this sits inside
 * the movement loop and inside client prediction. Not shared state in any
 * sense the simulation can observe: it is a pure function of the map, the
 * tile and the medium, read back before the next call.
 */
const CUT = { nx: 0, ny: 0, c: 0 };

function shoreCutAt(map: CityMap, tx: number, ty: number, medium: Medium): boolean {
  const cut = map.shoreCut;
  if (cut === undefined) return false;
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
  const slot = cut.slot.get(ty * map.widthTiles + tx);
  if (slot === undefined) return false;
  // A wall, a wood and a deck are not shore. The curve says where the WATER
  // stops; it has no opinion on a building standing at the quayside, and
  // letting it halve one would open a doorway through the wall.
  const tile = map.tiles[ty * map.widthTiles + tx] as number;
  if (tile === T_BUILDING || tile === T_TREES || tile === T_BRIDGE) return false;
  // Land movers are stopped by the water; boats by everything else. The
  // normal names the wet side, so a boat simply reads it backwards — one
  // sign, rather than a second traversal of the same geometry.
  const flip = medium === 'water' ? -1 : 1;
  CUT.nx = (cut.nx[slot] as number) * flip;
  CUT.ny = (cut.ny[slot] as number) * flip;
  CUT.c = (cut.c[slot] as number) * flip;
  return true;
}

/**
 * How far the solid half-plane reaches along one axis, across the box's
 * extent `lo..hi` on the other — the same question `faceX` asks of a bevel,
 * asked of an arbitrary line.
 *
 * `n0` is the normal's component along the axis of travel, `n1` its component
 * across; `origin` is the tile's corner on the travel axis. Answers ±Infinity
 * when no part of this tile is in the way.
 *
 * Conservative for the WHOLE box by construction: the row that lets the solid
 * reach furthest is the one maximising `n1 * l`, which is an end of the range
 * because the expression is linear — so this is the extreme over the box, not
 * a sample of it, and clamping flush to it can leave no corner inside.
 *
 * The face it reports is `MARGIN` px OUTSIDE the water, for a reason that has
 * nothing to do with geometry: positions go on the wire quantised to eighths
 * of a pixel (`q8`), and the snap can round towards the line. A mover parked
 * exactly flush against an arbitrary slope is therefore rounded a few
 * hundredths of a pixel into the sea — invisible, and still a mover in the
 * sea. A margin the quantiser cannot spend (its worst case moves a point
 * `sqrt(2)/16` across a unit normal) makes "outside" survive being written
 * down. The BEVELS have the same exposure and are left alone: their faces are
 * all 45° and it has never bitten, and moving every wall in the city by an
 * eighth of a pixel is not a thing to do in passing.
 */
const MARGIN = 1 / 8;

function cutFace(
  n0: number,
  n1: number,
  c: number,
  lo: number,
  hi: number,
  sign: number,
  origin: number,
): number {
  // What the solid demands of the travel axis, once the other axis has been
  // given its most generous value — and the margin, which is a shift of the
  // whole line because the normal is a unit vector.
  const k = c - MARGIN - n1 * (n1 > 0 ? hi : lo);
  if (sign > 0) {
    // The solid's near extent, coming from below.
    if (n0 > 0) {
      const e = k / n0;
      return e >= TILE_SIZE ? Infinity : origin + (e < 0 ? 0 : e);
    }
    // The solid reaches the tile's own low face, or is not here at all.
    return k < 0 ? origin : Infinity;
  }
  if (n0 < 0) {
    const e = k / n0;
    return e <= 0 ? -Infinity : origin + (e > TILE_SIZE ? TILE_SIZE : e);
  }
  return n0 * TILE_SIZE > k ? origin + TILE_SIZE : -Infinity;
}

/** Point query, bevel-exact: the diagonal itself counts as open. */
export function isSolidAtWorld(
  map: CityMap,
  x: number,
  y: number,
  medium: Medium = 'land',
  z0 = 0,
): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (shoreCutAt(map, tx, ty, medium)) {
    return CUT.nx * (x - tx * TILE_SIZE) + CUT.ny * (y - ty * TILE_SIZE) > CUT.c;
  }
  const part = solidPartAt(map, tx, ty, medium, z0);
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
  z0: number,
): number {
  const open = sign > 0 ? Infinity : -Infinity;
  const x0 = tx * TILE_SIZE;
  const ty0 = ty * TILE_SIZE;
  const yLo = Math.max(y0, ty0) - ty0;
  const yHi = Math.min(y1, ty0 + TILE_SIZE) - ty0;
  if (yHi < yLo) return open;
  // The coast's own line, where there is one, in place of the bevel's 45°
  // approximation of it (§43).
  if (shoreCutAt(map, tx, ty, medium)) {
    return cutFace(CUT.nx, CUT.ny, CUT.c, yLo, yHi, sign, x0);
  }
  const part = solidPartAt(map, tx, ty, medium, z0);
  if (part === PART_NONE) return open;
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
  z0: number,
): number {
  const open = sign > 0 ? Infinity : -Infinity;
  const y0 = ty * TILE_SIZE;
  const tx0 = tx * TILE_SIZE;
  const xLo = Math.max(x0, tx0) - tx0;
  const xHi = Math.min(x1, tx0 + TILE_SIZE) - tx0;
  if (xHi < xLo) return open;
  // The normal's components swap roles with the axes: the same line, asked
  // about y instead of x.
  if (shoreCutAt(map, tx, ty, medium)) {
    return cutFace(CUT.ny, CUT.nx, CUT.c, xLo, xHi, sign, y0);
  }
  const part = solidPartAt(map, tx, ty, medium, z0);
  if (part === PART_NONE) return open;
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
  /** The mover's feet, world px: which walls reach it (3D.md X2). */
  z0 = 0,
): void {
  const maxStep = TILE_SIZE / 2;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep));
  let sx = dx / steps;
  let sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    const [hitX, hitY] = moveOnce(map, pos, vel, half, sx, sy, medium, z0);
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
  z0 = 0,
): [boolean, boolean] {
  let hitX = false;
  let hitY = false;
  // X axis
  if (dx !== 0) {
    const nx = pos.x + dx;
    const y0 = pos.y - half;
    // Two bounds, deliberately. The half-open one picks the ROWS the box
    // touches, so a box resting flush on a tile edge does not claim the row
    // beyond it. The closed one is what the FACE is evaluated over: a sloped
    // face is a function of the other axis, so measuring it against a box an
    // epsilon short of its real height leaves the mover a fraction of a pixel
    // inside once the other axis moves and slides the face (§43).
    const y1 = pos.y + half - EPS;
    const yEnd = pos.y + half;
    const ty1 = Math.floor(y0 / TILE_SIZE);
    const ty2 = Math.floor(y1 / TILE_SIZE);
    if (dx > 0) {
      const tx = Math.floor((nx + half) / TILE_SIZE);
      // Every column the leading edge SWEEPS, not just the one it lands in.
      // A whole tile's face is its own boundary, so landing in it is the only
      // way to meet it and the destination alone was enough. A sloped face —
      // a bevel's hypotenuse, and now the coast's own line — lives INSIDE its
      // tile, so a mover standing behind one can step clean over it into the
      // next tile, be stopped flush against THAT tile's face, and come to
      // rest a couple of pixels inside the water it just crossed (§43).
      // Sub-steps are capped at half a tile, so this is one column or two.
      const tx0 = Math.floor((pos.x + half) / TILE_SIZE);
      let limit = Infinity;
      for (let t = tx0; t <= tx; t++) {
        for (let ty = ty1; ty <= ty2; ty++) {
          const b = faceX(map, t, ty, y0, yEnd, 1, medium, z0);
          // A face already BEHIND the leading edge does not stop anything.
          // Without this, a mover that starts inside a solid — shunted there
          // by a car, or spawned in one — is clamped back into it every tick
          // instead of being able to walk out the way it came.
          if (b < limit && b >= pos.x + half - FLUSH) limit = b;
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
      const tx = Math.floor((nx - half) / TILE_SIZE);
      const tx0 = Math.floor((pos.x - half) / TILE_SIZE);
      let limit = -Infinity;
      for (let t = tx; t <= tx0; t++) {
        for (let ty = ty1; ty <= ty2; ty++) {
          const b = faceX(map, t, ty, y0, yEnd, -1, medium, z0);
          if (b > limit && b <= pos.x - half + FLUSH) limit = b;
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
    const xEnd = pos.x + half;
    const tx1 = Math.floor(x0 / TILE_SIZE);
    const tx2 = Math.floor(x1 / TILE_SIZE);
    if (dy > 0) {
      const ty = Math.floor((ny + half) / TILE_SIZE);
      const ty0 = Math.floor((pos.y + half) / TILE_SIZE);
      let limit = Infinity;
      for (let t = ty0; t <= ty; t++) {
        for (let tx = tx1; tx <= tx2; tx++) {
          const b = faceY(map, tx, t, x0, xEnd, 1, medium, z0);
          if (b < limit && b >= pos.y + half - FLUSH) limit = b;
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
      const ty = Math.floor((ny - half) / TILE_SIZE);
      const ty0 = Math.floor((pos.y - half) / TILE_SIZE);
      let limit = -Infinity;
      for (let t = ty; t <= ty0; t++) {
        for (let tx = tx1; tx <= tx2; tx++) {
          const b = faceY(map, tx, t, x0, xEnd, -1, medium, z0);
          if (b > limit && b <= pos.y - half + FLUSH) limit = b;
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
  z0 = 0,
): boolean {
  const tx1 = Math.floor((pos.x - half) / TILE_SIZE);
  const tx2 = Math.floor((pos.x + half - EPS) / TILE_SIZE);
  const ty1 = Math.floor((pos.y - half) / TILE_SIZE);
  const ty2 = Math.floor((pos.y + half - EPS) / TILE_SIZE);
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      const cut = shoreCutAt(map, tx, ty, medium);
      const part = cut ? PART_NONE : solidPartAt(map, tx, ty, medium, z0);
      if (!cut && part === PART_NONE) continue;
      if (part === PART_FULL) return true;
      // The box clipped to this tile, then its corner deepest into the
      // solid half: a box overlaps a half-plane iff that corner does.
      const bx0 = Math.max(pos.x - half, tx * TILE_SIZE) - tx * TILE_SIZE;
      const bx1 = Math.min(pos.x + half - EPS, (tx + 1) * TILE_SIZE) - tx * TILE_SIZE;
      const by0 = Math.max(pos.y - half, ty * TILE_SIZE) - ty * TILE_SIZE;
      const by1 = Math.min(pos.y + half - EPS, (ty + 1) * TILE_SIZE) - ty * TILE_SIZE;
      // The coast's line is a half-plane like the bevels', only not diagonal:
      // the deepest corner is whichever the normal points at (§43).
      if (cut) {
        const cx = CUT.nx > 0 ? bx1 : bx0;
        const cy = CUT.ny > 0 ? by1 : by0;
        if (CUT.nx * cx + CUT.ny * cy > CUT.c) return true;
        continue;
      }
      if (part === BEV_NE && bx1 > by0) return true;
      if (part === BEV_SW && bx0 < by1) return true;
      if (part === BEV_SE && bx1 + by1 > TILE_SIZE) return true;
      if (part === BEV_NW && bx0 + by0 < TILE_SIZE) return true;
    }
  }
  return false;
}
