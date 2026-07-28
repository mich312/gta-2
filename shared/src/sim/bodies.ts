import { dCos, dSin } from '../math/trig.js';
import type { Vec2 } from '../math/vec.js';
import { getVehicleTuning } from '../tuning.js';
import { boxInSolid } from '../world/collide.js';
import type { CityMap } from '../world/types.js';
import type { EntityTable } from './entities.js';
import type { VehicleState } from './state.js';

/**
 * The one collider shape in the game, and the tests that read it.
 *
 * Everything with a body — a car, a boat, a bus — is an oriented box: a
 * centre, a heading, and a half-length along that heading with a half-width
 * across it. Everything on foot — a player, an officer, a pedestrian — is a
 * circle. Those are the only two shapes, so there are only three tests, and
 * they all live here.
 *
 * They live here rather than in vehicle.ts because the shape stopped being a
 * vehicle's private business the moment anything else needed to agree with it.
 * Three systems already had their own idea of how big a car is:
 *
 *   - `boxesOverlap` (car vs car) used the real oriented box;
 *   - `scanAhead` (the traffic AI's obstacle model) used halfLength/halfWidth
 *     projected onto the driver's axes, because a follower that disagreed with
 *     the contact model closed up until it collided and then reversed out;
 *   - `stepVehicleImpacts` (car vs person) used an axis-aligned square of
 *     `halfExtent`, which for a car is 9 px against a body 12 long and 5.5
 *     wide. It was 3.5 px too wide and 3 px too short at once, and it never
 *     rotated: a car that hit you square in the nose passed a quarter of its
 *     bonnet through you before it registered, while a car in the next lane
 *     ran you over from a clear 3 px away. Diagonally it was wrong by the full
 *     difference between a square and a car.
 *
 * A collider you cannot see is judged entirely by whether it matches the
 * sprite, so there is now one answer to "how big is that car" and every system
 * asks it.
 *
 * Exact operations only — multiply, add, compare, absolute value, the
 * deterministic trig table, and Math.sqrt, which IEEE-754 pins exactly. All of
 * this runs inside client prediction and must agree with the server bit for
 * bit.
 */

/** A vehicle's position and facing at one instant. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/**
 * The slice of the world anything colliding with vehicles needs.
 *
 * A narrow read-only view rather than the whole GameState, because the client
 * has to be able to supply one: it holds the latest snapshot, not a
 * simulation. `GameState` satisfies this structurally, so the server passes
 * itself and nothing changes there.
 */
export interface VehicleWorld {
  vehicles: EntityTable<VehicleState>;
  /**
   * Where each vehicle was on the VIEWER's clock, by id — lag compensation.
   *
   * The client draws remote cars ~100 ms in the past and collides against
   * exactly those positions, because you have to be able to hit what you can
   * see. The server has no such delay, so left alone the two hosts resolve
   * the same contact against a car that is most of a car length apart on
   * their two timelines. Handing the server the poses the client was actually
   * looking at closes that gap; see `rewoundWorld` in vehicle.ts.
   *
   * Absent means "where it is now", which is what the server's own GameState
   * and every vehicle not being driven by a remote client get.
   */
  poses?: Record<number, Pose>;
}

/** Where `world` says this vehicle is, for the viewer it was built for. */
export function poseIn(world: VehicleWorld, v: VehicleState): Pose {
  return world.poses?.[v.id] ?? { x: v.pos.x, y: v.pos.y, heading: v.heading };
}

/**
 * Clearance left between a body and whatever was pushed out of it, px.
 *
 * One eighth of a pixel, which is one step of the `q8` grid every position is
 * snapped to at the end of a tick. A push computed to land exactly flush
 * lands a hair INSIDE — the round trip through the box's frame goes through
 * the deterministic trig table, whose cosine of zero is 1 - 6e-8 rather than
 * 1, and then q8 can round the result back down by up to a sixteenth. Still
 * overlapping means push again next tick, and the pair buzzes on the spot. A
 * gap of an eighth of a pixel absorbs both and is a quarter of the smallest
 * thing the screen can draw.
 */
const SEPARATION_SKIN = 0.125;

/** An oriented body box: centre, unit forward, and the two half-extents. */
export interface BodyBox {
  x: number;
  y: number;
  /** Unit forward vector — the heading's cosine and sine, kept so the
   * trig is done once per box rather than once per test. */
  cos: number;
  sin: number;
  /** Half-extent along the forward vector (nose to centre). */
  halfLength: number;
  /** Half-extent across it (flank to centre). */
  halfWidth: number;
}

/** The box for a vehicle of `kind` posed at (x, y) facing `heading`. */
export function vehicleBoxAt(kind: string, x: number, y: number, heading: number): BodyBox {
  const t = getVehicleTuning(kind);
  return {
    x,
    y,
    cos: dCos(heading),
    sin: dSin(heading),
    halfLength: t.halfLength,
    halfWidth: t.halfWidth,
  };
}

/** The box for a vehicle where it actually is. */
export function vehicleBox(v: VehicleState): BodyBox {
  return vehicleBoxAt(v.kind, v.pos.x, v.pos.y, v.heading);
}

/**
 * Do two oriented boxes overlap? Separating-axis test, four axes.
 *
 * This replaced an axis-aligned square of the STRIKER's own `halfExtent`,
 * used for both vehicles and both axes. For a car that was 18 × 18 against a
 * body 26 long and 14 wide, so it was too wide and too short at once: two cars
 * in adjacent lanes on a two-tile street sit 16 px apart, 16 < 18, and they
 * collided eight times per pass and shredded 44% of each other's health
 * without their bodies ever coming near touching. Nose-to-tail, a car could
 * bury a third of its length in the one in front before anything noticed.
 */
export function boxesOverlap(a: BodyBox, b: BodyBox): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Broad phase: no pair of boxes can touch further apart than the sum of
  // their diagonals, and most pairs are nowhere near.
  const reach = a.halfLength + a.halfWidth + b.halfLength + b.halfWidth;
  if (dx * dx + dy * dy > reach * reach) return false;

  /** True if this axis separates them — one clear axis means no contact. */
  const separated = (ux: number, uy: number): boolean => {
    const d = dx * ux + dy * uy;
    const dist = d < 0 ? -d : d;
    const af = a.halfLength * (a.cos * ux + a.sin * uy);
    const ar = a.halfWidth * (-a.sin * ux + a.cos * uy);
    const bf = b.halfLength * (b.cos * ux + b.sin * uy);
    const br = b.halfWidth * (-b.sin * ux + b.cos * uy);
    const ra = (af < 0 ? -af : af) + (ar < 0 ? -ar : ar);
    const rb = (bf < 0 ? -bf : bf) + (br < 0 ? -br : br);
    return dist > ra + rb;
  };

  if (separated(a.cos, a.sin)) return false;
  if (separated(-a.sin, a.cos)) return false;
  if (separated(b.cos, b.sin)) return false;
  if (separated(-b.sin, b.cos)) return false;
  return true;
}

/**
 * How far a circle at (cx, cy) has to move to leave the box, and which way.
 *
 * Returns null when they are not touching — which is the common answer, so
 * this doubles as the overlap test (`circleHitsBox`) and callers that only
 * want a yes/no pay nothing extra.
 *
 * The vector is a minimum translation: the shortest push that separates them.
 * Outside the box that is simply the direction from the nearest point on the
 * box to the circle's centre; inside it (a pedestrian a car has driven right
 * over) there is no such direction, so it leaves by the nearest face, which
 * keeps somebody standing on the centre line from being flung the length of
 * the car.
 */
export function pushOutOfBox(
  cx: number,
  cy: number,
  radius: number,
  b: BodyBox,
): { x: number; y: number } | null {
  // Separate to just clear of touching rather than exactly flush; see
  // SEPARATION_SKIN for why exactly flush does not stay flush.
  const skin = radius + SEPARATION_SKIN;
  // Into the box's own frame: along its length, across its width.
  const rx = cx - b.x;
  const ry = cy - b.y;
  const lx = rx * b.cos + ry * b.sin;
  const ly = -rx * b.sin + ry * b.cos;

  const hl = b.halfLength;
  const hw = b.halfWidth;
  const inside = lx > -hl && lx < hl && ly > -hw && ly < hw;

  let px: number;
  let py: number;
  if (inside) {
    // No direction to be pushed along — pick the nearest face.
    const outL = hl - (lx < 0 ? -lx : lx) + skin;
    const outW = hw - (ly < 0 ? -ly : ly) + skin;
    if (outW <= outL) {
      px = 0;
      py = ly >= 0 ? outW : -outW;
    } else {
      px = lx >= 0 ? outL : -outL;
      py = 0;
    }
  } else {
    // Nearest point on the box to the circle, in the box's frame.
    const qx = lx < -hl ? -hl : lx > hl ? hl : lx;
    const qy = ly < -hw ? -hw : ly > hw ? hw : ly;
    const dx = lx - qx;
    const dy = ly - qy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) return null; // clear of it
    // Exactly on the boundary: no direction either, so use the nearest face
    // as above rather than dividing by zero.
    if (d2 === 0) {
      px = lx >= 0 ? hl - lx + skin : -(hl + lx + skin);
      py = 0;
    } else {
      const d = Math.sqrt(d2);
      const push = skin - d;
      px = (dx / d) * push;
      py = (dy / d) * push;
    }
  }
  // Back out of the box's frame.
  return { x: px * b.cos - py * b.sin, y: px * b.sin + py * b.cos };
}

/** Does a circle at (cx, cy) touch the box? */
export function circleHitsBox(cx: number, cy: number, radius: number, b: BodyBox): boolean {
  const rx = cx - b.x;
  const ry = cy - b.y;
  const lx = rx * b.cos + ry * b.sin;
  const ly = -rx * b.sin + ry * b.cos;
  const qx = lx < -b.halfLength ? -b.halfLength : lx > b.halfLength ? b.halfLength : lx;
  const qy = ly < -b.halfWidth ? -b.halfWidth : ly > b.halfWidth ? b.halfWidth : ly;
  const dx = lx - qx;
  const dy = ly - qy;
  return dx * dx + dy * dy < radius * radius;
}

/**
 * Stop somebody on foot from standing inside a car.
 *
 * Until this existed, NOTHING on foot collided with a vehicle: players,
 * officers and pedestrians alike collided against the tile grid and nothing
 * else, so you walked through a parked car as if it were fog — and so did the
 * crowd, which is why a queue at a red light had people strolling through the
 * bonnets. A car is the most conspicuous solid object in the game and it was
 * the one thing you could not bump into.
 *
 * Resolved as a push-out rather than a blocked move, for the same reason the
 * car-to-car contact allows any move that separates: a hard block on overlap
 * traps anyone who ends up inside a body — a car parking on top of them, a
 * run-over knockback, a spawn — with no way out, and being wedged inside a
 * car with the world refusing every escape is worse than the thing it was
 * meant to prevent. Push-out has no such state: it always reduces the
 * overlap, so it always terminates.
 *
 * Velocity loses only the component pointing INTO the car, so walking along a
 * flank slides along it instead of stopping dead against it.
 *
 * A push is skipped if it would put the person inside a wall — pinned between
 * a car and a building you stay where you are, which is at worst cosmetic,
 * where the alternative is being extruded through the building and into
 * whatever is behind it.
 */
export function pushOutOfVehicles(
  pos: Vec2,
  vel: Vec2,
  radius: number,
  world: VehicleWorld | null,
  map: CityMap,
  /** The car this person is in or getting out of, which cannot block them. */
  ignoreVehicleId: number | null = null,
): void {
  if (!world) return;
  const poses = world.poses;
  for (const id of world.vehicles.ids) {
    if (id === ignoreVehicleId) continue;
    const v = world.vehicles.byId[id];
    if (!v) continue;
    const pose = poses?.[id];
    const vx = pose ? pose.x : v.pos.x;
    const vy = pose ? pose.y : v.pos.y;
    // Broad phase before anything expensive. Two hundred pedestrians against
    // fifty cars is ten thousand pairs a tick, and building the oriented box
    // costs a sine and a cosine each — so the reject has to come first, and
    // has to be arithmetic. `halfLength` is the longest a body reaches from
    // its centre whichever way it is pointing.
    const reach = getVehicleTuning(v.kind).halfLength + radius;
    const dx = pos.x - vx;
    const dy = pos.y - vy;
    if (dx * dx + dy * dy > reach * reach) continue;
    const box = vehicleBoxAt(v.kind, vx, vy, pose ? pose.heading : v.heading);
    const push = pushOutOfBox(pos.x, pos.y, radius, box);
    if (!push) continue;
    const nx = pos.x + push.x;
    const ny = pos.y + push.y;
    if (boxInSolid(map, { x: nx, y: ny }, radius)) continue;
    pos.x = nx;
    pos.y = ny;
    // Only the part of the velocity that was driving into the body. Along the
    // flank is still a direction you may walk.
    const into = vel.x * push.x + vel.y * push.y;
    if (into < 0) {
      const len2 = push.x * push.x + push.y * push.y;
      if (len2 > 0) {
        const k = into / len2;
        vel.x -= push.x * k;
        vel.y -= push.y * k;
      }
    }
  }
}
