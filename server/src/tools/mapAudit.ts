import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  parseCityPlan,
  pointInPoly,
  shoreChains,
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_FLOOR,
  T_LOT,
  T_PARK,
  T_RAMP,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  type BakedCity,
  type CityPlan,
  type StreetCourse,
} from 'shared';

/**
 * pnpm mapaudit — the visual-bug detector for the tile map.
 *
 *   node server/dist/tools/mapAudit.js [--data=path] [--plan=path]
 *                                      [--only=sig,sig] [--limit=N] [--all]
 *
 * `checkCity` asks whether the city is CORRECT — one road network, landmarks
 * reachable, shops on a street, bridges that span. It never asks whether the
 * city LOOKS right from above, and every visual defect this project has found
 * so far was found by a person squinting at a render: Hollis Creek uncrossed,
 * The Docks with no cross streets, a coastline that stair-stepped.
 *
 * This is that squint, written down. It is a SURVEY INSTRUMENT, not a gate:
 * deliberately not wired into `checkCity` or the test suite, because a
 * detector whose false-positive rate is unknown costs a reviewing round the
 * first time it fires. Each signature below states what it looks for and what
 * it deliberately excuses; the ones that are mostly noise say `noisy` in the
 * summary rather than pretending otherwise.
 *
 * Every signature is calibrated against a bake where the defect is KNOWN to be
 * present — `--data` decodes any `city.data.ts`, so the pre-fix tree is one
 * `git show` away and a detector that reports a clean city there is broken
 * rather than reassuring:
 *
 *   git show 1469611:shared/src/world/city.data.ts > /tmp/old.city.data.ts
 *   node server/dist/tools/mapAudit.js --data=/tmp/old.city.data.ts
 *
 * Output is one line per candidate, columns separated by two spaces:
 *
 *   <signature>  x,y,w  <severity>  <one-line reason>
 *
 * `x,y,w` is a `pnpm mapgen --crop=` argument, so every line is directly a
 * command for looking at the thing it claims.
 */

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

type Severity = 'high' | 'med' | 'low';

interface Finding {
  sig: string;
  x: number;
  y: number;
  w: number;
  severity: Severity;
  reason: string;
  /** Ranking key within a signature: bigger is worse. */
  rank: number;
}

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/**
 * Signatures whose false-positive rate was measured by cropping their hits at
 * `--scale=16` and looking at them, and found high enough that a reviewer
 * should treat every hit as a question rather than a defect. Stated here
 * rather than in prose so the OUTPUT carries the caveat to whoever reads it
 * next — a detector nobody can tell is unreliable costs a reviewing round.
 *
 * `road-width-jump` earns it: every one of its first twenty-one hits was a
 * junction mouth flaring or a dual carriageway closing round the end of its
 * median, and the gates below remove those by construction rather than by
 * understanding them. What survives is a street narrowing where its borough
 * ends, which is real geometry and probably deliberate.
 *
 * `street-serves-nothing` earns it differently and more cheaply: four hits,
 * two of them right. Two of the four are coast roads whose COURSE was trimmed
 * at the waterline while the tarmac carries on round the bend, and no gate
 * this tool can express separates them from the islet street the signature
 * exists to find — that one joins the bridge approach sideways at exactly the
 * same angle. Four crops is a cheap glance; a reviewer taking all four for
 * defects is not.
 */
const NOISY = new Set<string>(['road-width-jump', 'built-staircase', 'street-serves-nothing']);

/* ------------------------------------------------------------------ */
/* The map, and the small vocabulary every signature shares            */
/* ------------------------------------------------------------------ */

/** Carriageway: what a car drives along, as opposed to stands on. */
function isRoad(t: number): boolean {
  return t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
}

/**
 * Ground whose edges are drawn by the geography rather than built by hand.
 * The distinction is the whole defence against drowning in staircase
 * false positives: WORLDGEN.md §15.4 is explicit that quays, lots and the
 * cliff's convex headlands stay square ON PURPOSE, so a straight run of
 * water↔quay is a built edge and a straight run of water↔sand is not.
 */
function isNatural(t: number): boolean {
  return t === T_FIELD || t === T_PARK || t === T_TREES || t === T_SAND || t === T_WATER;
}

interface Audit {
  city: BakedCity;
  W: number;
  H: number;
  tiles: Uint8Array;
  at: (x: number, y: number) => number;
  road: Uint8Array;
  /** Length of the maximal horizontal / vertical road run through each tile. */
  runX: Int16Array;
  runY: Int16Array;
  /** Left end / top end of that run, so a band's edges can be tracked. */
  runXL: Int16Array;
  runYT: Int16Array;
}

function buildAudit(city: BakedCity): Audit {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const tiles = city.tiles;
  // Off the map is sea. That is the city's own rule (`generate.ts`: "the city
  // has edges, and where the map stops there is sea"), and it is what makes a
  // carriageway running off the edge a quay rather than a dead end.
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (tiles[y * W + x] as number);

  const road = new Uint8Array(W * H);
  for (let i = 0; i < tiles.length; i++) road[i] = isRoad(tiles[i] as number) ? 1 : 0;

  const runX = new Int16Array(W * H);
  const runXL = new Int16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (road[y * W + x] === 0) {
        x++;
        continue;
      }
      let e = x;
      while (e < W && road[y * W + e] === 1) e++;
      for (let k = x; k < e; k++) {
        runX[y * W + k] = e - x;
        runXL[y * W + k] = x;
      }
      x = e;
    }
  }
  const runY = new Int16Array(W * H);
  const runYT = new Int16Array(W * H);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (road[y * W + x] === 0) {
        y++;
        continue;
      }
      let e = y;
      while (e < H && road[e * W + x] === 1) e++;
      for (let k = y; k < e; k++) {
        runY[k * W + x] = e - y;
        runYT[k * W + x] = y;
      }
      y = e;
    }
  }
  return { city, W, H, tiles, at, road, runX, runY, runXL, runYT };
}

/** A crop box around a feature, in the form `pnpm mapgen --crop=` wants. */
function crop(x: number, y: number, span: number, W: number, H: number): [number, number, number] {
  const w = Math.max(24, Math.min(200, span + 20));
  const cx = Math.max(0, Math.min(W - w, Math.round(x - w / 2)));
  const cy = Math.max(0, Math.min(H - w, Math.round(y - w / 2)));
  return [cx, cy, w];
}

/* ------------------------------------------------------------------ */
/* 1. road-deadend — a carriageway that just stops                     */
/* ------------------------------------------------------------------ */

const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * A carriageway that dead-ends without a landmark, a quay or the map edge to
 * stop at.
 *
 * The shape looked for is deliberately narrow, because the loose version of
 * this question ("a road tile with no road beyond it") fires on every corner
 * and every junction mouth in the city. A dead end here is a CAP: a run of
 * road tiles all of which stop facing the same way, the same width as the
 * carriageway behind them for three tiles back, with no road off either end of
 * the cap — a straight street of constant width that simply ends.
 *
 * The excuses are the ones a player would accept: a quay (water, bank or sand
 * beyond), the map edge, a landmark to arrive at, or a yard, apron or shop
 * floor the tarmac hands over to.
 */
function deadEnds(a: Audit, landmarkNear: (x: number, y: number, r: number) => boolean): Finding[] {
  const { W, H, at, road } = a;
  const out: Finding[] = [];
  for (const [dx, dy] of DIRS) {
    // Perpendicular, for walking along the cap.
    const px = dy;
    const py = -dx;
    const seen = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (road[i] === 0 || seen[i] === 1) continue;
        if (isRoad(at(x + dx, y + dy))) continue;
        // Walk the cap out along the perpendicular in both senses.
        let a0 = 0;
        while (
          isRoad(at(x + px * (a0 - 1), y + py * (a0 - 1))) &&
          !isRoad(at(x + px * (a0 - 1) + dx, y + py * (a0 - 1) + dy))
        ) {
          a0--;
        }
        let a1 = 0;
        while (
          isRoad(at(x + px * (a1 + 1), y + py * (a1 + 1))) &&
          !isRoad(at(x + px * (a1 + 1) + dx, y + py * (a1 + 1) + dy))
        ) {
          a1++;
        }
        for (let k = a0; k <= a1; k++) {
          const kx = x + px * k;
          const ky = y + py * k;
          if (kx >= 0 && ky >= 0 && kx < W && ky < H) seen[ky * W + kx] = 1;
        }
        const len = a1 - a0 + 1;
        // A carriageway is 2..6 tiles across. Anything wider is a plaza, an
        // apron or a lot, and "the plaza stops here" is not a defect.
        if (len < 2 || len > 6) continue;

        // Not a corner and not a junction mouth: no road just off either end
        // of the cap, and the same width three tiles back.
        if (isRoad(at(x + px * (a0 - 1), y + py * (a0 - 1)))) continue;
        if (isRoad(at(x + px * (a1 + 1), y + py * (a1 + 1)))) continue;
        let straight = true;
        for (let d = 1; d <= 3 && straight; d++) {
          for (let k = a0 - 1; k <= a1 + 1 && straight; k++) {
            const want = k >= a0 && k <= a1;
            const tx = x + px * k - dx * d;
            const ty = y + py * k - dy * d;
            if (isRoad(at(tx, ty)) !== want) straight = false;
          }
        }
        if (!straight) continue;

        // What is beyond, over the two tiles the street would have run into.
        const beyond: number[] = [];
        let offMap = false;
        for (let k = a0; k <= a1; k++) {
          for (let d = 1; d <= 2; d++) {
            const bx = x + px * k + dx * d;
            const by = y + py * k + dy * d;
            if (bx < 0 || by < 0 || bx >= W || by >= H) offMap = true;
            beyond.push(at(bx, by));
          }
        }
        if (offMap) continue;
        // A quay is a reason to stop, and so is water you would fall into.
        if (beyond.some((t) => t === T_WATER || t === T_BANK || t === T_SAND)) continue;
        // So is a yard, an apron, or the floor of the place you drove to.
        if (beyond.some((t) => t === T_LOT || t === T_RUNWAY || t === T_FLOOR)) continue;
        const cxT = x + px * ((a0 + a1) / 2);
        const cyT = y + py * ((a0 + a1) / 2);
        if (landmarkNear(cxT, cyT, 10)) continue;

        // How far the NEXT carriageway is, straight on. This is the split that
        // calibration forced: a street stopping in the middle of a meadow is
        // the edge of the built-up area and a matter of taste, but a street
        // stopping two tiles short of the avenue it plainly wants to join is a
        // junction the layout failed to cut, and a driver meets it as a wall
        // of grass across the road. They are not the same finding and they do
        // not deserve the same place in a queue.
        let short = 0;
        for (let d = 1; d <= 6; d++) {
          let hit = false;
          for (let k = a0; k <= a1; k++) {
            if (isRoad(at(x + px * k + dx * d, y + py * k + dy * d))) hit = true;
          }
          if (hit) {
            short = d;
            break;
          }
        }
        const [cxc, cyc, cw] = crop(cxT, cyT, len, W, H);
        if (short > 0) {
          // WHAT is in the gap decides how much this matters, and it is the
          // difference between three findings a reviewer should act on and
          // fourteen they should glance at. A tile of pavement is a kerb a car
          // can mount and a junction that merely reads wrong; a tile of grass
          // across the mouth of a street reads as a road that gives up; a wall
          // or a wood in the gap is a street that cannot be driven at all —
          // and none of the three is visible to `checkCity`, whose
          // connectivity rule counts pavement, park and field as drivable and
          // is therefore satisfied by every one of them.
          const inGap = new Set<number>();
          for (let d = 1; d < short; d++) {
            for (let k = a0; k <= a1; k++) inGap.add(at(x + px * k + dx * d, y + py * k + dy * d));
          }
          const solid = inGap.has(T_BUILDING) || inGap.has(T_TREES) || inGap.has(T_WATER);
          const green = inGap.has(T_FIELD) || inGap.has(T_PARK);
          const what = [...inGap].map(tileName).join('+');
          out.push({
            sig: 'road-stops-short',
            x: cxc,
            y: cyc,
            w: cw,
            severity: solid ? 'high' : green ? 'med' : 'low',
            rank: (solid ? 200 : green ? 100 : 10) + (10 - short) + len,
            reason: `${len}-wide carriageway at ${Math.round(cxT)},${Math.round(cyT)} stops ${short} tile(s) short of the carriageway it runs at, heading ${dirName(dx, dy)}, with ${what} across the mouth — the junction was never cut`,
          });
          continue;
        }

        const wall = beyond.filter((t) => t === T_BUILDING).length;
        const green = beyond.filter((t) => t === T_FIELD || t === T_TREES || t === T_PARK).length;
        const severity: Severity = wall > 0 ? 'high' : green > 0 ? 'med' : 'low';
        const into =
          wall > 0
            ? 'a building wall'
            : green > 0
              ? 'open ground'
              : 'pavement';
        out.push({
          sig: 'road-deadend',
          x: cxc,
          y: cyc,
          w: cw,
          severity,
          rank: (wall > 0 ? 100 : green > 0 ? 50 : 10) + len,
          reason: `${len}-wide carriageway stops dead at ${Math.round(cxT)},${Math.round(cyT)} facing ${dirName(dx, dy)} into ${into} — no landmark, quay or map edge to stop at`,
        });
      }
    }
  }
  return out;
}

function dirName(dx: number, dy: number): string {
  if (dx === 1) return 'east';
  if (dx === -1) return 'west';
  return dy === 1 ? 'south' : 'north';
}

/* ------------------------------------------------------------------ */
/* 2. road-speck / road-notch — one tile too many, one tile too few    */
/* ------------------------------------------------------------------ */

/** 4-connected components of a mask, as index lists. */
function components(mask: Uint8Array, W: number, H: number): number[][] {
  const seen = new Uint8Array(W * H);
  const out: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] === 0 || seen[s] === 1) continue;
    const bag: number[] = [];
    seen[s] = 1;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      bag.push(i);
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || mask[j] === 0) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    out.push(bag);
  }
  return out;
}

function bbox(bag: number[], W: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of bag) {
    const x = i % W;
    const y = (i - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * A one-tile island of tarmac with nothing to join, and a one-tile bite out of
 * a carriageway. Both are raster accidents rather than anything anybody drew,
 * and both are the kind of thing a driver hits at speed.
 */
function specksAndNotches(a: Audit): Finding[] {
  const { W, H, at, road, tiles } = a;
  const out: Finding[] = [];

  for (const bag of components(road, W, H)) {
    if (bag.length > 3) continue;
    const b = bbox(bag, W);
    const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.x1 - b.x0 + 1, W, H);
    out.push({
      sig: 'road-speck',
      x: cx,
      y: cy,
      w: cw,
      severity: 'med',
      rank: 100 - bag.length,
      reason: `island of ${bag.length} road tile(s) at ${b.x0},${b.y0} joined to no carriageway`,
    });
  }

  // A notch: a non-road tile with carriageway on all four sides.
  const notch = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (road[i] === 1) continue;
      if (!isRoad(at(x + 1, y)) || !isRoad(at(x - 1, y))) continue;
      if (!isRoad(at(x, y + 1)) || !isRoad(at(x, y - 1))) continue;
      notch[i] = 1;
    }
  }
  for (const bag of components(notch, W, H)) {
    if (bag.length > 4) continue;
    const b = bbox(bag, W);
    const kinds = new Set(bag.map((i) => tiles[i] as number));
    const wall = kinds.has(T_BUILDING) || kinds.has(T_TREES) || kinds.has(T_WATER);
    const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.x1 - b.x0 + 1, W, H);
    out.push({
      sig: 'road-notch',
      x: cx,
      y: cy,
      w: cw,
      severity: wall ? 'high' : 'med',
      rank: (wall ? 100 : 50) + (5 - bag.length),
      reason: `${bag.length}-tile ${wall ? 'SOLID ' : ''}hole at ${b.x0},${b.y0} punched through a carriageway (tile type ${[...kinds].join('/')})`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. road-width-jump — a street that changes width mid-run             */
/* ------------------------------------------------------------------ */

/**
 * A carriageway whose width steps between one tile and the next.
 *
 * Only asked of STRAIGHT axis-aligned bands: a curved or diagonal street
 * rasterises to a band whose horizontal extent breathes every other row by
 * construction, and asking this question of one is how a detector arrives at
 * a thousand hits and no information. The straightness gate is that the band's
 * two edges hold still for three tiles either side of the step.
 */
function widthJumps(a: Audit): Finding[] {
  const { W, H, road, runX, runY, runXL, runYT } = a;
  const out: Finding[] = [];

  const scan = (vertical: boolean): void => {
    const along = vertical ? H : W;
    const across = vertical ? W : H;
    for (let u = 0; u < across; u++) {
      for (let v = 0; v + 1 < along; v++) {
        const i = vertical ? v * W + u : u * W + v;
        const j = vertical ? (v + 1) * W + u : u * W + v + 1;
        if (road[i] === 0 || road[j] === 0) continue;
        // The width across the band, and the band's own long axis.
        const wi = (vertical ? runX[i] : runY[i]) as number;
        const wj = (vertical ? runX[j] : runY[j]) as number;
        const li = (vertical ? runY[i] : runX[i]) as number;
        if (li < 8) continue; // not a run, just a stub
        if (wi > 8 || wj > 8 || wi < 2 || wj < 2) continue; // junction or plaza
        if (Math.abs(wi - wj) < 2) continue;
        // Only report from the tile on the band's own centre line, so a
        // 3-tile-wide step is one finding rather than three.
        const ei = (vertical ? runXL[i] : runYT[i]) as number;
        if ((vertical ? u : v) !== ei) continue;
        // Straightness: the near edge must hold still for three tiles either
        // side of the step, so a curve's constant breathing is not a jump.
        let wobble = 0;
        let prev = -1;
        let ok = true;
        for (let d = -3; d <= 4 && ok; d++) {
          const vv = v + d;
          if (vv < 0 || vv + 1 > along) {
            ok = false;
            break;
          }
          const k = vertical ? vv * W + u : u * W + vv;
          if (road[k] === 0) {
            ok = false;
            break;
          }
          const e = (vertical ? runXL[k] : runYT[k]) as number;
          if (prev >= 0) wobble += Math.abs(e - prev);
          prev = e;
        }
        if (!ok || wobble > 2) continue;

        // Both widths must PERSIST. A junction mouth flares for a tile or two
        // before it becomes the junction, and reporting that flare as a width
        // change is how this signature spent its first twenty-one hits.
        const holds = (from: number, step: number, want: number): boolean => {
          for (let d = 0; d < 5; d++) {
            const vv = from + step * d;
            if (vv < 0 || vv >= along) return false;
            const k = vertical ? vv * W + u : u * W + vv;
            if (road[k] === 0) return false;
            if (((vertical ? runX[k] : runY[k]) as number) !== want) return false;
          }
          return true;
        };
        if (!holds(v, -1, wi) || !holds(v + 1, 1, wj)) continue;

        // And it must not be a dual carriageway closing up. Where a median
        // ends, two 3-wide bands become one 8-wide band in a single row, and
        // that is a carriageway doing exactly what it should. The tell is the
        // median itself: road, then not-road, then road, across the WIDE
        // band's span, on the narrow side of the step.
        const wide = wi > wj ? wi : wj;
        const wideAt = wi > wj ? v : v + 1;
        const narrowAt = wi > wj ? v + 1 : v;
        const wideEdge = (vertical
          ? runXL[vertical ? wideAt * W + u : u * W + wideAt]
          : runYT[u * W + wideAt]) as number;
        let flips = 0;
        let was = -1;
        for (let s = 0; s < wide; s++) {
          const c = wideEdge + s;
          const k = vertical ? narrowAt * W + c : c * W + narrowAt;
          if (c < 0 || c >= (vertical ? W : H)) continue;
          const isr = road[k] as number;
          if (was >= 0 && isr !== was) flips++;
          was = isr;
        }
        if (flips >= 2) continue;

        const x = vertical ? u : v;
        const y = vertical ? v : u;
        const [cx, cy, cw] = crop(x, y, Math.max(wi, wj), W, H);
        out.push({
          sig: 'road-width-jump',
          x: cx,
          y: cy,
          w: cw,
          severity: 'low',
          rank: Math.abs(wi - wj),
          reason: `straight ${vertical ? 'north-south' : 'east-west'} carriageway steps ${wi}->${wj} tiles wide at ${x},${y}`,
        });
      }
    }
  };
  scan(true);
  scan(false);
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. junction-stub — a junction with only one arm                     */
/* ------------------------------------------------------------------ */

/**
 * A patch of tarmac wide in both axes — the shape a crossroads makes — with
 * only one street leaving it. A junction is a place streets meet; one that
 * meets nothing is a bulge on the end of a road, and reads from above as a
 * mistake in the lattice rather than as a turning head.
 */
function junctionStubs(a: Audit): Finding[] {
  const { W, H, road, runX, runY } = a;
  const junc = new Uint8Array(W * H);
  for (let i = 0; i < road.length; i++) {
    if (road[i] === 0) continue;
    if (Math.min(runX[i] as number, runY[i] as number) >= 5) junc[i] = 1;
  }
  const out: Finding[] = [];
  for (const bag of components(junc, W, H)) {
    if (bag.length < 9) continue;
    const b = bbox(bag, W);
    // A plaza or a wide apron is not a junction; a crossroads is compact.
    if (b.x1 - b.x0 > 14 || b.y1 - b.y0 > 14) continue;
    const inBlob = new Set(bag);
    // The arms: road tiles touching the blob but not in it, grouped by
    // 4-connectivity among themselves so a 3-wide street counts once.
    const armMask = new Uint8Array(W * H);
    for (const i of bag) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (road[j] === 1 && !inBlob.has(j)) armMask[j] = 1;
      }
    }
    // Grow each arm seed a little so the pieces of one street join up.
    const arms = components(armMask, W, H).length;
    if (arms > 1) continue;
    const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.x1 - b.x0 + 1, W, H);
    out.push({
      sig: 'junction-stub',
      x: cx,
      y: cy,
      w: cw,
      severity: 'med',
      rank: bag.length,
      reason: `${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1} junction-shaped patch at ${b.x0},${b.y0} with ${arms} arm(s) leaving it`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 5. walk-orphan — pavement serving no street                         */
/* ------------------------------------------------------------------ */

/**
 * A run of pavement with no carriageway anywhere along it. A sidewalk is the
 * edge of a street; one that touches none is either a footpath somebody meant
 * or a block ring the streets never arrived at, and from above the second is
 * a pale ribbon in the middle of nothing.
 */
function orphanPavement(a: Audit): Finding[] {
  const { W, H, tiles, road, city } = a;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < tiles.length; i++) mask[i] = tiles[i] === T_SIDEWALK ? 1 : 0;
  // A park walk is pavement on purpose and touches no carriageway on purpose
  // (`generate.ts` is explicit that a `path` course is not a road and must
  // never be handed to a driver). The bake ships those courses, so the walks
  // can be subtracted instead of guessed at — which is the whole of this
  // signature's false-positive story: the one hit on the shipped city was the
  // footpath across Sunridge Park.
  const walk = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind !== 'path') continue;
    const r = c.width / 2 + 1.5;
    for (let s = 0; s + 1 < c.points.length; s++) {
      const [ax, ay] = c.points[s] as readonly [number, number];
      const [bx, by] = c.points[s + 1] as readonly [number, number];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let k = 0; k <= steps; k++) {
        const px = ax + ((bx - ax) * k) / steps;
        const py = ay + ((by - ay) * k) / steps;
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
            const tx = Math.round(px) + dx;
            const ty = Math.round(py) + dy;
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            if (dx * dx + dy * dy <= r * r) walk[ty * W + tx] = 1;
          }
        }
      }
    }
  }
  const out: Finding[] = [];
  for (const bag of components(mask, W, H)) {
    if (bag.length < 8) continue;
    let onWalk = 0;
    for (const i of bag) if (walk[i] === 1) onWalk++;
    if (onWalk / bag.length >= 0.5) continue;
    let touched = false;
    for (const i of bag) {
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1 && !touched; dy++) {
        for (let dx = -1; dx <= 1 && !touched; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (road[ny * W + nx] === 1) touched = true;
        }
      }
      if (touched) break;
    }
    if (touched) continue;
    const b = bbox(bag, W);
    const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(b.x1 - b.x0, b.y1 - b.y0) + 1, W, H);
    out.push({
      sig: 'walk-orphan',
      x: cx,
      y: cy,
      w: cw,
      severity: bag.length >= 40 ? 'med' : 'low',
      rank: bag.length,
      reason: `${bag.length} pavement tiles at ${b.x0},${b.y0} with no carriageway adjacent anywhere`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 6. kerb-missing — carriageway meeting a wall with no pavement       */
/* ------------------------------------------------------------------ */

/**
 * A stretch of carriageway that touches a building wall directly, in a city
 * where the pavement between the two is the rule.
 *
 * The rule is measured, not assumed: the run is only reported when the map as
 * a whole overwhelmingly puts a kerb between tarmac and wall, which is the
 * difference between "this borough has no pavements" (a fabric choice) and
 * "this building landed on the kerb" (a defect).
 */
function missingKerbs(a: Audit): { findings: Finding[]; kerbRate: number } {
  const { W, H, at, road } = a;
  let direct = 0;
  let viaKerb = 0;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (road[i] === 0) continue;
      let hitsWall = false;
      for (const [dx, dy] of DIRS) {
        const t = at(x + dx, y + dy);
        if (t === T_BUILDING) hitsWall = true;
        if (t === T_SIDEWALK) viaKerb++;
      }
      if (hitsWall) {
        direct++;
        mask[i] = 1;
      }
    }
  }
  const kerbRate = viaKerb / Math.max(1, viaKerb + direct);
  const out: Finding[] = [];
  if (kerbRate < 0.8) return { findings: out, kerbRate };
  for (const bag of components(mask, W, H)) {
    if (bag.length < 5) continue;
    const b = bbox(bag, W);
    const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(b.x1 - b.x0, b.y1 - b.y0) + 1, W, H);
    out.push({
      sig: 'kerb-missing',
      x: cx,
      y: cy,
      w: cw,
      severity: bag.length >= 12 ? 'med' : 'low',
      rank: bag.length,
      reason: `${bag.length} road tiles at ${b.x0},${b.y0} abut a building with no kerb, where ${(kerbRate * 100).toFixed(0)}% of the city's road-to-wall contact goes via pavement`,
    });
  }
  return { findings: out, kerbRate };
}

/* ------------------------------------------------------------------ */
/* 7. crossing-missing — the Hollis Creek generalisation               */
/* ------------------------------------------------------------------ */

interface Site {
  /** Water span, in tiles. */
  gap: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  vertical: boolean;
}

/**
 * Two banks a few tiles apart with no way across between them.
 *
 * The measurement that makes this a defect rather than a fact of geography is
 * the DETOUR: how far a car actually has to drive, over road and bridge, to
 * get from one side of the gap to the other. Hollis Creek is four tiles wide
 * and a hundred and twenty-four tiles of driving; that ratio is the signature,
 * and it is why a narrow creek scores worse than a wide river with a bridge
 * on it.
 *
 * Unreachable is reported as `detour=inf`, which is the same defect harder.
 */
function missingCrossings(a: Audit, maxGap: number): Finding[] {
  const { W, H, at, road } = a;

  // Candidate sites: a short span of water on a scanline with a road tile
  // within reach on both sides.
  const sites: Site[] = [];
  const REACH = 8;
  const scan = (vertical: boolean): void => {
    const outer = vertical ? W : H;
    const inner = vertical ? H : W;
    const tileAt = (u: number, v: number): number => (vertical ? at(u, v) : at(v, u));
    for (let u = 0; u < outer; u++) {
      let v = 0;
      while (v < inner) {
        if (tileAt(u, v) !== T_WATER) {
          v++;
          continue;
        }
        let e = v;
        while (e < inner && tileAt(u, e) === T_WATER) e++;
        const gap = e - v;
        if (gap >= 2 && gap <= maxGap) {
          // A BRIDGE on either bank of the span is not a bank at all: it is
          // the flank of a deck already crossing this water, and the strip of
          // open water beside a viaduct is what a viaduct is supposed to have
          // beside it. Four of this signature's ten hits on the shipped city
          // were the two parallel Kelvin decks reported as an uncrossed gap,
          // and one more was the Vasco deck. It is the single biggest source
          // of false positives here, so it is refused at the scanline.
          if (tileAt(u, v - 1) === T_BRIDGE || tileAt(u, e) === T_BRIDGE) {
            v = e;
            continue;
          }
          // Nearest carriageway on each side, over land, within reach.
          let av = -1;
          for (let k = 1; k <= REACH; k++) {
            const vv = v - k;
            if (vv < 0) break;
            const t = tileAt(u, vv);
            if (t === T_WATER || t === T_BRIDGE) break;
            if (isRoad(t)) {
              av = vv;
              break;
            }
          }
          let bv = -1;
          for (let k = 0; k < REACH; k++) {
            const vv = e + k;
            if (vv >= inner) break;
            const t = tileAt(u, vv);
            if (t === T_WATER || t === T_BRIDGE) break;
            if (isRoad(t)) {
              bv = vv;
              break;
            }
          }
          if (av >= 0 && bv >= 0) {
            sites.push(
              vertical
                ? { gap, ax: u, ay: av, bx: u, by: bv, vertical }
                : { gap, ax: av, ay: u, bx: bv, by: u, vertical },
            );
          }
        }
        v = e;
      }
    }
  };
  scan(true);
  scan(false);

  // Cluster: one creek crossing point should be one finding, not forty
  // scanlines of the same creek.
  const CLUSTER = 14;
  const kept: Site[] = [];
  for (const s of sites.sort((p, q) => p.gap - q.gap)) {
    const mx = (s.ax + s.bx) / 2;
    const my = (s.ay + s.by) / 2;
    let near = false;
    for (const k of kept) {
      const kx = (k.ax + k.bx) / 2;
      const ky = (k.ay + k.by) / 2;
      if (Math.abs(kx - mx) <= CLUSTER && Math.abs(ky - my) <= CLUSTER) {
        near = true;
        break;
      }
    }
    if (!near) kept.push(s);
  }

  // The detour, one BFS over the carriageway per surviving site.
  const dist = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  let stamp = 0;
  const stampOf = new Int32Array(W * H);
  const roadDist = (sx: number, sy: number, tx: number, ty: number): number => {
    stamp++;
    let head = 0;
    let tail = 0;
    const s = sy * W + sx;
    stampOf[s] = stamp;
    dist[s] = 0;
    queue[tail++] = s;
    const goal = ty * W + tx;
    while (head < tail) {
      const i = queue[head++] as number;
      if (i === goal) return dist[i] as number;
      const x = i % W;
      const y = (i - x) / W;
      const d = (dist[i] as number) + 1;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (stampOf[j] === stamp || road[j] === 0) continue;
        stampOf[j] = stamp;
        dist[j] = d;
        queue[tail++] = j;
      }
    }
    return -1;
  };

  const out: Finding[] = [];
  for (const s of kept) {
    const straight = Math.hypot(s.bx - s.ax, s.by - s.ay);
    const d = roadDist(s.ax, s.ay, s.bx, s.by);
    // A crossing that exists shows up as a short drive. Ten times the
    // straight line, or a hundred tiles, is the point at which "go round" is
    // a different journey rather than a slightly longer one.
    if (d >= 0 && d < Math.max(60, straight * 10)) continue;
    const ratio = d < 0 ? Infinity : d / Math.max(1, straight);
    const mx = (s.ax + s.bx) / 2;
    const my = (s.ay + s.by) / 2;
    const [cx, cy, cw] = crop(mx, my, Math.max(60, s.gap * 4), W, H);
    out.push({
      sig: 'crossing-missing',
      x: cx,
      y: cy,
      w: cw,
      severity: d < 0 || d > 240 ? 'high' : 'med',
      rank: d < 0 ? 1e9 : d,
      reason: `${s.gap}-tile water gap at ${Math.round(mx)},${Math.round(my)} between roads at ${s.ax},${s.ay} and ${s.bx},${s.by} — detour ${d < 0 ? 'inf' : d} road tiles (${ratio === Infinity ? 'inf' : ratio.toFixed(0)}x the straight line), no crossing`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 8. shore-staircase — the raster disagreeing with its own curve      */
/* ------------------------------------------------------------------ */

interface Seg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Segments of the authored rings, bucketed so a nearest query is cheap. */
function segIndex(
  rings: Array<{ points: Array<readonly [number, number]> }>,
  cell: number,
): { segs: Seg[]; grid: Map<number, number[]>; cell: number } {
  const segs: Seg[] = [];
  for (const r of rings) {
    const p = r.points;
    for (let i = 0; i < p.length; i++) {
      const a = p[i] as readonly [number, number];
      const b = p[(i + 1) % p.length] as readonly [number, number];
      segs.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
    }
  }
  const grid = new Map<number, number[]>();
  for (const [i, s] of segs.entries()) {
    const gx0 = Math.floor(Math.min(s.x0, s.x1) / cell);
    const gx1 = Math.floor(Math.max(s.x0, s.x1) / cell);
    const gy0 = Math.floor(Math.min(s.y0, s.y1) / cell);
    const gy1 = Math.floor(Math.max(s.y0, s.y1) / cell);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gy * 4096 + gx;
        const bag = grid.get(k);
        if (bag) bag.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  return { segs, grid, cell };
}

/**
 * How far the authored curve nearest this point is from an axis, in degrees.
 * `-1` when there is no curve within reach — a boundary the rings do not
 * describe, which this signature declines to judge.
 */
function curveOffAxis(idx: ReturnType<typeof segIndex>, x: number, y: number, reach: number): number {
  let best = reach * reach;
  let bestSeg: Seg | null = null;
  const g = Math.ceil(reach / idx.cell);
  const gx = Math.floor(x / idx.cell);
  const gy = Math.floor(y / idx.cell);
  for (let dy = -g; dy <= g; dy++) {
    for (let dx = -g; dx <= g; dx++) {
      const bag = idx.grid.get((gy + dy) * 4096 + gx + dx);
      if (!bag) continue;
      for (const i of bag) {
        const s = idx.segs[i] as Seg;
        const vx = s.x1 - s.x0;
        const vy = s.y1 - s.y0;
        const len2 = vx * vx + vy * vy;
        let t = len2 > 0 ? ((x - s.x0) * vx + (y - s.y0) * vy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = s.x0 + vx * t - x;
        const py = s.y0 + vy * t - y;
        const d2 = px * px + py * py;
        if (d2 < best) {
          best = d2;
          bestSeg = s;
        }
      }
    }
  }
  if (!bestSeg) return -1;
  // Bearing folded into 0..45: how far the curve is from the nearer axis.
  const ang = (Math.atan2(bestSeg.y1 - bestSeg.y0, bestSeg.x1 - bestSeg.x0) * 180) / Math.PI;
  const m = ((ang % 90) + 90) % 90;
  return Math.min(m, 90 - m);
}

/**
 * A long axis-aligned staircase tread on a boundary the bake says is a curve.
 *
 * This is the one signature that can tell deliberate squareness from an
 * artifact, and it does it by asking the CURVE rather than the tiles. §25 made
 * the coastline a shipped polyline of which the wet tiles are a rasterisation;
 * so a straight run of tile boundary is only a defect where the polyline under
 * it is NOT straight and NOT axis-aligned. A quay drawn square rasterises to a
 * straight run and its curve is straight too — no finding. A bay drawn at 30°
 * that rasterises to a fourteen-tile horizontal tread is the artifact.
 *
 * Both cuts of the shore band are asked (WORLDGEN.md §39): the waterline
 * against `shores`, and the band's inner edge against `banks`.
 *
 * The gate is a RATIO, not an angle, and getting that wrong is the difference
 * between this signature and nine false positives. A faithful rasterisation of
 * a line `theta` off the axis makes treads of about `1/tan(theta)` tiles — a
 * six-degree coast is SUPPOSED to produce ten-tile treads, and a flat "any
 * tread over eight tiles where the curve is off-axis" gate reports exactly
 * that correct behaviour as a bug. So the measure is `len * tan(theta)`: one
 * means the raster is tracking its curve, and two means the tread is twice as
 * long as the curve under it can account for.
 */
function shoreStaircase(a: Audit, minRun: number, minExcess: number): Finding[] {
  const { W, H, at, tiles, city } = a;
  const out: Finding[] = [];
  const shoreIdx = segIndex(city.shores, 16);
  const bankIdx = segIndex(city.banks, 16);

  // The two boundaries, as a predicate on an ordered pair of tile types.
  const cuts: Array<{ name: string; idx: typeof shoreIdx; inside: (t: number) => boolean; outside: (t: number) => boolean }> = [
    {
      name: 'waterline',
      idx: shoreIdx,
      inside: (t) => t === T_WATER,
      // Natural land only: a quay, a lot, a wharf or a runway is a BUILT edge
      // and WORLDGEN.md §15.4 says in as many words that it stays square.
      outside: (t) => t === T_SAND || t === T_FIELD || t === T_PARK,
    },
    {
      name: 'shore band',
      idx: bankIdx,
      inside: (t) => t === T_SAND,
      outside: (t) => t === T_FIELD || t === T_PARK || t === T_TREES,
    },
  ];

  for (const cut of cuts) {
    for (const vertical of [false, true]) {
      // Walk each line of the grid; a "tread" is a maximal run of tiles where
      // the boundary crosses the same edge in the same sense.
      const outer = vertical ? W : H;
      const inner = vertical ? H : W;
      const tileAt = (u: number, v: number): number => (vertical ? at(v, u) : at(u, v));
      // A tread runs ALONG u for a horizontal cut; the boundary edge is
      // between v and v+1.
      for (let v = 0; v + 1 < inner; v++) {
        let u = 0;
        while (u < outer) {
          const t0 = tileAt(u, v);
          const t1 = tileAt(u, v + 1);
          const fwd = cut.inside(t0) && cut.outside(t1);
          const bwd = cut.outside(t0) && cut.inside(t1);
          if (!fwd && !bwd) {
            u++;
            continue;
          }
          let e = u;
          while (e < outer) {
            const a0 = tileAt(e, v);
            const a1 = tileAt(e, v + 1);
            const f = cut.inside(a0) && cut.outside(a1);
            const b = cut.outside(a0) && cut.inside(a1);
            if (fwd ? !f : !b) break;
            e++;
          }
          const len = e - u;
          if (len >= minRun) {
            const mu = (u + e) / 2;
            const mx = vertical ? v + 0.5 : mu;
            const my = vertical ? mu : v + 0.5;
            const off = curveOffAxis(cut.idx, mx, my, 6);
            // No curve within reach: a boundary the bake does not describe,
            // which this signature declines to judge rather than guess at.
            const excess = off < 0 ? 0 : len * Math.tan((off * Math.PI) / 180);
            if (excess >= minExcess) {
              const landT = cut.inside(t0) ? tileAt(u, v + 1) : tileAt(u, v);
              const [cx, cy, cw] = crop(mx, my, len, W, H);
              out.push({
                sig: 'shore-staircase',
                x: cx,
                y: cy,
                w: cw,
                severity: excess >= minExcess * 2 ? 'high' : 'med',
                rank: excess,
                reason: `${len}-tile ${vertical ? 'vertical' : 'horizontal'} tread on the ${cut.name} at ${Math.round(mx)},${Math.round(my)} (land side ${tileName(landT)}) where the shipped curve runs ${off.toFixed(0)} deg off the axis — ${excess.toFixed(1)}x longer than that slope accounts for`,
              });
            }
          }
          u = e > u ? e : u + 1;
        }
      }
    }
  }
  void tiles;
  return out;
}

const TILE_NAMES = [
  'field',
  'road',
  'sidewalk',
  'building',
  'park',
  'lot',
  'water',
  'bridge',
  'ramp',
  'floor',
  'bank',
  'trees',
  'sand',
  'runway',
];
function tileName(t: number): string {
  return TILE_NAMES[t] ?? `t${t}`;
}

/* ------------------------------------------------------------------ */
/* 8b. built-staircase — the step a half-tile chamfer cannot reach     */
/* ------------------------------------------------------------------ */

/**
 * A BUILT edge running at a shallow angle, stepping every three or four tiles.
 *
 * `shore-staircase` above deliberately excuses built edges, because §15.4 says
 * in as many words that quays, lots and the cliff's convex headlands stay
 * square on purpose. That excuse is too broad, and the round-11 visual sweep
 * measured why: the bevel plane only removes a step whose TREAD IS ONE TILE,
 * because all it has to spend is a half-tile chamfer. A 45 degree edge steps
 * every tile and bevels perfectly; a fifteen-degree edge steps every four and
 * the bevels sit there doing nothing. South Sound Bridge is the case — its
 * deck starts at x = 160, 164, 167, 171, 175, 179, 182, 186, 190, 193, 197 on
 * rows 473..483, a three-to-four tile tread with twenty-two bevels in the box
 * that cannot touch it.
 *
 * So the question is not "is this edge square" but "how long is its tread, and
 * can a chamfer reach it". A deliberately straight quay is ONE tread and never
 * marches, and is refused here by the chain rule; a shallow diagonal is a
 * staircase of short treads all stepping the same way, and that is the whole
 * signature. It predicts the same defect at every shallow built/water and
 * built/field boundary, not only at bridges.
 *
 * **And then it has to ask whether the step is DRAWN.** The first cut of this
 * signature did not, and reported twenty-four places where twenty of them are
 * never seen. A tread is not a defect by being long: a faithful rasterisation
 * of a line `theta` off the axis has treads of about `1/tan(theta)`, and
 * measured across all twenty-four the tread was `1.00x` what the edge's own
 * angle accounts for — under the 1.7 the shipped coast reaches and well under
 * `shore-staircase`'s 2.0 gate. What separates a defect from a correct raster
 * here is the CURVE LAYER, exactly as it is one signature up: both shipped
 * painters repaint a tile the coast course runs through against the chord
 * (`paintShoreTile` -> `paintShoreMaterial`, which has a `T_BANK` case; the
 * 3D `shoreCut` prisms), so a step face with either of its two tiles on a
 * chain is never drawn at all. Measured on the shipped bake: 1,293 of 1,293
 * quay step faces dissolved, 0 of 466 bridge-deck ones — because a deck is
 * refused by name in all three painters ("the coast runs UNDER it", "a deck
 * is not ground at all") and no curve describes a deck's own outer edge.
 *
 * That is not gated on here, deliberately. Refusing the dissolved chains
 * lets a LANDWARD chain of the same quay through the one-edge-one-finding
 * dedup in their place — quay against pavement, against field — and those
 * are a different question this signature has not measured. So the fact is
 * REPORTED instead, per finding, and the reader can act on the ones whose
 * step faces are actually drawn.
 */
function builtStaircase(a: Audit, minSpan: number): Finding[] {
  const { W, H, tiles, at, city } = a;
  const out: Finding[] = [];
  // The coast course and the band's inner edge, per tile — the same
  // `shoreChains` both painters index, so this asks the question they answer.
  const coast = shoreChains(city.shores, W, H);
  const band = shoreChains(city.banks, W, H);
  const onCurve = (x: number, y: number): boolean => {
    const i = y * W + x;
    return coast.has(i) || band.has(i);
  };
  // Built surfaces whose OUTLINE is a drawn shape rather than a block edge.
  // Buildings and pavement are left out: the urban lattice is square by
  // design and every block corner would answer this question yes.
  const KINDS: Array<[number, string]> = [
    [T_BRIDGE, 'bridge deck'],
    [T_BANK, 'quay'],
    [T_LOT, 'yard'],
    [T_RUNWAY, 'runway'],
  ];
  for (const [kind, label] of KINDS) {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < tiles.length; i++) mask[i] = tiles[i] === kind ? 1 : 0;
    for (const bag of components(mask, W, H)) {
      if (bag.length < 60) continue;
      const b = bbox(bag, W);
      const inBag = new Set(bag);
      // The component's own outline, as a profile per column and per row.
      for (const byColumn of [true, false]) {
        const n = byColumn ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
        const m = byColumn ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
        if (n < minSpan) continue;
        for (const side of [0, 1]) {
          const prof = new Int32Array(n).fill(-1);
          for (let p = 0; p < n; p++) {
            for (let q = 0; q < m; q++) {
              const qq = side === 0 ? q : m - 1 - q;
              const x = byColumn ? b.x0 + p : b.x0 + qq;
              const y = byColumn ? b.y0 + qq : b.y0 + p;
              if (inBag.has(y * W + x)) {
                prof[p] = byColumn ? y : x;
                break;
              }
            }
          }
          // Treads: maximal runs of a constant profile value.
          const treads: Array<{ at: number, len: number, v: number }> = [];
          let p = 0;
          while (p < n) {
            if ((prof[p] as number) < 0) {
              p++;
              continue;
            }
            let e = p;
            while (e < n && prof[e] === prof[p]) e++;
            treads.push({ at: p, len: e - p, v: prof[p] as number });
            p = e;
          }
          // A chain of short treads all stepping the same way by one: the
          // shallow diagonal. A single long tread never enters a chain, which
          // is how a straight quay stays out of this.
          let i = 0;
          while (i < treads.length) {
            let j = i;
            let dir = 0;
            while (j + 1 < treads.length) {
              const t0 = treads[j] as { at: number; len: number; v: number };
              const t1 = treads[j + 1] as { at: number; len: number; v: number };
              if (t1.at !== t0.at + t0.len) break;
              if (t0.len < 2 || t0.len > 10 || t1.len < 2 || t1.len > 10) break;
              const step = t1.v - t0.v;
              if (Math.abs(step) !== 1) break;
              if (dir === 0) dir = step;
              else if (step !== dir) break;
              j++;
            }
            const first = treads[i] as { at: number; len: number; v: number };
            const last = treads[j] as { at: number; len: number; v: number };
            const span = last.at + last.len - first.at;
            const count = j - i + 1;
            if (count >= 4 && span >= minSpan) {
              // Is any of this staircase actually drawn? Each profile
              // position contributes a step face where the tile just outside
              // the outline is open water; the curve layer dissolves that
              // face if either of its two tiles is on a chain.
              let faces = 0;
              let dissolved = 0;
              for (let q = first.at; q < first.at + span; q++) {
                const v = prof[q] as number;
                if (v < 0) continue;
                const step = side === 0 ? -1 : 1;
                const x = byColumn ? b.x0 + q : v;
                const y = byColumn ? v : b.y0 + q;
                const ox = byColumn ? x : x + step;
                const oy = byColumn ? y + step : y;
                if (at(ox, oy) !== T_WATER) continue;
                faces++;
                if (onCurve(x, y) || onCurve(ox, oy)) dissolved++;
              }
              const meanTread = span / count;
              const midP = first.at + span / 2;
              const mx = byColumn ? b.x0 + midP : (first.v + last.v) / 2;
              const my = byColumn ? (first.v + last.v) / 2 : b.y0 + midP;
              const [cx, cy, cw] = crop(mx, my, span, W, H);
              out.push({
                sig: 'built-staircase',
                x: cx,
                y: cy,
                w: cw,
                severity: meanTread >= 3 ? 'high' : 'med',
                rank: span * meanTread,
                reason: `${label} edge at ${Math.round(mx)},${Math.round(my)} climbs ${count} treads averaging ${meanTread.toFixed(1)} tiles over ${span} tiles — a half-tile bevel only reaches a 1-tile tread. ${faces === 0 ? 'This edge faces dry ground, which no coast curve describes, so it is drawn as it lies' : dissolved === faces ? `All ${faces} of its step faces onto open water are dissolved by the coast curve, so NONE of this staircase is drawn` : `${faces - dissolved} of its ${faces} step faces onto open water have no coast curve over them and are drawn square`}`,
              });
            }
            i = j + 1;
          }
        }
      }
    }
  }
  // One edge, one finding. Scanning both profile sides and both orientations
  // of the same component reports the same staircase two or three times over,
  // a few tiles apart, and forty lines that are twenty places is a summary
  // count nobody can act on.
  out.sort((p, q) => q.rank - p.rank);
  const kept: Finding[] = [];
  for (const f of out) {
    if (kept.some((k) => Math.abs(k.x - f.x) <= 12 && Math.abs(k.y - f.y) <= 12)) continue;
    kept.push(f);
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* 8c. bare-corridor — the road that was deleted, in negative space    */
/* ------------------------------------------------------------------ */

/**
 * A long straight clearing through woodland with no road in it.
 *
 * Both of worldgen's road-REMOVAL passes (`layout.ts` ring shave and orphan
 * prune) write `T_FIELD` where the carriageway was. That restores the ground
 * but not the canopy the carve cleared, so what is left is a ruler-straight
 * corridor of meadow through a wood — and no road-shaped detector can see it,
 * because after the prune there is no road left to inspect. The evidence is
 * entirely in the negative space of a natural material. Gannet Rock, which the
 * plan calls deliberately trackless, ships a 5-6 tile corridor 46 tiles long.
 *
 * Straightness is the whole test: woodland has clearings, and a clearing is a
 * blob. A rectangle four times longer than it is wide, walled by trees, is a
 * road that was taken out.
 */
function bareCorridors(a: Audit, minLen: number): Finding[] {
  const { W, H, at } = a;
  const out: Finding[] = [];
  // NOT connected components, and that was this signature's first and only
  // false negative: on Gannet Rock the corridor runs OUT of the wood into the
  // open ground round the airstrip, so it is one lobe of a field component
  // covering half the island and its bounding box says nothing. What defines a
  // cut is local — a short span of meadow with woodland hard against BOTH
  // flanks — so the scan is per-line, and the corridor is what those spans
  // make when they stack up straight.
  const scan = (vertical: boolean): void => {
    const outer = vertical ? W : H;
    const inner = vertical ? H : W;
    const tileAt = (u: number, v: number): number => (vertical ? at(v, u) : at(u, v));
    // Cut spans per line, as [start, end) along u.
    const spans: Array<Array<[number, number]>> = [];
    for (let v = 0; v < inner; v++) {
      const row: Array<[number, number]> = [];
      let u = 0;
      while (u < outer) {
        if (tileAt(u, v) !== T_FIELD) {
          u++;
          continue;
        }
        let e = u;
        while (e < outer && tileAt(e, v) === T_FIELD) e++;
        const wSpan = e - u;
        if (wSpan >= 2 && wSpan <= 10 && tileAt(u - 1, v) === T_TREES && tileAt(e, v) === T_TREES) {
          row.push([u, e]);
        }
        u = e;
      }
      spans.push(row);
    }
    const used = spans.map((r) => new Uint8Array(r.length));
    for (let v = 0; v < inner; v++) {
      const row = spans[v] as Array<[number, number]>;
      for (const [si, s] of row.entries()) {
        if ((used[v] as Uint8Array)[si] === 1) continue;
        let u0 = s[0];
        let u1 = s[1];
        let lo = s[0];
        let hi = s[1];
        let end = v;
        for (let vv = v + 1; vv < inner; vv++) {
          const next = spans[vv] as Array<[number, number]>;
          let found = -1;
          for (const [ni, n] of next.entries()) {
            // The same corridor one line on: overlapping, and its edges have
            // not wandered. A wandering gap between two woods is a glade.
            if (n[0] < u1 && n[1] > u0 && Math.abs(n[0] - u0) <= 2 && Math.abs(n[1] - u1) <= 2) {
              found = ni;
              break;
            }
          }
          if (found < 0) break;
          const n = next[found] as [number, number];
          (used[vv] as Uint8Array)[found] = 1;
          u0 = n[0];
          u1 = n[1];
          lo = Math.min(lo, n[0]);
          hi = Math.max(hi, n[1]);
          end = vv;
        }
        const len = end - v + 1;
        if (len < minLen) continue;
        if (hi - lo > 10) continue;
        const wSpan = hi - lo;
        const x0 = vertical ? v : lo;
        const y0 = vertical ? lo : v;
        const [cx, cy, cw] = crop(
          vertical ? v + len / 2 : (lo + hi) / 2,
          vertical ? (lo + hi) / 2 : v + len / 2,
          len,
          W,
          H,
        );
        out.push({
          sig: 'bare-corridor',
          x: cx,
          y: cy,
          w: cw,
          severity: len >= minLen * 1.5 ? 'high' : 'med',
          rank: len * wSpan,
          reason: `${wSpan}-tile-wide straight clearing at ${x0},${y0} running ${len} tiles ${vertical ? 'east-west' : 'north-south'} with woodland hard against both flanks and no carriageway in it — the shape of a road a removal pass took out without putting the canopy back`,
        });
      }
    }
  };
  scan(false);
  scan(true);
  return out;
}

/* ------------------------------------------------------------------ */
/* 9. patch-square — a rectangle of ground nobody drew                 */
/* ------------------------------------------------------------------ */

/**
 * A patch of one natural material that is EXACTLY its own bounding box, at
 * least three tiles on a side, surrounded by one other material. Woodland,
 * meadow and beach are fields; a field does not produce a perfect rectangle,
 * so one on the map is a stamp rather than a shape.
 *
 * Built materials are excluded outright — a rectangle of building inside
 * pavement is the city, not a defect.
 */
function squarePatches(a: Audit): Finding[] {
  const { W, H, at, tiles } = a;
  const out: Finding[] = [];
  for (const kind of [T_TREES, T_PARK, T_SAND, T_WATER, T_FIELD]) {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < tiles.length; i++) mask[i] = tiles[i] === kind ? 1 : 0;
    for (const bag of components(mask, W, H)) {
      const b = bbox(bag, W);
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      if (w < 3 || h < 3) continue;
      if (w > 40 || h > 40) continue;
      if (bag.length !== w * h) continue; // not a filled rectangle
      // What it sits in: the ring one tile out.
      const ring = new Map<number, number>();
      for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
        for (const y of [b.y0 - 1, b.y1 + 1]) ring.set(at(x, y), (ring.get(at(x, y)) ?? 0) + 1);
      }
      for (let y = b.y0; y <= b.y1; y++) {
        for (const x of [b.x0 - 1, b.x1 + 1]) ring.set(at(x, y), (ring.get(at(x, y)) ?? 0) + 1);
      }
      let host = -1;
      let hostN = 0;
      let total = 0;
      for (const [t, n] of ring) {
        total += n;
        if (n > hostN) {
          hostN = n;
          host = t;
        }
      }
      if (host < 0 || hostN / total < 0.9) continue;
      if (!isNatural(host)) continue;
      const [cx, cy, cw] = crop((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(w, h), W, H);
      out.push({
        sig: 'patch-square',
        x: cx,
        y: cy,
        w: cw,
        severity: w >= 5 && h >= 5 ? 'med' : 'low',
        rank: w * h,
        reason: `perfect ${w}x${h} rectangle of ${tileName(kind)} at ${b.x0},${b.y0} embedded in ${tileName(host)}`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 10. edge-notch — one-tile pimples on a natural boundary             */
/* ------------------------------------------------------------------ */

/**
 * A single tile of one material poking out of, or bitten out of, a boundary
 * between two natural materials. Confetti: the thing §25's despeckle passes
 * used to clean up off the raster before the coast became a curve.
 *
 * Asked only where WATER is one of the two materials, and that restriction was
 * bought with 482 false positives. Run over every natural boundary it fires on
 * the tree line, where a lone tree in a meadow and a lone clearing in a wood
 * are the texture of the countryside and not defects at all — a crop of any of
 * them shows scattered trees, which is what scattered trees look like. A speck
 * of water in a field, or of land in the sea, is different in kind: it is the
 * confetti §25's despeckle passes existed to remove, and the reason they could
 * be deleted was that the coast stopped producing it.
 */
function edgeNotches(a: Audit): Finding[] {
  const { W, H, at, tiles } = a;
  const out: Finding[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const t = tiles[y * W + x] as number;
      if (!isNatural(t)) continue;
      if (t !== T_WATER && !DIRS.some(([dx, dy]) => at(x + dx, y + dy) === T_WATER)) continue;
      const n = DIRS.map(([dx, dy]) => at(x + dx, y + dy));
      const other = n.filter((u) => u !== t);
      if (other.length < 3) continue;
      const u = other[0] as number;
      if (!other.every((v) => v === u)) continue;
      if (!isNatural(u)) continue;
      const [cx, cy, cw] = crop(x, y, 1, W, H);
      out.push({
        sig: 'edge-notch',
        x: cx,
        y: cy,
        w: cw,
        severity: 'low',
        rank: other.length,
        reason: `single ${tileName(t)} tile at ${x},${y} surrounded on ${other.length} sides by ${tileName(u)}`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 11. fabric-coarse — the Docks generalisation                        */
/* ------------------------------------------------------------------ */

/**
 * Which borough owns each tile, the way `mapgen --stats` computes it:
 * point-in-polygon at tile centres, later polygons winning, then a flood over
 * land so the warp fringe reads as part of the borough it hangs off.
 */
function ownerPlane(plan: CityPlan, tiles: Uint8Array, W: number, H: number): Int16Array {
  const owner = new Int16Array(W * H).fill(-1);
  for (const [di, d] of plan.districts.entries()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of d.area) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
      for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
      }
    }
  }
  const bag: number[] = [];
  for (let i = 0; i < owner.length; i++) {
    if ((owner[i] as number) >= 0 && tiles[i] !== T_WATER) bag.push(i);
  }
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q] as number;
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (tiles[j] === T_WATER || (owner[j] as number) >= 0) continue;
      owner[j] = owner[i] as number;
      bag.push(j);
    }
  }
  return owner;
}

/**
 * A borough whose blocks are far bigger than the street pitch its author
 * wrote down.
 *
 * `street.pitchX x pitchY` in the plan IS the authored cell: it is how far
 * apart the streets are meant to be. A borough whose median block is several
 * times that has streets the layout never carved, and from above it reads as
 * a slab where the rest of the city reads as a fabric. The Docks at `1469611`
 * — twelve blocks, median 1691 against a 28x24 = 672 cell — is the case this
 * generalises.
 */
function coarseFabric(city: BakedCity, plan: CityPlan, ratioGate: number): Finding[] {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const owner = ownerPlane(plan, city.tiles, W, H);
  const areas: number[][] = plan.districts.map(() => []);
  for (const b of city.blocks) {
    const cx = Math.min(W - 1, Math.max(0, Math.floor(b.x + b.w / 2)));
    const cy = Math.min(H - 1, Math.max(0, Math.floor(b.y + b.h / 2)));
    const own = owner[cy * W + cx] as number;
    if (own < 0) continue;
    (areas[own] as number[]).push(b.w * b.h);
  }
  const out: Finding[] = [];
  for (const [di, d] of plan.districts.entries()) {
    const cell = d.street.pitchX * d.street.pitchY;
    // A park has no street pitch and no blocks to compare; nor does a borough
    // with too few blocks for a median to mean anything.
    if (cell <= 0) continue;
    const list = (areas[di] as number[]).slice().sort((p, q) => p - q);
    if (list.length < 4) continue;
    const med = list[Math.floor(list.length / 2)] as number;
    const ratio = med / cell;
    if (ratio < ratioGate) continue;
    // Where the borough is, for the crop.
    let sx = 0;
    let sy = 0;
    for (const [px, py] of d.area) {
      sx += px;
      sy += py;
    }
    const cxT = sx / d.area.length;
    const cyT = sy / d.area.length;
    const [cx, cy, cw] = crop(cxT, cyT, 160, W, H);
    out.push({
      sig: 'fabric-coarse',
      x: cx,
      y: cy,
      w: cw,
      severity: ratio >= ratioGate * 1.5 ? 'high' : 'med',
      rank: ratio,
      reason: `${d.name}: ${list.length} blocks, median ${med} tiles against an authored ${d.street.pitchX}x${d.street.pitchY} = ${cell} cell (${ratio.toFixed(1)}x) — cross streets the fabric implies were never carved`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 12. course-coverage-outlier — the boroughs the vector work skipped  */
/* ------------------------------------------------------------------ */

/**
 * Which carriageway tiles lie UNDER a road course, by the renderer's own
 * rule.
 *
 * Not a re-derivation: this is `TileLayer.indexCourses`' `courseCover`
 * (`client/src/render/tiles.ts`) — the tile centre within `width / 2 + 0.05`
 * of a non-`path` centreline — copied because the question this signature
 * asks is exactly the question the client asks per tile, and an audit that
 * used its own definition would be measuring something the game does not do.
 * §26.1 measures the same thing city-wide and reported 76.1%; that figure is
 * stale, and the current reading is **85.3%** (WORLDGEN.md §44).
 */
function courseCoverPlane(city: BakedCity): Uint8Array {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const cover = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind === 'path') continue;
    const inner = c.width / 2 + 0.05;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k] as readonly [number, number];
      const [bx, by] = c.points[k + 1] as readonly [number, number];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - inner - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + inner + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - inner - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + inner + 1));
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const px = tx + 0.5 - ax;
          const py = ty + 0.5 - ay;
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
          const qx = px - t * dx;
          const qy = py - t * dy;
          if (qx * qx + qy * qy <= inner * inner) cover[ty * W + tx] = 1;
        }
      }
    }
  }
  return cover;
}

/** A borough big enough for a coverage rate to mean anything. */
const COVERAGE_MIN_ROAD = 500;

/**
 * A borough whose streets were never given centrelines, when the rest of the
 * city's were.
 *
 * §26.1 reports course coverage as ONE number for the whole city — 76.1% —
 * and explains the missing quarter as "junction box and merged sheet, which
 * SHOULD be bare". The average hides the shape of it: coverage is not spread
 * thin over the city, it is missing in lumps. Measured per borough on the bake
 * this signature was written against, twelve were between 69% and 91% and two
 * were at 20% and 29%.
 *
 * **Both of those numbers have since moved.** Iteration 4 gave the axis-grid
 * boroughs the centrelines they had been carving without recording, and on the
 * shipped bake the fourteen rated boroughs run 70.0% to 91.6% with an 85.6%
 * median — city-wide 85.3%, not 76.1% (WORLDGEN.md §44). The two lumps are
 * gone and this signature now fires nothing, WITHOUT its gate being touched:
 * the relative gate below working as specified, not a silenced check.
 *
 * **What that costs, and what it does NOT cost.** Every wave from §16 to §42
 * — the kerb casing, the junction punch-out, the ribbon lane markings, the
 * course follower, the diagonal kerb bevel — is keyed on `courses`, so all of
 * it skips a borough with no courses in it. But the tarmac is NOT left bare:
 * `paintRoad` falls through to `paintLaneMarks` for any tile the cover mask
 * misses (`client/src/render/tiles.ts:1962`), which is the whole reason §26.1
 * could not delete the per-tile marking system. **So this signature is about
 * missing COURSES, never about missing paint**, and a reviewer who crops one
 * of these and sees painted lanes has confirmed the finding, not refuted it.
 *
 * The gate is relative on purpose — a fraction of the MEDIAN borough's rate,
 * not an absolute percentage — so it says "these two are unlike the rest of
 * the city" rather than picking a number, and so it goes quiet by itself when
 * a rebake raises coverage everywhere. The median rather than the mean
 * because one wrecked borough must not move the bar that catches it.
 */
function coverageOutliers(city: BakedCity, plan: CityPlan, ratioGate: number): Finding[] {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const owner = ownerPlane(plan, city.tiles, W, H);
  const cover = courseCoverPlane(city);
  const n = plan.districts.length;
  const road = new Int32Array(n);
  const covered = new Int32Array(n);
  const courses = new Int32Array(n);
  for (let i = 0; i < city.tiles.length; i++) {
    if (!isRoad(city.tiles[i] as number)) continue;
    const d = owner[i] as number;
    if (d < 0) continue;
    road[d] = (road[d] as number) + 1;
    if (cover[i] === 1) covered[d] = (covered[d] as number) + 1;
  }
  for (const c of city.courses) {
    if (c.kind === 'path') continue;
    const [mx, my] = c.points[Math.floor(c.points.length / 2)] as readonly [number, number];
    const tx = Math.min(W - 1, Math.max(0, Math.floor(mx)));
    const ty = Math.min(H - 1, Math.max(0, Math.floor(my)));
    const d = owner[ty * W + tx] as number;
    if (d >= 0) courses[d] = (courses[d] as number) + 1;
  }
  const rated: number[] = [];
  for (let d = 0; d < n; d++) {
    if ((road[d] as number) < COVERAGE_MIN_ROAD) continue;
    rated.push((covered[d] as number) / (road[d] as number));
  }
  if (rated.length < 4) return [];
  const sorted = rated.slice().sort((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const gate = median * ratioGate;
  const out: Finding[] = [];
  for (const [di, d] of plan.districts.entries()) {
    const r = road[di] as number;
    if (r < COVERAGE_MIN_ROAD) continue;
    const rate = (covered[di] as number) / r;
    if (rate >= gate) continue;
    let sx = 0;
    let sy = 0;
    for (const [px, py] of d.area) {
      sx += px;
      sy += py;
    }
    const [cx, cy, cw] = crop(sx / d.area.length, sy / d.area.length, 160, W, H);
    out.push({
      sig: 'course-coverage-outlier',
      x: cx,
      y: cy,
      w: cw,
      severity: rate < gate / 2 ? 'high' : 'med',
      rank: r - (covered[di] as number),
      reason: `${d.name}: ${(100 * rate).toFixed(1)}% of ${r} carriageway tiles lie under a course (${courses[di]} courses), against a ${(100 * median).toFixed(1)}% median borough — ${r - (covered[di] as number)} tiles that the kerb casing, the junction punch-out, the ribbon markings, the follower and the kerb bevel all skip, because every one of them is keyed on courses. Missing COURSES, not missing paint: bare tarmac still gets per-tile lane marks`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 13. street-serves-nothing — a course with nowhere at either end     */
/* ------------------------------------------------------------------ */

/** Length of a course in tiles. */
function courseLength(c: StreetCourse): number {
  let len = 0;
  for (let k = 1; k < c.points.length; k++) {
    const [ax, ay] = c.points[k - 1] as readonly [number, number];
    const [bx, by] = c.points[k] as readonly [number, number];
    len += Math.hypot(bx - ax, by - ay);
  }
  return len;
}

/** Distance from a point to a course's polyline, in tiles. */
function distToCourse(c: StreetCourse, x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k + 1 < c.points.length; k++) {
    const [ax, ay] = c.points[k] as readonly [number, number];
    const [bx, by] = c.points[k + 1] as readonly [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x;
    const py = ay + dy * t - y;
    const d = Math.hypot(px, py);
    if (d < best) best = d;
  }
  return best;
}

/**
 * How much tarmac lies beyond an endpoint, marching out along the street's
 * own direction and sampling the FULL carriageway width at each step.
 *
 * The width matters: a single ray down a 3-wide street that runs a few
 * degrees off the axis walks out of its own road within four tiles and
 * reports a cap that is not there. That mistake alone accounted for four of
 * this signature's first sixteen candidates.
 */
function tarmacBeyond(
  a: Audit,
  x: number,
  y: number,
  dx: number,
  dy: number,
  half: number,
  limit: number,
): number {
  const px = -dy;
  const py = dx;
  const steps = Math.max(1, Math.round(half * 2));
  for (let s = 1; s <= limit + 1; s++) {
    let any = false;
    for (let k = 0; k <= steps && !any; k++) {
      const off = -half + (k * half * 2) / steps;
      if (isRoad(a.at(Math.floor(x + dx * s + px * off), Math.floor(y + dy * s + py * off)))) {
        any = true;
      }
    }
    if (!any) return s - 1;
  }
  return Infinity;
}

/**
 * A short street whose course meets no other course at EITHER end, and whose
 * tarmac stops at both ends too.
 *
 * The point of this one is that connectivity cannot see it. The shipped
 * carriageway is a single 4-connected component of about 100,000 tiles, so
 * `checkCity` is satisfied by a street that is reachable; degree is a
 * different question, and a street whose both ends are terminal is a street
 * with nowhere to go. The control is the islet in the strait at 468-471 x
 * 357-374 — a fully painted 11.7-tile street with a cap at each end, entered
 * only by leaving Kelvin Bridge sideways at mid-span.
 *
 * `noisy`, and measured: of the four candidates on the shipped bake, one is
 * the islet, one is the tip of the spit at 80,505, and two (669,153 and
 * 711,282) are coast roads whose course was trimmed at the waterline while
 * the tarmac carries on around the bend — the course ends, the street does
 * not. Half is not a rate a reviewer should trust, so the caveat travels in
 * the output rather than in this comment.
 */
function streetsServingNothing(
  a: Audit,
  city: BakedCity,
  maxLen: number,
  capReach: number,
): Finding[] {
  const roads = city.courses.filter((c) => c.kind !== 'path');
  /** How near another centreline has to come to count as meeting this end. */
  const MEET = 2;
  const out: Finding[] = [];
  for (const [i, c] of roads.entries()) {
    const len = courseLength(c);
    if (len < 4 || len >= maxLen) continue;
    const p0 = c.points[0] as readonly [number, number];
    const p1 = c.points[1] as readonly [number, number];
    const q1 = c.points[c.points.length - 1] as readonly [number, number];
    const q0 = c.points[c.points.length - 2] as readonly [number, number];
    const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
    const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
    const met = (x: number, y: number): boolean =>
      roads.some((o, j) => j !== i && distToCourse(o, x, y) <= MEET);
    if (met(p0[0], p0[1]) || met(q1[0], q1[1])) continue;
    const half = c.width / 2;
    const b0 = tarmacBeyond(a, p0[0], p0[1], (p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0, half, capReach);
    const b1 = tarmacBeyond(a, q1[0], q1[1], (q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1, half, capReach);
    if (b0 > capReach || b1 > capReach) continue;
    const [cx, cy, cw] = crop((p0[0] + q1[0]) / 2, (p0[1] + q1[1]) / 2, Math.ceil(len), a.W, a.H);
    out.push({
      sig: 'street-serves-nothing',
      x: cx,
      y: cy,
      w: cw,
      severity: b0 + b1 <= 2 ? 'med' : 'low',
      rank: 40 - len,
      reason: `${len.toFixed(1)}-tile ${c.kind} from ${p0[0].toFixed(0)},${p0[1].toFixed(0)} to ${q1[0].toFixed(0)},${q1[1].toFixed(0)} meets no other centreline at either end, and its tarmac stops ${b0} and ${b1} tile(s) past them — a street whose both ends are terminal. Connectivity cannot see it: the carriageway is one component, so this IS reachable`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 14. lanes-serving-nothing — ground no borough claimed               */
/* ------------------------------------------------------------------ */

/** Tiles inside some district polygon — point-in-polygon only, no flood. */
function polyMask(plan: CityPlan, W: number, H: number): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (const d of plan.districts) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of d.area) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
      for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
        const i = ty * W + tx;
        if (mask[i] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) mask[i] = 1;
      }
    }
  }
  return mask;
}

/** A stretch of land outside every district polygon, and what is on it. */
interface Fringe {
  land: number;
  road: number;
  built: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The land regions no district polygon claims, so both this signature and its
 * control speak about the same regions.
 */
function fringeRegions(a: Audit, plan: CityPlan): Fringe[] {
  const { W, H, tiles } = a;
  const inPoly = polyMask(plan, W, H);
  const seen = new Uint8Array(W * H);
  const out: Fringe[] = [];
  const bag = new Int32Array(W * H);
  for (let s = 0; s < tiles.length; s++) {
    if (seen[s] === 1 || inPoly[s] === 1 || tiles[s] === T_WATER) continue;
    let tail = 0;
    bag[tail++] = s;
    seen[s] = 1;
    const f: Fringe = { land: 0, road: 0, built: 0, x0: W, y0: H, x1: -1, y1: -1 };
    for (let q = 0; q < tail; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      f.land++;
      if (x < f.x0) f.x0 = x;
      if (y < f.y0) f.y0 = y;
      if (x > f.x1) f.x1 = x;
      if (y > f.y1) f.y1 = y;
      const t = tiles[i] as number;
      if (isRoad(t)) f.road++;
      if (t === T_BUILDING || t === T_FLOOR) f.built++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || inPoly[j] === 1 || tiles[j] === T_WATER) continue;
        seen[j] = 1;
        bag[tail++] = j;
      }
    }
    out.push(f);
  }
  return out;
}

/**
 * Ground that got a road network and nothing to drive to.
 *
 * The fringe pass places buildings only "within its own district's pitch of
 * town" (WORLDGEN.md §14.6 D5), but the road carve has no such rule, so land
 * that falls outside every district polygon can be laid with lanes and then
 * left empty. On the shipped bake 6,127 carriageway tiles are outside every
 * polygon; most of them are the warp fringe hanging off a borough, with that
 * borough's buildings a few tiles away, and those are not this finding.
 *
 * This one is the regions where there is nothing on either side: the headland
 * north of Kelvin Bridge, 5,749 tiles of land carrying 1,197 tiles of
 * carriageway and not one building — ground every player crosses between the
 * two halves of the city.
 *
 * The gates are what looking at the crops forced. The land floor throws out
 * the arterial corridors that run BETWEEN two polygons — a 103x7 strip at
 * 77,247 is 96% road with no buildings on it, and every one of them belongs
 * to the boroughs on either side. The building floor is what separates empty
 * ground from a fringe that is doing its job.
 */
function lanesServingNothing(
  a: Audit,
  plan: CityPlan,
  minLand: number,
  minRoadShare: number,
): Finding[] {
  /** Above this share of built tiles, the lanes have something to serve. */
  const BUILT_SHARE = 0.01;
  const out: Finding[] = [];
  for (const f of fringeRegions(a, plan)) {
    if (f.land < minLand) continue;
    const roadShare = f.road / f.land;
    if (roadShare < minRoadShare) continue;
    if (f.built / f.land >= BUILT_SHARE) continue;
    const span = Math.max(f.x1 - f.x0 + 1, f.y1 - f.y0 + 1);
    const [cx, cy, cw] = crop((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, span, a.W, a.H);
    out.push({
      sig: 'lanes-serving-nothing',
      x: cx,
      y: cy,
      w: cw,
      severity: f.built === 0 ? 'high' : 'med',
      rank: f.road,
      reason: `${f.x0},${f.y0}-${f.x1},${f.y1}: ${f.land} tiles of land outside every district polygon carry ${f.road} carriageway tiles (${(100 * roadShare).toFixed(1)}%) and ${f.built} built tiles — lanes with nothing to drive to, because the fringe pass only places buildings within a district's own pitch of town (§14.6 D5) and this ground is in no district`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 15. country-outside-blocks — ground nobody asked what it was        */
/* ------------------------------------------------------------------ */

/** Country: the two materials the rural fill chooses between. */
function isCountry(t: number): boolean {
  return t === T_FIELD || t === T_TREES;
}

/** How near a block has to come to count as this region's neighbour. */
const NEIGHBOUR_REACH = 3;
/** Country inside the neighbouring blocks below which the comparison is noise. */
const NEIGHBOUR_MIN_COUNTRY = 200;
/** Wood inside them below which there is no wood to be missing. */
const NEIGHBOUR_MIN_WOOD = 0.2;

interface Orphan {
  land: number;
  wood: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Country tiles inside the rural blocks that touch this region, and their wood. */
  nbLand: number;
  nbWood: number;
  nbBlocks: number;
  district: number;
  /**
   * The region's own tile indices. Carried because the selftest plant edits
   * the two sides of the ratio in opposite directions and has to hit EXACTLY
   * this region on one of them: a region's bounding box overlaps the blocks it
   * is measured against, so working from the box would move the comparator
   * with it and the control would stay silent for the wrong reason.
   */
  bag: number[];
  /** Indices into `city.blocks` of the rural blocks the ratio compares against. */
  nb: number[];
}

/**
 * Country outside every block, and the wood in the blocks beside it.
 *
 * The rural fill runs over BLOCKS — `fillBlock` visits `layout.blocks` and
 * nothing else — and the blocks are cut round the street lattice inside the
 * borough's own polygon. So ground that no block covers was never asked what
 * it is, and it keeps the bare meadow the ground pass wrote. Two things put
 * country outside a block: a removal deleting road after the blocks are cut,
 * and a coastline the district polygon does not reach.
 *
 * Both are read here the same way, because from above they are the same
 * thing: a patch of open country that is bald where the country next to it is
 * wooded.
 */
function orphanCountry(a: Audit, plan: CityPlan): Orphan[] {
  const { W, H, tiles } = a;
  const owner = ownerPlane(plan, tiles, W, H);
  // Rural boroughs only, on both sides of the comparison. The fill's own rule
  // is a rural rule (`fillBlock` takes the wildness field only for a rural
  // block), and a park is AUTHORED planting — comparing the grass verge north
  // of the coast road against Ravenhill Park's 82% canopy says nothing about
  // a defect, it says one of them is a park.
  const ruralTile = (i: number): boolean => {
    const d = owner[i] as number;
    return d >= 0 && (plan.districts[d] as { rural?: boolean }).rural === true;
  };
  const covered = new Uint8Array(W * H);
  const ruralBlock = new Int16Array(W * H).fill(-1);
  for (const [bi, b] of a.city.blocks.entries()) {
    for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
        covered[y * W + x] = 1;
        if (b.rural === true) ruralBlock[y * W + x] = bi;
      }
    }
  }
  const open = (i: number): boolean =>
    covered[i] === 0 && isCountry(tiles[i] as number) && ruralTile(i);
  const seen = new Uint8Array(W * H);
  const bag = new Int32Array(W * H);
  const out: Orphan[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] === 1 || !open(s)) continue;
    let tail = 0;
    bag[tail++] = s;
    seen[s] = 1;
    const f: Orphan = {
      land: 0,
      wood: 0,
      x0: W,
      y0: H,
      x1: -1,
      y1: -1,
      nbLand: 0,
      nbWood: 0,
      nbBlocks: 0,
      district: owner[s] as number,
      bag: [],
      nb: [],
    };
    for (let q = 0; q < tail; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      f.land++;
      f.bag.push(i);
      if (tiles[i] === T_TREES) f.wood++;
      if (x < f.x0) f.x0 = x;
      if (y < f.y0) f.y0 = y;
      if (x > f.x1) f.x1 = x;
      if (y > f.y1) f.y1 = y;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || !open(j)) continue;
        seen[j] = 1;
        bag[tail++] = j;
      }
    }
    // The blocks NEXT DOOR, not the blocks nearby: a rural block with a tile
    // within three of a tile of this region. A bounding-box radius instead
    // reaches across the strait and hands an islet the mainland's canopy for
    // a comparator, which is the wrong question asked of the right region.
    const near = new Set<number>();
    for (let q = 0; q < tail; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -NEIGHBOUR_REACH; dy <= NEIGHBOUR_REACH; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -NEIGHBOUR_REACH; dx <= NEIGHBOUR_REACH; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const bi = ruralBlock[ny * W + nx] as number;
          if (bi >= 0) near.add(bi);
        }
      }
    }
    for (const bi of near) {
      const b = a.city.blocks[bi] as (typeof a.city.blocks)[number];
      for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
        for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
          const t = tiles[y * W + x] as number;
          if (!isCountry(t)) continue;
          f.nbLand++;
          if (t === T_TREES) f.nbWood++;
        }
      }
    }
    f.nbBlocks = near.size;
    f.nb = [...near];
    out.push(f);
  }
  return out;
}

/**
 * A stretch of open country that no block covers and that is bald, against
 * wooded country in the blocks beside it.
 *
 * This is the signature the iteration-3 fix had no instrument for, and the
 * reason that round scored 47 before and 47 after while moving two thousand
 * tiles of map. Before it, Gannet Rock's northern third — 3,019 tiles the
 * district polygon never reached — shipped as unbroken meadow with the canopy
 * starting on a dead straight line at y=600, where the block grid begins; and
 * Marsh End shipped 3,881 tiles of country outside its blocks with NOT ONE
 * TREE in them against 41.5% wood in the country inside. Neither is a mark on
 * the raster that any of the fourteen raster signatures can see: the ground is
 * perfectly good meadow, and what is wrong with it is only visible against
 * the ground next door.
 *
 * **RATIO, not a percentage.** How much wood this city has is a tuning
 * decision — the wildness field's threshold is one number in `bake.ts` — and a
 * signature that named an absolute canopy share would fire across the whole
 * countryside the first time somebody moved it. What cannot be retuned away
 * is the DISAGREEMENT: the fill answers one question, so ground it visited and
 * ground it did not must answer the same. The gate is a fraction of the wood
 * inside the neighbouring blocks, and it goes quiet by itself when the two
 * sides agree, whatever they agree on.
 *
 * Rural boroughs on both sides of the comparison, and the neighbours have to
 * carry real country and real wood — otherwise the comparator is a park, a
 * yard, or forty tiles of verge, and the ratio is arithmetic on noise. That
 * last gate is not fastidiousness: without it the coast strip at 431,13 fires
 * on BOTH the fixed and the unfixed asset, because its comparator is
 * Ravenhill Park's 82% authored canopy and a grass verge between a coast road
 * and a park is not a defect.
 *
 * **Its one hit on the shipped bake is a false positive, and a measured one.**
 * The 507-tile marsh islet at 322,740 is meadow throughout against a rural
 * block next to it that is 50.8% wood — but `bake.ts`'s own wildness field
 * (`fbm(WILD_SEED, x/22, y/22) >= 0.52`) says meadow on ALL 507 of those
 * tiles, so the fill declined on purpose rather than never being asked.
 * Nothing a raster audit can see distinguishes those two, which is the honest
 * limit of this signature: it finds ground the fill never visited and ground
 * the fill visited and left alone, and only the field can tell them apart.
 * `evidence/iter4-detect/measure-wildness-field.mjs` asks it. Four hits on the
 * pre-fix asset at `e3306c8~2`, one here, and that one accounted for.
 *
 * The gate has room. Gannet Rock's north reads 0.35 before the fix and 0.67
 * after, so anything from 0.36 to 0.66 gives the same two answers — swept with
 * `--orphanwood=`: 0.3 gives 3 before / 1 after, 0.4 gives 4 / 1, 0.7 gives
 * 4 / 3. 0.4 is the middle of the flat part rather than an edge of it.
 */
function baldCountry(a: Audit, plan: CityPlan, minLand: number, ratioGate: number): Finding[] {
  const out: Finding[] = [];
  for (const f of orphanCountry(a, plan)) {
    if (f.land < minLand) continue;
    if (f.nbLand < NEIGHBOUR_MIN_COUNTRY) continue;
    const inside = f.nbWood / f.nbLand;
    if (inside < NEIGHBOUR_MIN_WOOD) continue;
    const outside = f.wood / f.land;
    const ratio = outside / inside;
    if (ratio >= ratioGate) continue;
    const span = Math.max(f.x1 - f.x0 + 1, f.y1 - f.y0 + 1);
    const [cx, cy, cw] = crop((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, span, a.W, a.H);
    const name = (plan.districts[f.district] as { name?: string } | undefined)?.name ?? '?';
    out.push({
      sig: 'country-outside-blocks',
      x: cx,
      y: cy,
      w: cw,
      severity: ratio <= ratioGate / 2 ? 'high' : 'med',
      rank: f.land * (1 - ratio),
      reason: `${name} ${f.x0},${f.y0}-${f.x1},${f.y1}: ${f.land} tiles of country no block covers are ${(100 * outside).toFixed(1)}% wood, against ${(100 * inside).toFixed(1)}% in the ${f.nbLand} tiles of country inside the ${f.nbBlocks} rural block(s) next to them (${ratio.toFixed(2)}x) — the rural fill runs over BLOCKS, so ground outside every block was never asked what it is and keeps the bare meadow the ground pass wrote`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 16. carve-is-a-ruler — a straight line drawn through a wood         */
/* ------------------------------------------------------------------ */

/** What a ruler can be cut IN: open ground, never a carriageway or a runway. */
const CUTTABLE = new Set<number>([T_FIELD, T_PARK, T_SAND]);
/**
 * Widest cut that still reads as a slot rather than a clearing. The defect is
 * a route, and a route is as narrow as whatever drew it could get away with.
 */
const RULER_MAX_WIDE = 3;

/**
 * A long, perfectly straight, narrow cut through the canopy.
 *
 * Nothing in this city is straight over forty tiles. The coastline is a
 * curve, the wildness field's contour is a curve, a block is at most sixty
 * tiles on a side and the woodland inside one is a patch of noise. The two
 * exceptions are AUTHORED and are excluded by material rather than by
 * geometry: the ring road and the lattice are carriageway, the airstrips are
 * runway, and neither is a natural material. So a straight edge in open
 * country is a machine's route, drawn once and never softened — and the
 * narrower it is, the more certain that is.
 *
 * Iteration 3 is the case this generalises. The ride the corridor carve-back
 * cut on Gannet Rock was a SHORTEST PATH, and it could only take back tiles
 * it had itself just planted — over a removed street that is a corridor with
 * a block wall of trees down each side, so the only route it could find was
 * the vanished street, end to end: a dead straight one-tile slot forty-six
 * tiles long at 111,606. `bare-corridor` walks straight past it, twice over —
 * it wants a span at least two tiles wide, and it allows the flanks to wander
 * two tiles a line, which is the tolerance a natural glade needs and exactly
 * the tolerance that stops it being a test of straightness.
 *
 * This one is the opposite instrument, and deliberately narrow rather than
 * tolerant: the run has to be the SAME span on every line, to the tile, for
 * its whole length. That one condition is what makes the false-positive rate
 * on the shipped bake zero — a glade does not hold its edges for sixteen
 * lines, and a hedgerow, an orchard row or the ecotone's smallholding rows
 * (§14.3 D5) are wood laid across meadow rather than meadow cut through wood,
 * which is why the flank is canopy and only canopy. Cutting the other way
 * round — a straight band of TREES flanked by field — is authored planting
 * and fires on both the fixed and the unfixed asset at 420,658, so it is not
 * this signature's business.
 *
 * **How much headroom the length gate has, measured rather than asserted.**
 * Swept over the two assets: at 24 the pre-fix bake shows only the ride and
 * the shipped bake nothing; at 16 the pre-fix bake shows the ride and a
 * 17-tile cut at 509,656 that the new fill has since closed, and the shipped
 * bake still nothing; at 12 the shipped bake shows one, a 14-tile one-tile gap
 * between two stands at 306,687. So 16 is two tiles clear of the nearest thing
 * on the shipped map — thin, and chosen anyway, because the 17-tile hit it
 * buys is a real instance of the defect and the 14-tile near-miss reads like
 * the same shape rather than like noise. Raise it with `--ruler=` before
 * concluding a hit near the gate is a false positive.
 */
function rulerCuts(a: Audit, minLen: number, maxWide: number): Finding[] {
  const { W, H, at } = a;
  const out: Finding[] = [];
  const scan = (vertical: boolean): void => {
    const outer = vertical ? W : H;
    const inner = vertical ? H : W;
    const tileAt = (u: number, v: number): number => (vertical ? at(v, u) : at(u, v));
    /** Cut spans per line, as [start, end, material). */
    const spans: Array<Array<[number, number, number]>> = [];
    for (let v = 0; v < inner; v++) {
      const row: Array<[number, number, number]> = [];
      let u = 0;
      while (u < outer) {
        const t = tileAt(u, v);
        if (!CUTTABLE.has(t)) {
          u++;
          continue;
        }
        let e = u;
        while (e < outer && tileAt(e, v) === t) e++;
        const wide = e - u;
        if (wide <= maxWide && tileAt(u - 1, v) === T_TREES && tileAt(e, v) === T_TREES) {
          row.push([u, e, t]);
        }
        u = e;
      }
      spans.push(row);
    }
    const used = spans.map((r) => new Uint8Array(r.length));
    for (let v = 0; v < inner; v++) {
      const row = spans[v] as Array<[number, number, number]>;
      for (const [si, s] of row.entries()) {
        if ((used[v] as Uint8Array)[si] === 1) continue;
        let end = v;
        for (let vv = v + 1; vv < inner; vv++) {
          const next = spans[vv] as Array<[number, number, number]>;
          let found = -1;
          for (const [ni, n] of next.entries()) {
            // To the tile, on every line. Not "overlapping and not wandering
            // far" — that is `bare-corridor`, and it is why `bare-corridor`
            // cannot answer this question.
            if (n[0] === s[0] && n[1] === s[1] && n[2] === s[2]) {
              found = ni;
              break;
            }
          }
          if (found < 0) break;
          (used[vv] as Uint8Array)[found] = 1;
          end = vv;
        }
        const len = end - v + 1;
        if (len < minLen) continue;
        const wide = s[1] - s[0];
        const x0 = vertical ? v : s[0];
        const y0 = vertical ? s[0] : v;
        const [cx, cy, cw] = crop(
          vertical ? v + len / 2 : (s[0] + s[1]) / 2,
          vertical ? (s[0] + s[1]) / 2 : v + len / 2,
          len,
          W,
          H,
        );
        out.push({
          sig: 'carve-is-a-ruler',
          x: cx,
          y: cy,
          w: cw,
          severity: len >= minLen * 2 ? 'high' : 'med',
          rank: len / wide,
          reason: `${wide}-tile-wide cut of ${tileName(s[2] as number)} at ${x0},${y0} running ${len} tiles ${vertical ? 'east-west' : 'north-south'} through woodland, the same span on every one of those lines — nothing in open country is straight over that distance except a carriageway or a runway, and this is neither, so it is a route some pass drew with a ruler and never softened`,
        });
      }
    }
  };
  scan(false);
  scan(true);
  return out;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decode a `city.data.ts` from disk. The shipped one by default, any other
 * when `--data` names it — which is how the detector is calibrated against a
 * tree where the defects are known to be present.
 */
function loadBake(path: string): BakedCity {
  const src = readFileSync(path, 'utf8');
  const a = src.indexOf('"');
  const b = src.lastIndexOf('"');
  if (a < 0 || b <= a) throw new Error(`${path} does not look like a city.data.ts`);
  return decodeBakedCity(JSON.parse(JSON.parse(src.slice(a, b + 1))));
}

function loadPlan(path: string): CityPlan {
  return parseCityPlan(JSON.parse(readFileSync(path, 'utf8')));
}

/* ------------------------------------------------------------------ */

const ALL_SIGS = [
  'road-deadend',
  'road-stops-short',
  'road-speck',
  'road-notch',
  'road-width-jump',
  'junction-stub',
  'walk-orphan',
  'kerb-missing',
  'crossing-missing',
  'shore-staircase',
  'built-staircase',
  'bare-corridor',
  'patch-square',
  'edge-notch',
  'fabric-coarse',
  'course-coverage-outlier',
  'street-serves-nothing',
  'lanes-serving-nothing',
  'country-outside-blocks',
  'carve-is-a-ruler',
] as const;

/* ------------------------------------------------------------------ */
/* --selftest: does the instrument fire at all?                        */
/* ------------------------------------------------------------------ */

/**
 * Five instruments in this project have been caught confidently reporting
 * nothing, so a signature that scores zero on the shipped city has to prove it
 * is looking. Each plant below writes a KNOWN defect of one signature into a
 * copy of the shipped tiles, in open country where nothing else is happening,
 * and the run says FIRED or SILENT. SILENT means the detector is broken; it
 * does not mean the city is clean.
 *
 * Signatures with a real historical control — `crossing-missing` (Hollis
 * Creek) and `fabric-coarse` (The Docks), both at `1469611` — are calibrated
 * against that bake instead and are not planted here.
 */
interface Plant {
  sig: string;
  where: string;
  apply: (
    tiles: Uint8Array,
    W: number,
    at: (x: number, y: number) => number,
    plan: CityPlan,
    base: Audit,
  ) => [number, number];
  /**
   * Some defects are in the VECTORS, not the raster: a borough loses its
   * centrelines while its tarmac stays exactly where it was. A plant that
   * needs one edits the courses here, after `apply` has run.
   */
  courses?: (courses: StreetCourse[]) => StreetCourse[];
}

/** A patch of open field big enough to build a defect in, away from the city. */
function findMeadow(a: Audit, w: number, h: number, startY: number): [number, number] {
  const { W, H, tiles } = a;
  for (let y = startY; y < H - h - 2; y++) {
    for (let x = 2; x < W - w - 2; x++) {
      let ok = true;
      for (let dy = -1; dy <= h && ok; dy++) {
        for (let dx = -1; dx <= w && ok; dx++) {
          if (tiles[(y + dy) * W + x + dx] !== T_FIELD) ok = false;
        }
      }
      if (ok) return [x, y];
    }
  }
  throw new Error('no meadow big enough to plant a control in');
}

function selftest(city: BakedCity, plan: CityPlan): void {
  const base = buildAudit(city);
  // What a plant's `apply` worked out and its `courses` needs a moment later.
  // Plants run one at a time, each against a fresh copy of the tiles.
  let victimBorough = -1;
  let victimOwner: Int16Array | null = null;
  let stubEnds: number[] = [0, 0, 0, 0];
  const plants: Plant[] = [
    {
      sig: 'road-speck',
      where: 'a lone tile of tarmac in open field',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 3, 3, 40);
        t[y * W + x] = T_ROAD;
        return [x, y];
      },
    },
    {
      sig: 'road-notch',
      where: 'a wall punched through the middle of a carriageway',
      apply: (t, W, at) => {
        for (let i = 0; i < t.length; i++) {
          const x = i % W;
          const y = (i - x) / W;
          if (!isRoad(at(x, y))) continue;
          if (!isRoad(at(x + 1, y)) || !isRoad(at(x - 1, y))) continue;
          if (!isRoad(at(x, y + 1)) || !isRoad(at(x, y - 1))) continue;
          t[i] = T_BUILDING;
          return [x, y];
        }
        throw new Error('no carriageway interior to punch');
      },
    },
    {
      sig: 'road-deadend',
      where: 'a 3-wide street ending in open ground',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 5, 16, 80);
        for (let d = 0; d < 14; d++) for (let k = 0; k < 3; k++) t[(y + d) * W + x + k] = T_ROAD;
        return [x, y + 13];
      },
    },
    {
      sig: 'road-stops-short',
      where: 'a street stopping two tiles short of the avenue it runs at',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 22, 22, 100);
        for (let d = 0; d < 20; d++) for (let k = 0; k < 3; k++) t[(y + k) * W + x + d] = T_ROAD;
        for (let d = 0; d < 20; d++) for (let k = 0; k < 3; k++) t[(y + d) * W + x + 16 + k] = T_ROAD;
        for (let k = 0; k < 3; k++) t[(y + k) * W + x + 14] = T_FIELD;
        for (let k = 0; k < 3; k++) t[(y + k) * W + x + 15] = T_FIELD;
        return [x + 13, y];
      },
    },
    {
      sig: 'road-width-jump',
      where: 'a straight street stepping 3 -> 5 tiles wide',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 7, 26, 120);
        for (let d = 0; d < 12; d++) for (let k = 0; k < 3; k++) t[(y + d) * W + x + k] = T_ROAD;
        for (let d = 12; d < 24; d++) for (let k = 0; k < 5; k++) t[(y + d) * W + x + k] = T_ROAD;
        return [x, y + 12];
      },
    },
    {
      sig: 'junction-stub',
      where: 'a crossroads-shaped patch with one street leaving it',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 9, 20, 160);
        for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) t[(y + dy) * W + x + dx] = T_ROAD;
        for (let d = 7; d < 18; d++) for (let k = 2; k < 5; k++) t[(y + d) * W + x + k] = T_ROAD;
        return [x, y];
      },
    },
    {
      sig: 'walk-orphan',
      where: 'a ring of pavement with no street anywhere near it',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 6, 6, 200);
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) t[(y + dy) * W + x + dx] = T_SIDEWALK;
        return [x, y];
      },
    },
    {
      sig: 'patch-square',
      where: 'a perfect 6x6 stamp of woodland in a meadow',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 8, 8, 240);
        for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) t[(y + dy) * W + x + dx] = T_TREES;
        return [x, y];
      },
    },
    {
      sig: 'edge-notch',
      where: 'a single tile of open water in the middle of a meadow',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 3, 3, 280);
        t[y * W + x] = T_WATER;
        return [x, y];
      },
    },
    {
      sig: 'bare-corridor',
      where: 'a 6-wide ruler-straight lane cut 30 tiles through a wood',
      apply: (t, W) => {
        // A wood to cut through, first: the plant has to make its own.
        const [x, y] = findMeadow(base, 15, 30, 0);
        for (let dy = 0; dy < 29; dy++) for (let dx = 0; dx < 14; dx++) t[(y + dy) * W + x + dx] = T_TREES;
        for (let dy = 1; dy < 28; dy++) for (let dx = 4; dx < 10; dx++) t[(y + dy) * W + x + dx] = T_FIELD;
        return [x + 6, y + 2];
      },
    },
    {
      sig: 'built-staircase',
      where: 'a 5-tile-tread staircase on the edge of a yard',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 45, 15, 0);
        for (let s = 0; s < 8; s++) {
          for (let dx = 0; dx < 5; dx++) {
            for (let dy = 0; dy < 6; dy++) t[(y + s + dy) * W + x + s * 5 + dx] = T_LOT;
          }
        }
        return [x, y];
      },
    },
    {
      sig: 'kerb-missing',
      where: 'a building wall laid straight onto the carriageway',
      apply: (t, W, at) => {
        for (let i = 0; i < t.length; i++) {
          const x = i % W;
          const y = (i - x) / W;
          if (!isRoad(at(x, y)) || at(x, y - 1) !== T_SIDEWALK) continue;
          let run = 0;
          while (run < 10 && isRoad(at(x + run, y)) && at(x + run, y - 1) === T_SIDEWALK) run++;
          if (run < 10) continue;
          for (let k = 0; k < 10; k++) t[(y - 1) * W + x + k] = T_BUILDING;
          return [x, y];
        }
        throw new Error('no kerb to bury');
      },
    },
    {
      sig: 'shore-staircase',
      where: 'a 14-tile horizontal tread cut into a diagonal waterline',
      apply: (t, W, at) => {
        // Find a stretch of waterline whose shipped curve is well off the
        // axis, then flatten fourteen tiles of it into one tread.
        const idx = segIndex(city.shores, 16);
        const H = city.heightTiles;
        for (let y = 4; y < H - 4; y++) {
          for (let x = 4; x < W - 20; x++) {
            if (at(x, y) !== T_WATER) continue;
            if (at(x, y + 1) !== T_SAND && at(x, y + 1) !== T_FIELD) continue;
            if (curveOffAxis(idx, x + 0.5, y + 0.5, 6) < 25) continue;
            let clear = true;
            for (let k = 0; k < 14 && clear; k++) {
              const below = at(x + k, y + 1);
              if (below !== T_SAND && below !== T_FIELD && below !== T_WATER) clear = false;
            }
            if (!clear) continue;
            for (let k = 0; k < 14; k++) {
              for (let d = -3; d <= 0; d++) t[(y + d) * W + x + k] = T_WATER;
              t[(y + 1) * W + x + k] = T_SAND;
            }
            return [x, y];
          }
        }
        throw new Error('no off-axis waterline to flatten');
      },
    },
    /* The three course- and region-shaped signatures. Their defects are not
     * marks on the raster — one deletes centrelines and leaves the tarmac
     * exactly where it was, one adds a centreline, one lays lanes on ground
     * no borough claims — so they plant through `courses` as well as `apply`. */
    {
      sig: 'course-coverage-outlier',
      where: 'every centreline of the best-covered borough deleted, its tarmac untouched',
      apply: (_t, W, _at, plan, base) => {
        const owner = ownerPlane(plan, base.tiles, W, base.H);
        const cover = courseCoverPlane(base.city);
        const covered = new Int32Array(plan.districts.length);
        for (let i = 0; i < base.tiles.length; i++) {
          const d = owner[i] as number;
          if (d >= 0 && cover[i] === 1 && isRoad(base.tiles[i] as number)) {
            covered[d] = (covered[d] as number) + 1;
          }
        }
        let best = -1;
        for (let d = 0; d < covered.length; d++) {
          if (best < 0 || (covered[d] as number) > (covered[best] as number)) best = d;
        }
        victimBorough = best;
        victimOwner = owner;
        const d = plan.districts[best] as CityPlan['districts'][number];
        let sx = 0;
        let sy = 0;
        for (const [px, py] of d.area) {
          sx += px;
          sy += py;
        }
        return [Math.round(sx / d.area.length), Math.round(sy / d.area.length)];
      },
      courses: (cs) =>
        cs.filter((c) => {
          if (c.kind === 'path' || victimOwner === null) return true;
          const W = city.widthTiles;
          const [mx, my] = c.points[Math.floor(c.points.length / 2)] as readonly [number, number];
          const tx = Math.min(W - 1, Math.max(0, Math.floor(mx)));
          const ty = Math.min(city.heightTiles - 1, Math.max(0, Math.floor(my)));
          return (victimOwner[ty * W + tx] as number) !== victimBorough;
        }),
    },
    {
      sig: 'street-serves-nothing',
      where: 'a 3-wide street carved in open field with a course down it and nothing at either end',
      apply: (t, W) => {
        const [x, y] = findMeadow(base, 5, 16, 300);
        for (let dy = 0; dy <= 13; dy++) {
          for (let dx = 1; dx <= 3; dx++) t[(y + dy) * W + x + dx] = T_ROAD;
        }
        stubEnds = [x + 2.5, y + 0.5, x + 2.5, y + 12.5];
        return [x + 2, y];
      },
      courses: (cs) => [
        ...cs,
        {
          points: [
            [stubEnds[0] as number, stubEnds[1] as number],
            [stubEnds[2] as number, stubEnds[3] as number],
          ],
          width: 3,
          kind: 'street',
        },
      ],
    },
    {
      sig: 'lanes-serving-nothing',
      where: 'a lattice of lanes laid over empty ground outside every district polygon',
      apply: (t, W, _at, plan, base) => {
        // The emptiest un-districted region there is — no lanes on it and
        // nothing built on it — so the plant supplies only the lanes.
        let best: Fringe | null = null;
        for (const f of fringeRegions(base, plan)) {
          if (f.road > 0 || f.built > 0 || f.land < GATES.fringeLand) continue;
          if (best === null || f.land > best.land) best = f;
        }
        if (best === null) throw new Error('no empty un-districted region to lay lanes on');
        const inPoly = polyMask(plan, W, base.H);
        for (let y = best.y0; y <= best.y1; y++) {
          for (let x = best.x0; x <= best.x1; x++) {
            const i = y * W + x;
            if (inPoly[i] === 1 || base.tiles[i] === T_WATER) continue;
            if (x % 12 < 3 || y % 12 < 3) t[i] = T_ROAD;
          }
        }
        return [best.x0, best.y0];
      },
    },
    {
      sig: 'country-outside-blocks',
      where: 'a wooded rural block beside country outside the blocks that is stripped bare',
      apply: (t, W, _at, plan, base) => {
        // A region the signature is currently SILENT about, made into the
        // defect from both sides: its own country stripped to bare meadow,
        // and the country inside the rural blocks next to it planted solid.
        // That is the disagreement this signature exists to see, and building
        // it rather than deepening an existing one is what keeps the control
        // honest against the pre-fix asset too — there, every region that has
        // a comparator at all is ALREADY a finding, so a plant that only
        // stripped wood would read SILENT on the very bake where the defect
        // is known to be present.
        let best: Orphan | null = null;
        for (const f of orphanCountry(base, plan)) {
          if (f.land < GATES.orphanLand || f.nbLand < NEIGHBOUR_MIN_COUNTRY) continue;
          const inside = f.nbWood / f.nbLand;
          const fires = inside >= NEIGHBOUR_MIN_WOOD && f.wood / f.land < GATES.orphanWood * inside;
          if (fires) continue;
          if (best === null || f.land > best.land) best = f;
        }
        if (best === null) throw new Error('no quiet stretch of orphan country to spoil');
        for (const i of best.bag) if (t[i] === T_TREES) t[i] = T_FIELD;
        for (const bi of best.nb) {
          const b = base.city.blocks[bi] as (typeof base.city.blocks)[number];
          for (let y = Math.max(0, b.y); y < Math.min(base.H, b.y + b.h); y++) {
            for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) {
              const i = y * W + x;
              if (isCountry(base.tiles[i] as number)) t[i] = T_TREES;
            }
          }
        }
        return [best.x0, best.y0];
      },
    },
    {
      sig: 'carve-is-a-ruler',
      where: 'a one-tile slot cut dead straight down a standing wood',
      apply: (t, W, at, _plan, base) => {
        const len = GATES.ruler + 8;
        for (let x = 1; x + 1 < W; x++) {
          for (let y = 0; y + len <= base.H; y++) {
            let ok = true;
            for (let k = 0; k < len && ok; k++) {
              if (at(x, y + k) !== T_TREES) ok = false;
              else if (at(x - 1, y + k) !== T_TREES || at(x + 1, y + k) !== T_TREES) ok = false;
            }
            if (!ok) continue;
            for (let k = 0; k < len; k++) t[(y + k) * W + x] = T_FIELD;
            return [x, y];
          }
        }
        throw new Error('no wood deep enough to cut a ruler through');
      },
    },
  ];

  console.log('# selftest: plant a known defect, then look for it');
  let broken = 0;
  for (const p of plants) {
    const tiles = city.tiles.slice();
    const W = city.widthTiles;
    const H = city.heightTiles;
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= W || y >= H ? T_WATER : (city.tiles[y * W + x] as number);
    let planted: [number, number];
    try {
      planted = p.apply(tiles, W, at, plan, base);
    } catch (e) {
      console.log(`# ${pad(p.sig, 18)}  ERROR   could not plant: ${(e as Error).message}`);
      broken++;
      continue;
    }
    const dirty: BakedCity = {
      ...city,
      tiles,
      courses: p.courses ? p.courses(city.courses) : city.courses,
    };
    const before = run(city, plan, new Set([p.sig])).filter((f) => f.sig === p.sig).length;
    const after = run(dirty, plan, new Set([p.sig])).filter((f) => f.sig === p.sig).length;
    const fired = after > before;
    if (!fired) broken++;
    console.log(
      `# ${pad(p.sig, 18)}  ${fired ? 'FIRED  ' : 'SILENT '}  ${before} -> ${after} at ${planted[0]},${planted[1]} — ${p.where}`,
    );
  }
  console.log(
    `# ${broken === 0 ? 'every planted control fired' : `${broken} SIGNATURE(S) DID NOT FIRE — those numbers mean nothing`}`,
  );
  console.log('# crossing-missing and fabric-coarse are calibrated against the 1469611 bake (--data), not planted');
}

/* ------------------------------------------------------------------ */

interface Gates {
  minRun: number;
  minExcess: number;
  maxGap: number;
  fabric: number;
  minSpan: number;
  minLen: number;
  /** Fraction of the MEDIAN borough's course coverage below which one fires. */
  coverage: number;
  /** Longest course, in tiles, that can count as a street serving nothing. */
  serves: number;
  /** Tarmac allowed past a street's end before the end is not an end. */
  cap: number;
  /** Smallest un-districted land region, in tiles, worth a finding. */
  fringeLand: number;
  /** Road share a fringe region needs before its emptiness is a defect. */
  fringeRoad: number;
  /** Smallest stretch of country outside every block worth a finding. */
  orphanLand: number;
  /** Fraction of the NEIGHBOURING blocks' wood below which bald country fires. */
  orphanWood: number;
  /** Shortest perfectly straight cut through woodland that counts as a ruler. */
  ruler: number;
}

let GATES: Gates = {
  minRun: 5,
  minExcess: 2,
  maxGap: 12,
  fabric: 2.5,
  minSpan: 16,
  minLen: 24,
  coverage: 0.5,
  serves: 20,
  cap: 4,
  fringeLand: 1000,
  fringeRoad: 0.1,
  orphanLand: 200,
  orphanWood: 0.4,
  ruler: 16,
};

function run(city: BakedCity, plan: CityPlan, only: Set<string> | null): Finding[] {
  const a = buildAudit(city);
  const landmarks = city.landmarks;
  const landmarkNear = (x: number, y: number, r: number): boolean =>
    landmarks.some((l) => x >= l.x - r && x <= l.x + l.w + r && y >= l.y - r && y <= l.y + l.h + r);
  const want = (s: string): boolean => only === null || only.has(s);
  const findings: Finding[] = [];
  if (want('road-deadend') || want('road-stops-short')) {
    findings.push(...deadEnds(a, landmarkNear).filter((f) => want(f.sig)));
  }
  if (want('road-speck') || want('road-notch')) {
    findings.push(...specksAndNotches(a).filter((f) => want(f.sig)));
  }
  if (want('road-width-jump')) findings.push(...widthJumps(a));
  if (want('junction-stub')) findings.push(...junctionStubs(a));
  if (want('walk-orphan')) findings.push(...orphanPavement(a));
  if (want('kerb-missing')) findings.push(...missingKerbs(a).findings);
  if (want('crossing-missing')) findings.push(...missingCrossings(a, GATES.maxGap));
  if (want('shore-staircase')) findings.push(...shoreStaircase(a, GATES.minRun, GATES.minExcess));
  if (want('built-staircase')) findings.push(...builtStaircase(a, GATES.minSpan));
  if (want('bare-corridor')) findings.push(...bareCorridors(a, GATES.minLen));
  if (want('patch-square')) findings.push(...squarePatches(a));
  if (want('edge-notch')) findings.push(...edgeNotches(a));
  if (want('fabric-coarse')) findings.push(...coarseFabric(city, plan, GATES.fabric));
  if (want('course-coverage-outlier')) findings.push(...coverageOutliers(city, plan, GATES.coverage));
  if (want('street-serves-nothing')) {
    findings.push(...streetsServingNothing(a, city, GATES.serves, GATES.cap));
  }
  if (want('lanes-serving-nothing')) {
    findings.push(...lanesServingNothing(a, plan, GATES.fringeLand, GATES.fringeRoad));
  }
  if (want('country-outside-blocks')) {
    findings.push(...baldCountry(a, plan, GATES.orphanLand, GATES.orphanWood));
  }
  if (want('carve-is-a-ruler')) findings.push(...rulerCuts(a, GATES.ruler, RULER_MAX_WIDE));
  return findings;
}

/**
 * The raster in letters, for the same crop `mapgen` renders.
 *
 * A render at sixteen pixels a tile still cannot always tell a lot from a
 * pavement or a road from a yard, and every judgement about a false positive
 * here comes down to exactly that question. This prints what the detector
 * read, so the picture and the finding can be checked against each other
 * instead of against a guess about a colour.
 */
function dumpTiles(city: BakedCity, box: [number, number, number]): void {
  const W = city.widthTiles;
  const H = city.heightTiles;
  const [x0, y0, w] = box;
  const KEY = '.RSBPLwbrfqTsY';
  console.log(`# ${x0},${y0},${w}   . field  R road  S sidewalk  B building  P park  L lot`);
  console.log('#                 w water  b bridge  r ramp  f floor  q quay/bank  T trees  s sand  Y runway');
  let head = '     ';
  for (let x = x0; x < Math.min(W, x0 + w); x++) head += x % 10 === 0 ? '|' : ' ';
  console.log(head);
  for (let y = y0; y < Math.min(H, y0 + w); y++) {
    let line = String(y).padStart(4) + ' ';
    for (let x = x0; x < Math.min(W, x0 + w); x++) line += KEY[city.tiles[y * W + x] as number] ?? '?';
    console.log(line);
  }
}

function main(): void {
  let dataPath = '';
  let planPath = '';
  let dump: [number, number, number] | null = null;
  let only: Set<string> | null = null;
  let limit = 12;
  let quiet = false;
  let test = false;
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const key = m[1] as string;
    const val = m[2];
    if (key === 'data' && val) dataPath = val;
    if (key === 'plan' && val) planPath = val;
    if (key === 'only' && val) only = new Set(val.split(','));
    if (key === 'limit' && val) limit = Number.parseInt(val, 10);
    if (key === 'all') limit = Infinity;
    if (key === 'summary') quiet = true;
    if (key === 'selftest') test = true;
    if (key === 'dump' && val) {
      const p = val.split(',').map((v) => Number.parseInt(v, 10));
      if (p.length < 3 || p.some((v) => !Number.isFinite(v))) throw new Error('--dump wants x,y,w in tiles');
      dump = [p[0] as number, p[1] as number, p[2] as number];
    }
    if (key === 'minrun' && val) GATES.minRun = Number.parseInt(val, 10);
    if (key === 'minexcess' && val) GATES.minExcess = Number.parseFloat(val);
    if (key === 'maxgap' && val) GATES.maxGap = Number.parseInt(val, 10);
    if (key === 'fabric' && val) GATES.fabric = Number.parseFloat(val);
    if (key === 'minspan' && val) GATES.minSpan = Number.parseInt(val, 10);
    if (key === 'minlen' && val) GATES.minLen = Number.parseInt(val, 10);
    if (key === 'coverage' && val) GATES.coverage = Number.parseFloat(val);
    if (key === 'serves' && val) GATES.serves = Number.parseFloat(val);
    if (key === 'cap' && val) GATES.cap = Number.parseInt(val, 10);
    if (key === 'fringeland' && val) GATES.fringeLand = Number.parseInt(val, 10);
    if (key === 'fringeroad' && val) GATES.fringeRoad = Number.parseFloat(val);
    if (key === 'orphanland' && val) GATES.orphanLand = Number.parseInt(val, 10);
    if (key === 'orphanwood' && val) GATES.orphanWood = Number.parseFloat(val);
    if (key === 'ruler' && val) GATES.ruler = Number.parseInt(val, 10);
  }
  const dataUrl = dataPath || new URL('../../../shared/src/world/city.data.ts', import.meta.url);
  const planUrl = planPath || new URL(import.meta.resolve('shared/data/city-plan.json'));
  const city = loadBake(typeof dataUrl === 'string' ? dataUrl : dataUrl.pathname);
  const plan = loadPlan(typeof planUrl === 'string' ? planUrl : planUrl.pathname);

  if (test) {
    selftest(city, plan);
    return;
  }
  if (dump) {
    dumpTiles(city, dump);
    return;
  }

  const want = (s: string): boolean => only === null || only.has(s);
  const findings = run(city, plan, only);

  const bySig = new Map<string, Finding[]>();
  for (const f of findings) {
    const bag = bySig.get(f.sig);
    if (bag) bag.push(f);
    else bySig.set(f.sig, [f]);
  }

  console.log(`# ${city.name} ${city.widthTiles}x${city.heightTiles} from ${typeof dataUrl === 'string' ? dataUrl : 'shared/src/world/city.data.ts'}`);
  if (!quiet) {
    for (const sig of ALL_SIGS) {
      const bag = bySig.get(sig);
      if (!bag) continue;
      bag.sort((p, q) => SEV_ORDER[p.severity] - SEV_ORDER[q.severity] || q.rank - p.rank);
      const shown = bag.slice(0, limit);
      for (const f of shown) {
        console.log(`${pad(f.sig, 18)}  ${pad(`${f.x},${f.y},${f.w}`, 14)}  ${pad(f.severity, 5)}  ${f.reason}`);
      }
      if (bag.length > shown.length) {
        console.log(`${pad(sig, 18)}  ${pad('-', 14)}  ${pad('-', 5)}  ... and ${bag.length - shown.length} more (--all to list)`);
      }
    }
  }
  console.log('# summary');
  let total = 0;
  for (const sig of ALL_SIGS) {
    if (!want(sig)) continue;
    const n = bySig.get(sig)?.length ?? 0;
    total += n;
    console.log(`# ${pad(sig, 18)}  ${String(n).padStart(6)}${NOISY.has(sig) ? '  noisy' : ''}`);
  }
  console.log(`# ${pad('TOTAL', 18)}  ${String(total).padStart(6)}`);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

main();
