import { TILE_SIZE, type CityMap, type JunctionMap, type SignalHead } from '../world/types.js';
import { drivableTile } from './roadgrid.js';

/**
 * Traffic signals.
 *
 * The city was busy but it was not *governed*: cars negotiated junctions by
 * car-following alone, so a crossroads read as something drivers survived
 * rather than something the city ran. Signals are the fix, and they are built
 * to cost nothing.
 *
 * Two ideas carry the whole system:
 *
 *  1. **The phase is a pure function of `tick` and the junction's identity.**
 *     No sim state, no wire bytes, nothing to desync, and — the point — two
 *     players stopped at the same junction see the same red because they are
 *     computing the same number, not because a server told them. Anything
 *     that can be a formula over `tick` should be.
 *
 *  2. **A red light is presented to the driver as a stationary obstacle at
 *     the stop line.** It is not a separate braking rule. The Intelligent
 *     Driver Model in `traffic.ts` already knows how to come to a comfortable
 *     halt behind something that is not moving, and how to queue behind cars
 *     that are doing the same. Reusing it means red lights inherit every
 *     property that model was tuned for, and it is the reason this does not
 *     repeat the gap-acceptance experiment recorded in `traffic.ts`: that
 *     rule stopped cars *dead* at junction mouths and the cars behind then
 *     had to negotiate an obstacle. A queue that eases to a stop at a line is
 *     the thing traffic does anyway.
 */

/**
 * Widest carriageway the lane model will keep sides on, in tiles.
 *
 * Must match `MAX_LANE_TILES` in `traffic.ts`: a junction is defined here as
 * exactly the place where the lane model gives up in *both* axes, so if the
 * two constants drift apart, cars will stop at lines that are not where they
 * think a junction begins.
 */
const MAX_LANE_TILES = 4;

/**
 * How far short of the junction the stop line sits, in px, beyond the car's
 * own nose.
 *
 * This is load-bearing rather than cosmetic. `Ahead.gap` is bumper-to-bumper
 * everywhere else in the traffic model, so a stop line reported from the car's
 * CENTRE parks a stationary car with half its length inside the box — where it
 * blocks the cross axis, which cannot then clear on its own green either, and
 * the junction deadlocks. Measured: cars dwelling on junction tiles went from
 * 4% of samples to 20%, and traffic under way fell by a third.
 */
const STOP_LINE_SETBACK = 6;

/**
 * How far the drivable road runs either side of a tile, across `alongX`, in
 * tiles — capped, because all any caller needs to know is whether the span is
 * wider than a carriageway.
 */
function crossSpan(map: CityMap, tx: number, ty: number, alongX: boolean): number {
  let span = 1;
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, alongX ? tx : tx - i, alongX ? ty - i : ty)) break;
    span++;
  }
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, alongX ? tx : tx + i, alongX ? ty + i : ty)) break;
    span++;
  }
  return span;
}

/**
 * A tile where two roads genuinely cross, rather than a wide road.
 *
 * The test is the lane model's own: a carriageway is a strip that is narrow
 * across the direction of travel and long along it, so an ordinary road tile
 * is over-wide in exactly one axis. A tile that is over-wide in *both* is not
 * a carriageway at all — it is a junction, a plaza or a car park, which is
 * precisely the set of places a driver has to negotiate rather than follow.
 */
function isJunctionTile(map: CityMap, tx: number, ty: number): boolean {
  if (!drivableTile(map, tx, ty)) return false;
  return (
    crossSpan(map, tx, ty, true) > MAX_LANE_TILES && crossSpan(map, tx, ty, false) > MAX_LANE_TILES
  );
}

/**
 * Label every junction in the city, once, at generation time.
 *
 * Connected components of junction tiles, flood-filled in row-major scan
 * order so the numbering is a pure function of the map — which is what lets
 * the phase be a function of the id. All four arms of a crossroads meet the
 * same component and therefore agree about what colour the light is.
 *
 * This never goes on the wire: the client generates its own `CityMap` from
 * the seed (`main.ts` calls `generateCity`), so a derived table like this one
 * is free on both ends.
 */
export function labelJunctions(map: CityMap): JunctionMap {
  const w = map.widthTiles;
  const h = map.heightTiles;
  const idOf = new Int16Array(w * h).fill(-1);
  let count = 0;
  const queue: number[] = [];

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const seed = ty * w + tx;
      if (idOf[seed] !== -1 || !isJunctionTile(map, tx, ty)) continue;
      // Int16Array: a city with more than 32767 junctions would wrap, and a
      // wrapped id is a junction whose arms disagree. Stop labelling instead.
      if (count >= 32767) return { idOf, count, heads: collectHeads(map, idOf) };
      const id = count++;
      idOf[seed] = id;
      queue.length = 0;
      queue.push(tx, ty);
      for (let q = 0; q < queue.length; q += 2) {
        const cx = queue[q] as number;
        const cy = queue[q + 1] as number;
        for (let n = 0; n < 4; n++) {
          const nx = cx + (n === 0 ? 1 : n === 2 ? -1 : 0);
          const ny = cy + (n === 1 ? 1 : n === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const idx = ny * w + nx;
          if (idOf[idx] !== -1 || !isJunctionTile(map, nx, ny)) continue;
          idOf[idx] = id;
          queue.push(nx, ny);
        }
      }
    }
  }
  return { idOf, count, heads: collectHeads(map, idOf) };
}

/**
 * One head per arm of every junction: the road tile immediately outside it,
 * and the direction traffic is going when it arrives there.
 *
 * A tile qualifies when it is drivable, is not itself part of a junction, and
 * has a junction tile in front of it. That is exactly the tile a driver is on
 * when `stopLineGap` first sees the light, so the head and the stop line
 * agree by construction rather than by two constants being kept in step.
 */
function collectHeads(map: CityMap, idOf: Int16Array): SignalHead[] {
  const w = map.widthTiles;
  const h = map.heightTiles;
  const heads: SignalHead[] = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (!drivableTile(map, tx, ty) || idOf[ty * w + tx] !== -1) continue;
      for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
        const nx = tx + (dirIdx === 0 ? 1 : dirIdx === 2 ? -1 : 0);
        const ny = ty + (dirIdx === 1 ? 1 : dirIdx === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const id = idOf[ny * w + nx] as number;
        if (id === -1) continue;
        heads.push({
          x: tx * TILE_SIZE + TILE_SIZE / 2,
          y: ty * TILE_SIZE + TILE_SIZE / 2,
          dirIdx,
          junctionId: id,
        });
      }
    }
  }
  return heads;
}

/**
 * The junction covering a world point, or -1.
 *
 * Tolerates a map with no junction table at all. Hand-built `CityMap`s —
 * the arena fixtures in the vehicle and police tests, which are flat fields
 * with one wall — omit most of the generated tables already, and a city with
 * no junctions is a coherent thing to ask about: it simply has no lights.
 */
export function junctionAt(map: CityMap, x: number, y: number): number {
  const table = map.junctions;
  if (!table) return -1;
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return -1;
  return table.idOf[ty * map.widthTiles + tx] as number;
}

export type SignalColour = 'green' | 'amber' | 'red';

export interface SignalTiming {
  greenTicks: number;
  amberTicks: number;
  /** Ticks of phase offset per junction id, so the city does not blink as one. */
  junctionOffsetTicks: number;
  /** How far ahead of the bumper a driver looks for a light, px. */
  lookaheadPx: number;
}

/**
 * What colour a junction is showing to traffic on `dirIdx`, at `tick`.
 *
 * The east-west axis (cardinals 0 and 2) leads the cycle and the north-south
 * axis follows, so the two are never green together by construction — a
 * safety property that comes from the arithmetic rather than from a test.
 *
 * The offset term staggers the city, exactly the way `assignTurf` staggers
 * its Voronoi seeds: without it every junction goes green on the same tick
 * and the whole map pulses.
 */
export function signalColour(
  junctionId: number,
  dirIdx: number,
  tick: number,
  t: SignalTiming,
): SignalColour {
  const arm = dirIdx === 0 || dirIdx === 2 ? 0 : 1;
  const phase = t.greenTicks + t.amberTicks;
  const cycle = phase * 2;
  // Modulo of a sum that stays non-negative: tick and the offset are both
  // counts, so there is no negative-remainder trap here.
  const at = (tick + junctionId * t.junctionOffsetTicks) % cycle;
  const mine = arm === 0 ? at : (at + phase) % cycle;
  if (mine < t.greenTicks) return 'green';
  if (mine < phase) return 'amber';
  return 'red';
}

/**
 * Distance from a car's bumper to the stop line it must not cross, or
 * Infinity when it may proceed.
 *
 * Three ways to get Infinity, and each one is load-bearing:
 *
 *  - **Already in the box.** A car inside a junction always clears it. This
 *    is the rule that stops the first red of the game becoming a permanent
 *    obstacle in the middle of a crossroads, and it is what makes amber mean
 *    something rather than trapping whoever is committed.
 *  - **Green.**
 *  - **Amber, too close to stop comfortably.** Braking hard enough to beat an
 *    amber is worse driving than clearing it, and a car that stops with its
 *    nose over the line is in the box anyway.
 */
export function stopLineGap(
  map: CityMap,
  x: number,
  y: number,
  dirIdx: number,
  speed: number,
  halfExtent: number,
  tick: number,
  t: SignalTiming,
  comfortBrake: number,
): number {
  if (junctionAt(map, x, y) !== -1) return Infinity;

  const dx = dirIdx === 0 ? 1 : dirIdx === 2 ? -1 : 0;
  const dy = dirIdx === 1 ? 1 : dirIdx === 3 ? -1 : 0;
  // Step in half tiles: a whole tile can skip clean over a one-tile-thick
  // junction arm on a fast car's lookahead.
  const stepPx = TILE_SIZE / 2;
  const steps = Math.ceil(t.lookaheadPx / stepPx);
  for (let i = 1; i <= steps; i++) {
    const px = x + dx * i * stepPx;
    const py = y + dy * i * stepPx;
    const id = junctionAt(map, px, py);
    if (id === -1) continue;
    const colour = signalColour(id, dirIdx, tick, t);
    if (colour === 'green') return Infinity;
    const gap = Math.max(0, i * stepPx - halfExtent - STOP_LINE_SETBACK);
    if (colour === 'amber') {
      // v^2 / 2a: the shortest comfortable stop from here.
      const need = (speed * speed) / (2 * Math.max(1, comfortBrake));
      if (need > gap) return Infinity; // committed — clear the box
    }
    return gap;
  }
  return Infinity;
}
