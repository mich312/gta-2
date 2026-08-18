import { TILE_SIZE, type CityMap, type JunctionMap, type SignalHead } from '../world/types.js';
import { courseCrossings } from '../world/geometry.js';
import { isSignalCrossing } from '../world/marks.js';
import { CARDINALS, RIGHT_STEP, drivableTile } from './roadgrid.js';

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
 * The largest patch of tarmac that still counts as one signalled junction.
 *
 * A square crossroads of two four-lane roads is sixteen tiles. Taken at an
 * angle, or where a curved arterial spills into a grid, the connected patch
 * runs to thirty and beyond with a dozen arms off it — and the head rule
 * below, which walks the kerb of each arm, has no sensible answer for a shape
 * like that. Those places are plazas: many ways in, no phase that governs
 * them, negotiated the way junctions were before signals existed. Left
 * unlabelled, so no head is collected and no light is drawn.
 */
const MAX_JUNCTION_TILES = 20;

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
 * How far the drivable road runs either side of a tile along one direction,
 * in tiles — capped, because all any caller needs to know is whether the span
 * is wider than a carriageway.
 */
function spanAlong(map: CityMap, tx: number, ty: number, dx: number, dy: number): number {
  let span = 1;
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, tx + dx * i, ty + dy * i)) break;
    span++;
  }
  for (let i = 1; i <= MAX_LANE_TILES; i++) {
    if (!drivableTile(map, tx - dx * i, ty - dy * i)) break;
    span++;
  }
  return span;
}

/**
 * The four directions a span is measured along: the two axes and the two
 * diagonals.
 *
 * The diagonals are not decoration. A carriageway is narrow ACROSS its
 * direction of travel and long along it — but "across" only means "along y"
 * if the road runs along x, and the city's roads are polylines now. A
 * four-tile road at forty-five degrees measures nearly six tiles across both
 * axes, so an axis-only test called every tile of every diagonal road a
 * junction, and the ring road came out as one junction with thirty-three
 * arms. Taking the NARROWEST of the four asks the right question — is this
 * tile narrow in any direction at all — and answers it the same way for a
 * road at any angle.
 */
const SPAN_DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/**
 * A tile where two roads genuinely cross, rather than a wide road.
 *
 * The test is the lane model's own: a carriageway is a strip that is narrow
 * across the direction of travel and long along it, so an ordinary road tile
 * is narrow in at least one direction. A tile that is over-wide in EVERY
 * direction is not a carriageway at all — it is a junction, a plaza or a car
 * park, which is precisely the set of places a driver has to negotiate rather
 * than follow.
 */
function isJunctionTile(map: CityMap, tx: number, ty: number): boolean {
  if (!drivableTile(map, tx, ty)) return false;
  for (const [dx, dy] of SPAN_DIRS) {
    if (spanAlong(map, tx, ty, dx, dy) <= MAX_LANE_TILES) return false;
  }
  return true;
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
      if (count >= 32767) {
        const early = signalPolicy(map, idOf, count);
        return { idOf, count, signalled: early, heads: collectHeads(map, idOf, early) };
      }
      const id = count++;
      idOf[seed] = id;
      queue.length = 0;
      queue.push(tx, ty);
      const members: number[] = [seed];
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
          members.push(idx);
          queue.push(nx, ny);
        }
      }
      // Past a certain size it is not a junction, it is a plaza — the apron
      // where a curved arterial merges into a grid, or a yard, or the mouth
      // of a bus station. Those places have a dozen ways in and no sensible
      // phase, and a signal on one governs nothing; drivers negotiate them
      // the way they did before signals existed. Unlabelled, so no head is
      // collected and no light is drawn.
      if (members.length > MAX_JUNCTION_TILES) {
        for (const i of members) idOf[i] = -1;
        count--;
      }
    }
  }
  const merged = mergeAtCrossings(map, idOf, count);
  const signalled = signalPolicy(map, idOf, merged);
  const heads = collectHeads(map, idOf, signalled);
  // A junction with one arm is not a junction, and a light on it is a light
  // governing a dead end. It happens where a crossing's box has only one way
  // in that a driver can approach along a cardinal — the mouth of a slip, a
  // stub against the map edge. Unsignalised, so it joins the negotiated
  // majority, and its head goes with it.
  const armCount = new Map<number, number>();
  for (const h of heads) armCount.set(h.junctionId, (armCount.get(h.junctionId) ?? 0) + 1);
  for (const [id, n] of armCount) if (n < 2) signalled[id] = 0;
  return {
    idOf,
    count: merged,
    signalled,
    heads: heads.filter((h) => signalled[h.junctionId] === 1),
  };
}

/**
 * One crossroads is one junction, however the tarmac happens to connect.
 *
 * `isJunctionTile` asks a local question — is this tile over-wide in every
 * direction — and the answer says no along a diagonal seam through the middle
 * of a perfectly ordinary crossroads, so the flood fill comes back with the
 * box in two or four pieces. Measured on the shipped city: of the 82 arterial
 * crossings that carry lights, 47 were split in two and 7 in four, and every
 * piece got its own id, its own phase offset and its own set of four heads.
 * That is not a cosmetic count — eight lights round one crossroads is bad
 * enough, but two ids means two independent phases, so the same crossroads
 * could show green to both axes at once, which is the one property
 * `signalColour` is built to make impossible.
 *
 * A junction is where two centrelines meet, and §26 computes that from the
 * curves. So: union every labelled component a crossing's disc touches, and
 * renumber. The plaza cap is deliberately NOT re-applied to the result — it
 * exists to refuse a shape with no sensible phase, and a shape that one
 * course crossing accounts for has exactly one.
 */
function mergeAtCrossings(map: CityMap, idOf: Int16Array, count: number): number {
  const courses = (map.courses ?? []).filter((c) => c.kind !== 'path');
  if (courses.length === 0) return count;
  const parent: number[] = [];
  for (let i = 0; i < count; i++) parent.push(i);
  const find = (i: number): number => {
    let r = i;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    for (let j = i; (parent[j] as number) !== r; ) {
      const next = parent[j] as number;
      parent[j] = r;
      j = next;
    }
    return r;
  };
  const w = map.widthTiles;
  const h = map.heightTiles;
  let next = count;
  for (const cross of courseCrossings(courses)) {
    // The disc itself, not its bounding box: a box wide enough to cover a
    // four-tile crossing also reaches the mouth of the next street along.
    const reach = Math.ceil(cross.r + 0.5);
    let root = -1;
    const box: number[] = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const tx = Math.floor(cross.x) + dx;
        const ty = Math.floor(cross.y) + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const ox = tx + 0.5 - cross.x;
        const oy = ty + 0.5 - cross.y;
        if (ox * ox + oy * oy > (cross.r + 0.5) * (cross.r + 0.5)) continue;
        if (!drivableTile(map, tx, ty)) continue;
        const i = ty * w + tx;
        box.push(i);
        const id = idOf[i] as number;
        if (id < 0) continue;
        const r = find(id);
        if (root < 0) root = r;
        else if (r !== root) parent[r] = root;
      }
    }
    // An arterial crossing the flood fill never labelled at all gets an id of
    // its own.
    //
    // `isJunctionTile` also asks whether the tarmac is over-wide along both
    // DIAGONALS, which a four-tile avenue crossing a three-tile street is
    // not: the box is 4x3 and its diagonal run is three. So the commonest
    // junction in downtown — every cross street on The Spine — was not
    // labelled, carried no light, and could not carry a crossing. 69 of the
    // city's 151 arterial crossings were in that state. The curve knows the
    // junction is there.
    //
    // Only the arterial ones, and only where the fill found nothing: a
    // residential crossing that the tile test declines is a place drivers
    // negotiate either way, and labelling it would put a node in the routing
    // graph for every corner in the city.
    if (root < 0) {
      // Int16Array, as the flood fill's own bail-out says: a wrapped id is a
      // junction whose arms disagree, so stop allocating rather than wrap.
      if (box.length < 4 || next >= 32767 || !isSignalCrossing(cross)) continue;
      root = next++;
      parent.push(root);
    }
    // The box the curve describes, whole: a labelling that stops half way
    // across the mouth leaves approach tiles inside the junction. Written as
    // we go, so the next crossing along sees them and unions with them
    // instead of claiming a second id for the same tarmac.
    for (const i of box) if ((idOf[i] as number) < 0) idOf[i] = root;
  }
  return renumber(idOf, parent, next);
}

/**
 * Row-major renumbering of a union-found labelling, in order of first
 * appearance — so the ids stay a pure function of the map, which is what lets
 * the phase be a function of the id on both hosts.
 */
function renumber(idOf: Int16Array, parent: readonly number[], count: number): number {
  const find = (i: number): number => {
    let r = i;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    return r;
  };
  const renamed = new Int32Array(count).fill(-1);
  let next = 0;
  for (let i = 0; i < idOf.length; i++) {
    const id = idOf[i] as number;
    if (id < 0) continue;
    const root = find(id);
    if ((renamed[root] as number) < 0) renamed[root] = next++;
    idOf[i] = renamed[root] as number;
  }
  return next;
}

/**
 * Which labelled junctions get lights: one byte per junction id.
 *
 * Every junction in the city was signalised, which sounds like thoroughness
 * and reads as noise: 2,990 heads over 779 junctions, and 537 of those
 * junctions are four tiles of tarmac or less — a corner where two residential
 * streets meet, wearing a full set of four lights. Nobody builds that. A
 * signal is what a city spends on a crossing big enough to need governing,
 * and the plan already says which roads those are: the paint's own
 * `SIGNAL_MIN_WIDTH` is `MAX_CARRIAGEWAY`, so a four-tile course is this
 * city's arterial. The rest are not abolished, only unsignalised — they stay
 * junctions for the lane model, the road network and the routing, and drivers
 * negotiate them the way they did before signals existed, which is also what
 * the oversized plazas above have always done.
 *
 * The threshold lives in world/marks.ts because the PAINT is decided by the
 * same number: a stop line at an unsignalised junction is a line nobody is
 * holding, and a light over an unmarked mouth is a light with nothing to stop
 * at. One constant, so the two cannot drift.
 *
 * The question is about the ROADS that meet, not about the tarmac they left
 * behind — a merged sheet of carriageway is over-wide in every direction and
 * says nothing about whether an arterial passes through it. So it is asked of
 * the courses, and the answer is transferred to the tile labelling by looking
 * up the junction under each arterial crossing.
 *
 * A city with no courses (a fixture, a bare arena) signalises everything,
 * which is exactly what it did before this rule existed.
 */
function signalPolicy(map: CityMap, idOf: Int16Array, count: number): Uint8Array {
  const signalled = new Uint8Array(count);
  const courses = (map.courses ?? []).filter((c) => c.kind !== 'path');
  if (courses.length === 0) {
    signalled.fill(1);
    return signalled;
  }
  const w = map.widthTiles;
  const h = map.heightTiles;
  for (const cross of courseCrossings(courses)) {
    if (!isSignalCrossing(cross)) continue;
    // The crossing point is a point on a curve; the junction is a patch of
    // tiles that may sit half a carriageway off it (the curve crosses where
    // the centrelines do, the tarmac spreads to the kerbs). Search the disc.
    const reach = Math.ceil(cross.r) + 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const tx = Math.floor(cross.x) + dx;
        const ty = Math.floor(cross.y) + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const id = idOf[ty * w + tx] as number;
        if (id >= 0) signalled[id] = 1;
      }
    }
  }
  return signalled;
}

/**
 * Does this course crossing stand at a junction the city signalises?
 *
 * The painters ask it, so that the paint and the lights are the same set of
 * places. `signalPolicy` runs the lookup one way — arterial crossing to
 * junction id — and this runs it back, over the same disc, so a crossing that
 * fell inside a PLAZA (too many tiles to have a phase, and deliberately
 * unlabelled) gets no stop line either. Stop lines nobody is holding were
 * most of what made §35's crossings read as debris.
 *
 * A map with no junction table at all — an arena fixture — answers yes, which
 * keeps a bare CityMap paintable.
 */
export function signalledCrossing(
  map: {
    widthTiles: number;
    heightTiles: number;
    junctions?: JunctionMap | undefined;
  },
  cross: { x: number; y: number; r: number },
): boolean {
  const table = map.junctions;
  if (!table || table.count === 0) return true;
  const w = map.widthTiles;
  const h = map.heightTiles;
  const reach = Math.ceil(cross.r) + 1;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = Math.floor(cross.x) + dx;
      const ty = Math.floor(cross.y) + dy;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const id = table.idOf[ty * w + tx] as number;
      if (id >= 0 && table.signalled[id] === 1) return true;
    }
  }
  return false;
}

/**
 * The tile a driver travelling `dirIdx` is on when the junction ahead of it
 * first becomes its problem: drivable, not itself inside a junction, with a
 * junction tile immediately in front. That is exactly where `stopLineGap`
 * first sees the light, so the head and the stop line agree by construction
 * rather than by two constants being kept in step.
 */
function isApproachTile(
  map: CityMap,
  idOf: Int16Array,
  tx: number,
  ty: number,
  dirIdx: number,
): number {
  const w = map.widthTiles;
  const h = map.heightTiles;
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return -1;
  if (!drivableTile(map, tx, ty) || idOf[ty * w + tx] !== -1) return -1;
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const nx = tx + dx;
  const ny = ty + dy;
  if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
  return idOf[ny * w + nx] as number;
}

/**
 * One head per arm of every junction — not one per tile of tarmac.
 *
 * The first version emitted a head for every approach tile, which on a
 * four-tile arterial meant four lights strung right across the carriageway,
 * half of them standing over the lanes leaving the junction. A crossroads read
 * as a string of fairy lights rather than as a junction, and it said something
 * false: those outer lights are not governing anybody.
 *
 * A real head stands at the kerb on the near right of the approach, one per
 * arm, and that is a purely local test — a tile carries the head when the
 * tile one step further towards the driver's right is not another approach
 * tile of the same junction. So the kerb-most tile of each contiguous run
 * wins, one head per arm falls out, and a carriageway split by a central
 * reservation (two runs) correctly gets one each.
 *
 * Which half is the approach comes from `RIGHT_STEP`, the same fact the lane
 * model steers by: heading east you keep to the south half, so the light you
 * obey is the one on the southern kerb.
 */
function collectHeads(map: CityMap, idOf: Int16Array, signalled: Uint8Array): SignalHead[] {
  const w = map.widthTiles;
  const h = map.heightTiles;
  const heads: SignalHead[] = [];
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
        const id = isApproachTile(map, idOf, tx, ty, dirIdx);
        if (id === -1 || signalled[id] !== 1) continue;
        const [rx, ry] = RIGHT_STEP[dirIdx] as readonly [number, number];
        // Somebody further right is closer to the kerb: let them have it.
        if (isApproachTile(map, idOf, tx + rx, ty + ry, dirIdx) === id) continue;
        heads.push({
          x: tx * TILE_SIZE + TILE_SIZE / 2,
          y: ty * TILE_SIZE + TILE_SIZE / 2,
          dirIdx,
          junctionId: id,
        });
      }
    }
  }
  // One head per arm, enforced rather than hoped for.
  //
  // The kerb-most rule above is a purely local test, and it gives exactly one
  // head per arm on a grid — which is what the city used to be. Where a
  // curved arterial meets a grid the approach tiles wrap round the junction
  // in steps instead of lying in one straight run, and each step passes the
  // local test: eighteen lights round one crossroads. Keeping the single
  // approach closest to the junction, per junction and per cardinal, says the
  // thing the local test was a proxy for, and says it for a road at any angle.
  const centres = new Map<number, { x: number; y: number; n: number }>();
  for (const h of heads) {
    const c = centres.get(h.junctionId) ?? { x: 0, y: 0, n: 0 };
    c.x += h.x;
    c.y += h.y;
    c.n++;
    centres.set(h.junctionId, c);
  }
  const best = new Map<number, SignalHead>();
  for (const h of heads) {
    const c = centres.get(h.junctionId) as { x: number; y: number; n: number };
    const d = Math.abs(h.x - c.x / c.n) + Math.abs(h.y - c.y / c.n);
    const key = h.junctionId * 4 + h.dirIdx;
    const held = best.get(key);
    // Ties break on position, so every host keeps the same head.
    if (
      !held ||
      d < heldDistance(held, c) ||
      (d === heldDistance(held, c) && (h.y < held.y || (h.y === held.y && h.x < held.x)))
    ) {
      best.set(key, h);
    }
  }
  return [...best.values()].sort((a, b) => a.junctionId - b.junctionId || a.dirIdx - b.dirIdx);
}

/** How far a head sits from its junction's centre of gravity. */
function heldDistance(h: SignalHead, c: { x: number; y: number; n: number }): number {
  return Math.abs(h.x - c.x / c.n) + Math.abs(h.y - c.y / c.n);
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
    // An unsignalised junction has no line to stop at: no head stands there,
    // so a driver braking for one would be stopping at nothing.
    if (id === -1 || (map.junctions?.signalled[id] ?? 1) !== 1) continue;
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
