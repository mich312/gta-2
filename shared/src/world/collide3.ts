import { TILE_SIZE } from './types.js';
import { blockedAt, ceilingAbove, supportUnder, type VolumeGrid } from './volume.js';

const EPS = 0.001;

/**
 * Deterministic collision against volume columns.
 *
 * Deliberately the same shape as the 2D `moveWithCollision` it grows out of —
 * axis-separated, sub-stepped so a fast mover cannot tunnel, blocked axes
 * clamp flush and zero their velocity — because that structure is what makes
 * it exact-op only, and exact-op only is what lets it run inside client
 * prediction without desyncing.
 *
 * What is new is the third axis, and the two behaviours that only exist once
 * you have one:
 *
 * - **Step-up.** A wall you can climb is not a wall. If the thing blocking
 *   you has a top within `stepUp` of your feet, and there is room to stand on
 *   it, you rise onto it instead of stopping. Without this every kerb is a
 *   cliff and the city becomes unwalkable.
 * - **Support and falling.** A mover is held up by the highest span top at or
 *   below its feet. Walk off a bridge and there is nothing under you, so you
 *   fall — which is the same code path that already carried stunt jumps and
 *   aircraft altitude, now applied to everything.
 *
 * No physics engine, by necessity rather than preference: see the note in
 * `volume.ts`. Bit-identical results across hosts are load-bearing here.
 */

export interface Body3 {
  x: number;
  y: number;
  /** Feet. The body occupies [z, z + height). */
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface Move3Options {
  /** Half-extent of the (square) footprint, world px. */
  half: number;
  /** Standing height, world px. */
  height: number;
  /** Tallest lip the mover climbs rather than stops at. */
  stepUp: number;
  /** Downward acceleration per tick, world px. 0 for a hovering mover. */
  gravity: number;
  /**
   * How far below the feet a surface still counts as ground. Keeps a mover
   * walking down a shallow slope glued to it instead of bouncing.
   */
  snapDown: number;
}

export interface Move3Result {
  hitX: boolean;
  hitY: boolean;
  /** Resting on a surface this tick. */
  grounded: boolean;
  /** Rose onto a lip rather than being stopped by it. */
  steppedUp: boolean;
  /** Hit a ceiling moving up. */
  hitCeiling: boolean;
  /** Surface the mover is standing on, or -Infinity over a void. */
  support: number;
}

/** Tile range a footprint spans on one axis. */
function tileRange(centre: number, half: number): [number, number] {
  return [
    Math.floor((centre - half) / TILE_SIZE),
    Math.floor((centre + half - EPS) / TILE_SIZE),
  ];
}

/** Does the box centred at (x,y) with vertical extent [z0,z1) hit anything? */
function boxBlocked(
  vg: VolumeGrid,
  x: number,
  y: number,
  half: number,
  z0: number,
  z1: number,
): boolean {
  const [tx1, tx2] = tileRange(x, half);
  const [ty1, ty2] = tileRange(y, half);
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      if (blockedAt(vg, tx, ty, z0, z1)) return true;
    }
  }
  return false;
}

/** Highest support under the whole footprint — the surface it rests on. */
export function supportForBox(
  vg: VolumeGrid,
  x: number,
  y: number,
  half: number,
  z: number,
): number {
  const [tx1, tx2] = tileRange(x, half);
  const [ty1, ty2] = tileRange(y, half);
  let best = -Infinity;
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      const s = supportUnder(vg, tx, ty, z);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Lowest ceiling over the whole footprint. */
function ceilingForBox(
  vg: VolumeGrid,
  x: number,
  y: number,
  half: number,
  z: number,
): number {
  const [tx1, tx2] = tileRange(x, half);
  const [ty1, ty2] = tileRange(y, half);
  let best = Infinity;
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      const c = ceilingAbove(vg, tx, ty, z);
      if (c < best) best = c;
    }
  }
  return best;
}

/**
 * Move a body through the volume grid for one tick.
 *
 * Mutates `body`. `dx/dy` are this tick's horizontal intent; vertical motion
 * comes from `body.vz` plus gravity, so a caller that wants a jump sets `vz`
 * and lets this carry it.
 */
export function move3(
  vg: VolumeGrid,
  body: Body3,
  dx: number,
  dy: number,
  opts: Move3Options,
): Move3Result {
  const result: Move3Result = {
    hitX: false,
    hitY: false,
    grounded: false,
    steppedUp: false,
    hitCeiling: false,
    support: -Infinity,
  };

  // Sub-step so a fast mover cannot pass through a wall between samples. The
  // vertical axis is included in the bound: a car coming off a bridge at
  // speed falls fast enough to matter.
  const maxStep = TILE_SIZE / 2;
  const reach = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(body.vz));
  const steps = Math.max(1, Math.ceil(reach / maxStep));
  let sx = dx / steps;
  let sy = dy / steps;

  for (let i = 0; i < steps; i++) {
    // ── vertical first, so the mover is at the right height to be blocked by
    //    the right things when it moves sideways.
    body.vz -= opts.gravity / steps;
    const dz = body.vz / steps;
    if (dz !== 0) {
      const nz = body.z + dz;
      if (dz > 0) {
        const ceiling = ceilingForBox(vg, body.x, body.y, opts.half, body.z + opts.height);
        if (nz + opts.height > ceiling) {
          body.z = ceiling - opts.height - EPS;
          body.vz = 0;
          result.hitCeiling = true;
        } else {
          body.z = nz;
        }
      } else {
        const support = supportForBox(vg, body.x, body.y, opts.half, body.z + EPS);
        if (nz <= support) {
          body.z = support;
          body.vz = 0;
          result.grounded = true;
        } else {
          body.z = nz;
        }
      }
    }

    const [hx, hy, stepped] = moveOnce3(vg, body, opts, sx, sy);
    if (hx) {
      sx = 0;
      result.hitX = true;
    }
    if (hy) {
      sy = 0;
      result.hitY = true;
    }
    if (stepped) result.steppedUp = true;

    // Snap down onto a surface just below, so walking off a kerb glides
    // rather than launching the mover into a fall for two ticks.
    if (!result.grounded && body.vz <= 0) {
      const support = supportForBox(vg, body.x, body.y, opts.half, body.z + EPS);
      if (support > -Infinity && body.z - support <= opts.snapDown && body.z >= support) {
        body.z = support;
        body.vz = 0;
        result.grounded = true;
      }
    }

    if (sx === 0 && sy === 0 && body.vz === 0) break;
  }

  result.support = supportForBox(vg, body.x, body.y, opts.half, body.z + EPS);
  return result;
}

/** One bounded horizontal sub-step. Returns [hitX, hitY, steppedUp]. */
function moveOnce3(
  vg: VolumeGrid,
  body: Body3,
  opts: Move3Options,
  dx: number,
  dy: number,
): [boolean, boolean, boolean] {
  let hitX = false;
  let hitY = false;
  let stepped = false;
  const { half, height, stepUp } = opts;

  if (dx !== 0) {
    const nx = body.x + dx;
    if (!boxBlocked(vg, nx, body.y, half, body.z, body.z + height)) {
      body.x = nx;
    } else {
      const lift = tryStepUp(vg, nx, body.y, opts, body.z);
      if (lift !== null) {
        body.x = nx;
        body.z = lift;
        body.vz = 0;
        stepped = true;
      } else {
        // Clamp flush to the tile face, exactly as the 2D path does, so a
        // mover pressed against a wall has a stable position rather than
        // one that jitters with its speed.
        const tx = dx > 0 ? Math.floor((nx + half) / TILE_SIZE) : Math.floor((nx - half) / TILE_SIZE);
        body.x = dx > 0 ? tx * TILE_SIZE - half - EPS : (tx + 1) * TILE_SIZE + half + EPS;
        body.vx = 0;
        hitX = true;
      }
    }
  }

  if (dy !== 0) {
    const ny = body.y + dy;
    if (!boxBlocked(vg, body.x, ny, half, body.z, body.z + height)) {
      body.y = ny;
    } else {
      const lift = tryStepUp(vg, body.x, ny, opts, body.z);
      if (lift !== null) {
        body.y = ny;
        body.z = lift;
        body.vz = 0;
        stepped = true;
      } else {
        const ty = dy > 0 ? Math.floor((ny + half) / TILE_SIZE) : Math.floor((ny - half) / TILE_SIZE);
        body.y = dy > 0 ? ty * TILE_SIZE - half - EPS : (ty + 1) * TILE_SIZE + half + EPS;
        body.vy = 0;
        hitY = true;
      }
    }
  }

  return [hitX, hitY, stepped];
}

/**
 * Can the mover climb onto whatever is in its way at (x, y)?
 *
 * Returns the height to rise to, or null to be stopped. Two conditions, and
 * the second is the one that is easy to forget: the lip has to be low enough
 * to step onto, AND there has to be room to stand once you are up there — or
 * a mover would climb into the underside of a bridge deck and wedge.
 */
function tryStepUp(
  vg: VolumeGrid,
  x: number,
  y: number,
  opts: Move3Options,
  z: number,
): number | null {
  const { half, height, stepUp } = opts;
  const lip = supportForBox(vg, x, y, half, z + stepUp);
  if (lip === -Infinity || lip <= z) return null;
  if (lip - z > stepUp) return null;
  if (boxBlocked(vg, x, y, half, lip + EPS, lip + height)) return null;
  return lip;
}
