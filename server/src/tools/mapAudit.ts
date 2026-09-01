import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  parseCityPlan,
  pointInPoly,
  roadCourses,
  type PlanPoint,
  shoreChains,
  buildDeckCut,
  BEV_NONE,
  deriveBevels,
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
// The bake's own noise, reached through the built package rather than through
// `shared`'s barrel, because `world/fields.ts` is not on it and this tool is
// not allowed to add an export to `shared/src`. A relative path into
// `shared/dist` is redirected back to `shared/src/world/fields.ts` by the
// project reference at compile time and resolves to the built file at run
// time, so this is the same arithmetic `bake.ts` ran, not a second copy of it.
import { fbm } from '../../../shared/dist/world/fields.js';

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
 *   <signature>  x,y,w  <severity>  m=<magnitude>  <one-line reason>
 *
 * `x,y,w` is a `pnpm mapgen --crop=` argument, so every line is directly a
 * command for looking at the thing it claims.
 *
 * `m=` is the defect's MAGNITUDE in tiles — how big it is, not whether it is
 * there. It exists because the count alone could not see a fix that made a
 * defect smaller without removing it; see `magOf` for the failure that forced
 * it and the four properties any new signature's magnitude has to keep.
 *
 * The summary carries THREE totals:
 *
 *   TOTAL  the count of candidates.
 *   SCORE  the sum of magnitudes, `noisy` signatures discounted: weighted
 *          tiles of defect in the TILE PLANE, which is the ground as baked and
 *          also what collision drives against.
 *   DRAWN  the part of SCORE a renderer actually puts on the screen.
 *
 * SCORE and DRAWN differ because a defect can be in the tile plane and painted
 * over — a quay stepping every three tiles is repainted against a chord by the
 * coast, bank or deck curve and cannot be seen from any camera. Those tiles
 * stay in SCORE, because a renderer change can expose them again without one
 * tile of ground moving and a score that fell for a repaint could not be told
 * from one that fell for a repair; and they are subtracted in DRAWN, because a
 * reviewer sent to look at them will see nothing. Only a signature that has
 * MEASURED its own drawing sets them apart, which today is `built-staircase`
 * and `landuse-staircase`; every other signature is a defect in the ground,
 * and ground is drawn. Those two run the same census over different edges and
 * come out opposite ways round, which is the point of having the column:
 * 97% of the built staircase lies on a curve layer and is invisible, and 90%
 * of the land-use staircase lies on no painter at all and is exactly what the
 * player sees.
 *
 * COMPARABILITY, stated because it has now been broken on purpose TWICE.
 *
 *  - Iteration 9 corrected `country-outside-blocks` to ask the bake's own
 *    wildness field before claiming ground "was never asked what it is",
 *    removing a false positive worth 258 weighted tiles from every bake.
 *  - Iteration 11 ADDED two signatures, for two defects a visual review found
 *    that none of the previous twenty could see: `course-unbuilt` (the 508
 *    tiles of authored road `citybake --check` has warned about on every run
 *    of this loop, which every iteration reported as a PASS CONDITION) and
 *    `landuse-staircase` (the land-use fill, drawn as the tile squares it is
 *    stored as, because no painter repaints it).
 *
 * So a number published by iterations 5 to 10 is on an older instrument and
 * does not compare with one from this. Every bake the loop has is restated on
 * THIS instrument in `evidence/iter11-instrument/history.txt`, regenerated by
 * `rescore-history.sh` beside it; iteration 9's two series are still in
 * `evidence/iter9-instrument/history.txt`. The deltas BETWEEN iterations are
 * unchanged by either correction, because neither of them moves with the map:
 * the false positive was constant across the series, and so are the six
 * unbuilt spans and the land-use fill.
 *
 * `--selftest` plants a known defect for each signature and checks that the
 * detector fires AND that the magnitude rises. Four controls follow it, because
 * a plant only ever proves a detector sees a defect APPEAR:
 *
 *   half-fix          a real finding shrunk but not cured: does the magnitude
 *                     fall while the finding stays? (iteration 6)
 *   wildness-field    is the copy of `bake.ts`'s wildness rule still that rule?
 *   unasked-country   does the new refusal refuse only answered ground?
 *   drawn             is `drawn` read off the curve layer, and off nothing else?
 *   quay              a genuine pier, fully built, draws no `course-unbuilt`
 *                     finding — and the same course fires the moment its
 *                     seaward tarmac is lifted (iteration 11)
 *   land-use          the same staircase walk is SILENT on the coastline and
 *                     LOUD on it with the curve layer removed, so what fires
 *                     the signature is the painter and not the tile plane
 *                     (iteration 11)
 *
 * `evidence/iter9-instrument/red-controls.sh` breaks the tool six ways and
 * shows every one of them turning `--selftest` red; `iter11-instrument/
 * red-controls.sh` does the same for the two controls above. Run them before
 * trusting a control you have changed: iteration 9's fifth break was found to
 * pass silently against the first four legs of the `drawn` control, which is
 * why there is a fifth, and iteration 11's third break (a bridge deck stops
 * counting as carriageway) is caught by the quay control's SILENT leg ALONE —
 * the plant still fires happily on it.
 *
 * `--regions` prints the blockless rural country census `country-outside-
 * blocks` gates on, one line per region. A diagnostic, not a signature.
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
  /**
   * HOW BIG this defect is, in tiles of map. See `magOf` below for why this
   * exists and what it must satisfy; each signature's own `mag:` line says
   * what its tiles count.
   */
  mag: number;
  /**
   * How much of `mag` a renderer actually DRAWS, in the same tiles.
   *
   * Defaults to `mag`, which is the honest default: every other signature in
   * here is a defect in the GROUND — a road that stops, country that is bald,
   * a slot cut through a wood — and the ground is drawn, so all of it is seen.
   * Only `built-staircase` sets this to less than `mag`, because only that
   * signature has measured its own drawing: a tile step whose two tiles lie on
   * a coast, bank or deck curve is repainted against the chord by all three
   * painters and never appears.
   *
   * It is a SEPARATE NUMBER and not a discount on `mag`. See the `DRAWN` note
   * at the foot of the summary for why.
   *
   * Left OFF a finding rather than set equal to `mag`, so that adding a new
   * signature cannot accidentally claim its defect is invisible by forgetting
   * a field. Read it through `drawnOf`.
   */
  drawn?: number;
  /**
   * The working behind `drawn`, carried so a control can check it rather than
   * take it on trust.
   *
   * `faces` MUST equal `span`: every position along the edge's profile is one
   * step face, and a census that asks about a subset of them is the bug
   * iteration 9 fixed (it only looked where the outward tile was open water,
   * so an inland quay was never asked at all and defaulted to "drawn"). The
   * identity is exact and not a tolerance — treads in a chain are contiguous
   * by construction, so every position in the span has a profile value — which
   * makes it the one assertion that catches ANY narrowing of the census.
   *
   * `landuse-staircase` carries it on the same terms: there a position is a
   * boundary face of the component rather than a profile column, and `span` is
   * the face count for exactly that reason. What the two share is the thing
   * worth asserting — the census asked about the WHOLE edge, not a subset it
   * found convenient.
   */
  profile?: { span: number; faces: number; dissolved: number };
}

/** How much of a finding a renderer draws: all of it, unless it said less. */
function drawnOf(f: Finding): number {
  return f.drawn ?? f.mag;
}

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/**
 * Magnitude: the size of a defect, in whole tiles of map.
 *
 * WHY. This tool's headline number was the COUNT of findings, and a count is
 * binary about things that are continuous. Iteration 5 took the shoulder
 * region from 1343 carriageway tiles on unclaimed ground down to 1140 — a
 * 203-tile improvement, plainly visible in the render — and the count did not
 * move, because `lanes-serving-nothing` gates on road >= 10% of the region's
 * land and 35.2% is still over 10%. The finding still fired, so TOTAL still
 * read 55, so a real fix scored exactly what a no-op scores. A loop whose
 * metric cannot see partial progress cannot tell a fix from a no-op and
 * cannot tell whether it is converging. (Iteration 3's zero was the other
 * failure, blindness — no signature at all — and iteration 4 closed it.)
 *
 * WHAT IT MUST SATISFY, and these are the properties to preserve if a new
 * signature is added:
 *
 *  1. It MOVES WHILE THE FINDING STILL FIRES. A magnitude that only changes
 *     when the finding stops firing is the defect being fixed here.
 *  2. It is MONOTONE: the defect getting smaller makes the number smaller,
 *     and nothing else does.
 *  3. It is a PROPERTY OF THE MAP, not of the run. No medians over the
 *     findings, no normalisation by the total, nothing that shifts when a
 *     different signature's count changes — otherwise two iterations'
 *     numbers cannot be compared, which is the whole point of having one.
 *  4. It is in TILES, one unit for the whole instrument, so the per-signature
 *     magnitudes can be added up and the sum means something.
 *
 * A finding that fired is at least one tile of defect, and magnitudes are
 * whole tiles so the printed per-finding values add up to the printed
 * per-signature subtotal exactly.
 *
 * `rank` is untouched and still orders the lines within a signature. The two
 * are deliberately separate: `rank` is a presentation key tuned for "show me
 * the worst twelve first" and several signatures invert it or fold severity
 * into it, so it is not comparable between runs and must not be scored.
 */
function magOf(n: number): number {
  return Math.max(1, Math.round(n));
}

/**
 * What a tile of each signature's defect is worth in the score.
 *
 * The `noisy` signatures are the reason this is not all ones. `built-staircase`
 * (24) and `street-serves-nothing` (5 until iteration 12 narrowed it to 0)
 * together were more than half the count, and a headline number more than half
 * made of hits a reviewer is told to treat as questions is a headline number
 * that moves for the wrong reasons.
 * Excluding them would be worse — they are not all false positives, and a
 * signature dropped from the score is a signature nobody looks at again. So
 * they are DISCOUNTED, not dropped: their findings still appear, still count
 * towards TOTAL, and still carry a magnitude, but a tile of them is worth a
 * quarter of a tile of a signature whose hits were all defects when they were
 * cropped and looked at.
 *
 * A constant of the instrument, in the source, so it is the same weight in
 * every iteration.
 */
const NOISY_WEIGHT = 0.25;

function weightOf(sig: string): number {
  return NOISY.has(sig) ? NOISY_WEIGHT : 1;
}

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
 * `street-serves-nothing` earned it differently and more cheaply: four hits,
 * two of them right — and the note used to end "no gate this tool can express
 * separates them". Iteration 12 found the gate: flood the tarmac from the end
 * instead of marching a ray at it (`endEscape`). All five hits on the
 * iteration-11 bake were the ray leaving a bending street, and the signature now
 * reads 0 there. It keeps the discount anyway, for the reason given on
 * `streetsServingNothing`: a signature is not made trustworthy by going quiet.
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
 * How far past a cap `deadEnds` looks for the next carriageway before calling
 * the cap `road-stops-short` rather than `road-deadend`.
 *
 * Named because the selftest plant has to clear at least this much ground past
 * its own cap or it lays the other signature's defect and reads SILENT — which
 * is exactly what it did from iteration 6 to 8. One constant, so the plant
 * cannot drift from the detector.
 */
const CAP_LOOKAHEAD = 6;

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
        for (let d = 1; d <= CAP_LOOKAHEAD; d++) {
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
            mag: magOf(len * short), // tiles of unmade junction: the gap across the street's mouth
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
          mag: magOf(len), // tiles of carriageway that end at nothing
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
      mag: magOf(bag.length), // tiles of stranded tarmac
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
      mag: magOf(bag.length), // tiles of hole punched through the carriageway
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
          mag: magOf(Math.abs(wi - wj)), // tiles the carriageway steps by
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
      mag: magOf(bag.length), // tiles of junction serving one arm
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
      mag: magOf(bag.length), // tiles of pavement serving no street
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
      mag: magOf(bag.length), // tiles of carriageway against a wall with no kerb
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
      mag: magOf(d < 0 ? W + H : d - straight), // tiles of detour the missing crossing costs; no route at all is capped at the longest journey the map can hold
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
                mag: magOf(excess), // tiles of tread beyond what the curve's slope accounts for
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
/* 8b. the staircase walk, shared by the two signatures that use it    */
/* ------------------------------------------------------------------ */

/**
 * One chain of treads climbing the outline of a component: a shallow diagonal
 * rasterised into steps.
 *
 * `prof` is the outline profile the chain was found in — one value per
 * position along `byColumn ? x : y`, holding the OTHER coordinate of the
 * outermost tile of the component at that position, or `-1` where the
 * component does not reach. It is carried out of the walk because both callers
 * need it afterwards to put each step face to the curve layer, and a census
 * that re-derives the outline is a second copy of this arithmetic that can
 * drift from it.
 */
interface Stair {
  byColumn: boolean;
  side: 0 | 1;
  prof: Int32Array;
  /** Origin of the profile: the component bounding box's `x0`, `y0`. */
  ox: number;
  oy: number;
  /** First position of the chain along the profile, and how far it runs. */
  at: number;
  span: number;
  /** How many treads make it up, and where the outline sits at either end. */
  count: number;
  v0: number;
  v1: number;
}

/**
 * Walk one component's outline and return every staircase chain in it.
 *
 * Extracted from `built-staircase` in iteration 11, unchanged, so that
 * `landuse-staircase` asks the SAME question of a land-use boundary rather
 * than a second, subtly different copy of it. `built-staircase`'s output is
 * byte-identical across the extraction (`evidence/iter11-instrument/
 * built-staircase-before.txt` against the same run after).
 *
 * The gates are arguments because the two callers want different ones: a BUILT
 * edge stepping every single tile is a proper 45-degree diagonal that the
 * bevel plane handles, so `built-staircase` asks for treads of 2 and up; a
 * land-use boundary has no bevel at all, so one-tile treads are drawn square
 * there and count.
 */
function outlineStairs(
  bag: number[],
  W: number,
  minSpan: number,
  minTread: number,
  maxTread: number,
  minCount: number,
): Stair[] {
  const out: Stair[] = [];
  const b = bbox(bag, W);
  const inBag = new Set(bag);
  for (const byColumn of [true, false]) {
    const n = byColumn ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
    const m = byColumn ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
    if (n < minSpan) continue;
    for (const side of [0, 1] as const) {
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
      const treads: Array<{ at: number; len: number; v: number }> = [];
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
      // A chain of short treads all stepping the same way by one: the shallow
      // diagonal. A single long tread never enters a chain, which is how a
      // straight quay stays out of this.
      let i = 0;
      while (i < treads.length) {
        let j = i;
        let dir = 0;
        while (j + 1 < treads.length) {
          const t0 = treads[j] as { at: number; len: number; v: number };
          const t1 = treads[j + 1] as { at: number; len: number; v: number };
          if (t1.at !== t0.at + t0.len) break;
          if (t0.len < minTread || t0.len > maxTread || t1.len < minTread || t1.len > maxTread) break;
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
        if (count >= minCount && span >= minSpan) {
          out.push({
            byColumn,
            side,
            prof,
            ox: b.x0,
            oy: b.y0,
            at: first.at,
            span,
            count,
            v0: first.v,
            v1: last.v,
          });
        }
        i = j + 1;
      }
    }
  }
  return out;
}

/**
 * The curve layers a painter cuts a boundary against, as a predicate on a
 * tile: the coast course, the shore band's inner edge (§39) and the bridge
 * deck's own edge (§45, `deckCut.ts`, iteration 8).
 *
 * This is the whole discriminator behind both staircase signatures and behind
 * the DRAWN column. A tile boundary is only DRAWN as a step where no chain
 * runs over it; where one does, all three painters cut it against the chord
 * and the steps are not on the screen at all. Land use has no chain, which is
 * `landuse-staircase`'s entire finding.
 */
function curveLayer(
  city: BakedCity,
  tiles: Uint8Array,
  W: number,
  H: number,
): (x: number, y: number) => boolean {
  const coast = shoreChains(city.shores, W, H);
  const band = shoreChains(city.banks, W, H);
  const deck = buildDeckCut(tiles, W, H, city.courses);
  return (x: number, y: number): boolean => {
    const i = y * W + x;
    return coast.has(i) || band.has(i) || deck.has(i);
  };
}

/* ------------------------------------------------------------------ */
/* 8c. built-staircase — the step a half-tile chamfer cannot reach     */
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
 * quay step faces dissolved, 0 of 466 bridge-deck ones — because a deck was
 * refused by name in all three painters ("the coast runs UNDER it", "a deck
 * is not ground at all") and no curve described a deck's own outer edge.
 * §45 gave it one — `buildDeckCut`, read back off the swept disc
 * `carveCourse` cut the deck FROM — and the deck chain is asked here too, so
 * a deck face now dissolves like a quay face. What that does NOT change is
 * `mag`: the tile staircase is still there and still counted, because this
 * signature measures the tiles and reports on the drawing.
 *
 * That is not gated on here, deliberately. Refusing the dissolved chains
 * lets a LANDWARD chain of the same quay through the one-edge-one-finding
 * dedup in their place — quay against pavement, against field — and those
 * are a different question this signature has not measured. So the fact is
 * REPORTED instead, per finding, and the reader can act on the ones whose
 * step faces are actually drawn.
 *
 * **Iteration 9 made that report a NUMBER (`drawn`) and fixed the census
 * behind it.** Two things were wrong with the old one:
 *
 *  - It only looked at a profile position where the tile just outside the
 *    outline was `T_WATER`. An inland quay has no such position, so it counted
 *    zero faces, asked the curve layer nothing, and printed "faces dry ground,
 *    which no coast curve describes, so it is drawn as it lies" about edges
 *    the BANK chain covers at every position. Eight of the twenty-four
 *    findings said that. Every profile position is a face now, and both the
 *    outline tile and its outward neighbour are put to all three chains, which
 *    is `evidence/iter7/curve-cover.mjs`'s method plus the deck chain.
 *  - Nothing downstream could see the answer. `drawn` is now the share of
 *    `mag` whose faces lie on no chain, and it sums into a DRAWN total beside
 *    SCORE.
 *
 * `mag` is deliberately UNCHANGED and still `span - count`. The staircase is a
 * fact about the tile plane: it is what collision drives against (§45.5 is
 * open on exactly that), and a renderer change could expose it again tomorrow
 * — iteration 8's deck curve moved 149 faces from drawn to not-drawn without
 * moving one tile of ground, and a SCORE that fell for it would be rewarding a
 * repaint as if it were a repair. So the drawing is reported beside the ground
 * and never subtracted from it.
 */
function builtStaircase(a: Audit, minSpan: number): Finding[] {
  const { W, H, tiles, at, city } = a;
  const out: Finding[] = [];
  // The coast course, the band's inner edge and the deck's own edge, per tile
  // — the same `shoreChains` all three painters index, so this asks the
  // question they answer. See `curveLayer`.
  //
  // The deck (§45) was added when the deck got a curve, for the
  // same reason the other two are here: this test exists to say whether the
  // staircase is DRAWN, and the answer changed. Asking only `coast u band`
  // would keep printing "no coast curve over them and are drawn square" of
  // 872 faces that are now cut on a chord in all three painters — which is
  // the single most expensive kind of wrong an instrument in this exercise
  // has been.
  //
  // `mag` and the finding COUNT are untouched, deliberately. `mag` is
  // `span - count`, tiles of flat tread, and the curve layer has never been
  // gated into it (see the note above). So SCORE and TOTAL still mean exactly
  // what they meant in iterations 5, 6 and 7 and still compare straight back
  // through the loop; only the sentence changes, and only where it had become
  // untrue.
  const onCurve = curveLayer(city, tiles, W, H);
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
      // The component's own outline, as a profile per column and per row, and
      // every chain of treads climbing it. `minTread` is 2 because a BUILT
      // edge stepping every single tile is a 45-degree diagonal the bevel
      // plane handles; see `outlineStairs`.
      for (const s of outlineStairs(bag, W, minSpan, 2, 10, 4)) {
        const { byColumn, side, prof, count, span } = s;
        // Is any of this staircase actually drawn? Each profile
        // position contributes a step face where the tile just outside
        // the outline is open water; the curve layer dissolves that
        // face if either of its two tiles is on a chain.
        let faces = 0;
        let dissolved = 0;
        let onWater = 0;
        for (let q = s.at; q < s.at + span; q++) {
          const v = prof[q] as number;
          if (v < 0) continue;
          const step = side === 0 ? -1 : 1;
          const x = byColumn ? s.ox + q : v;
          const y = byColumn ? v : s.oy + q;
          const ox = byColumn ? x : x + step;
          const oy = byColumn ? y + step : y;
          // EVERY profile position is a step face. Until iteration 9
          // this line was `if (at(ox, oy) !== T_WATER) continue;` and
          // the whole census only ran where the outward tile was open
          // water, so the eight INLAND quays counted zero faces, never
          // asked the curve layer anything, and printed "faces dry
          // ground, which no coast curve describes, so it is drawn as it
          // lies" — of edges the BANK chain covers at every position.
          // `evidence/iter7/curve-cover.mjs` measured it: 741 positions
          // over the 24 edges, 376 coast, 197 bank, 168 on no chain, and
          // of the 168 all but 19 were the four bridge decks that
          // iteration 8 has since given a chain of their own. An outline
          // face is there whatever is on the far side of it; what
          // decides whether it is DRAWN is the curve layer, not the
          // material beyond.
          faces++;
          if (at(ox, oy) === T_WATER) onWater++;
          if (onCurve(x, y) || onCurve(ox, oy)) dissolved++;
        }
        const meanTread = span / count;
        const midP = s.at + span / 2;
        const mx = byColumn ? s.ox + midP : (s.v0 + s.v1) / 2;
        const my = byColumn ? (s.v0 + s.v1) / 2 : s.oy + midP;
        const [cx, cy, cw] = crop(mx, my, span, W, H);
        out.push({
          sig: 'built-staircase',
          x: cx,
          y: cy,
          w: cw,
          severity: meanTread >= 3 ? 'high' : 'med',
          rank: span * meanTread,
          mag: magOf(span - count), // tiles of flat tread beyond the one tile a half-tile bevel can reach
          // The drawn part of that tread, in the same tiles: the tread
          // scaled by the share of step faces no curve covers. `mag` is
          // untouched — the steps are in the tile plane whatever is
          // painted over them, and collision still reads the tile mask
          // (§45.5) — so this is a second number beside it, never a
          // discount on it.
          drawn: faces === 0 ? magOf(span - count) : Math.round(magOf(span - count) * ((faces - dissolved) / faces)),
          profile: { span, faces, dissolved },
          reason: `${label} edge at ${Math.round(mx)},${Math.round(my)} climbs ${count} treads averaging ${meanTread.toFixed(1)} tiles over ${span} tiles — a half-tile bevel only reaches a 1-tile tread. ${faces === 0 ? 'Its outline could not be profiled, so nothing is known about whether it is drawn' : dissolved === faces ? `All ${faces} of its step faces (${onWater} onto open water, ${faces - onWater} onto dry ground) lie on a curve layer — coast, bank or deck — which all three painters cut against the chord, so NONE of this staircase is drawn` : `${faces - dissolved} of its ${faces} step faces (${onWater} onto open water, ${faces - onWater} onto dry ground) lie on no curve at all and are drawn square`}`,
        });
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
/* 8d. landuse-staircase — the land-use fill nothing repaints          */
/* ------------------------------------------------------------------ */

/**
 * The share of a chain's step faces that has to lie on NO curve layer before
 * this signature will call the boundary drawn square.
 *
 * Half, and the number is doing real work rather than picking a threshold: a
 * woodland edge that runs down to the waterline has its last few faces on the
 * coast chain, and refusing the whole chain for those would silence the wood
 * because of the beach. Above a half the boundary the eye follows is the tile
 * edge; below it, it is the curve, and this declines to judge.
 */
const LANDUSE_UNCOVERED = 0.5;

/**
 * The smallest patch whose outline is the land-use fill rather than a copse.
 *
 * 60, the same floor `built-staircase` puts on a component, and taken from
 * there rather than picked: below it a "wood" is a handful of trees, its
 * outline is noise, and the countryside is full of them by design —
 * `edge-notch` says in as many words that a lone tree in a meadow is the
 * texture of the country and not a defect.
 */
const LANDUSE_MIN_PATCH = 60;

/**
 * A LAND-USE boundary drawn as raw tile squares, because no curve layer
 * repaints it.
 *
 * WHY IT EXISTS. Ten iterations of this loop optimised a detector that could
 * not see this, and the final visual review found it by rendering the city and
 * looking: `evidence/final-review/islet-zoom.png` at 20 px/tile is a smoothly
 * curved coastline with a perfect tile staircase of woodland inside it, and
 * `causeway-end.png` is the same thing as literal green rectangles on a spit.
 * It is the commissioner's own complaint — "squares from the pixel based map"
 * — in the land-use fill. `built-staircase` does not scan it because its kinds
 * are BUILT edges (quay, deck, yard, runway) and a `TREES`/`FIELD` boundary is
 * none of them; `shore-staircase` does not, because it asks the shipped coast
 * polyline about a boundary that has no polyline.
 *
 * The islet in that picture is the one at 320,723 and this signature reports
 * it at crop `317,720,26`; the spit in `causeway-end.png` is covered by the
 * findings at `600,578,30` and `582,604,33`. Those crops are the check a
 * reader should run first — a signature that cannot be pointed at the
 * photograph that motivated it has not been calibrated, it has been asserted.
 *
 * WHAT THE DISCRIMINATOR IS, AND WHAT IT IS NOT. The review's first probe for
 * this counted axis-aligned boundary runs of 3+ tiles and expected the coast
 * to score low as a control. It did not — its own figures were woodland 8,135
 * tiles against a coastline of 1,946 with a longest run of 46, nearly as
 * staircased — because BOTH are tile masks and a tile mask has no other shape
 * available. This tool's own census, on its own definitions, says it harder
 * still: **the coastline is the WORSE staircase in the tile plane.** The
 * numbers are not quoted here, because a figure copied into a comment is how
 * this loop has repeatedly published a measurement of a state that had already
 * moved; `--selftest`'s land-use control prints both, measured on the bake in
 * front of it, every run.
 *
 * So: **the tile plane cannot tell the two apart, and a signature built on it
 * would simply re-report the coastline** — which is the one boundary on this
 * map that is drawn correctly. What separates them is entirely in the DRAWING:
 * the coast has `shoreChains`, the shore band has its own, the bridge decks
 * got one in iteration 8 (`deckCut.ts`), and the bevel plane cuts the soft
 * natural edges on the diagonal — so a painter is already cutting those
 * boundaries against a chord and the steps never reach the screen. The
 * woodland edge has NONE of the four, and `bevel.ts` says why in as many
 * words: "Woodland edges inland are left square too, for now — the 3D canopy
 * is a box, and opening its corner to walkers would let them vanish under it".
 * That "for now" is what the visual review photographed.
 *
 * So this signature measures its own drawing, the way iterations 8 and 9 taught
 * `built-staircase` to, and puts the census in the gate as well as in `drawn`:
 * a chain whose faces are mostly ON a curve layer is not reported at all,
 * which is what keeps the coastline out of it. `landuseCoastControl` in the
 * selftest runs this same walk over the WATER/land boundary and shows it
 * silent there, then removes the chains and shows the identical boundary
 * firing — the tile plane held constant across both halves.
 *
 * WHICH COLUMN IT LANDS IN, since that is the question a new signature has had
 * to answer since iteration 9, and this one is a DRAWING defect so the answer
 * is worth spelling out.
 *
 * SCORE, in full. The steps are in the tile plane: the `TREES` mask is what
 * steps, and it is the mask everything downstream is built from — `bevel.ts`
 * declines to soften it precisely because the 3D canopy is a box standing on
 * those tiles. A renderer change could expose or hide them tomorrow without
 * one tile of ground moving, which is exactly the case iteration 9 made for
 * keeping such tiles in SCORE.
 *
 * And DRAWN at very nearly the same figure — 90% of it on the shipped bake —
 * because almost nothing repaints it. **That near-equality is the finding, and
 * it is measured rather than defaulted.** Every other signature's DRAWN equals
 * its SCORE because nothing asked; this one's equals it because something
 * asked and the answer came back "no painter". `built-staircase` runs the same
 * census over built edges and gets the opposite answer — 97% repainted, 3.8
 * weighted tiles of 135 visible — so the two of them together are what make
 * the column mean anything at all.
 *
 * It is also what makes the eventual fix legible in advance. Give the land-use
 * boundary a curve layer the way §45 gave the deck one and DRAWN falls while
 * SCORE holds — a repaint, priced as a repaint, which is what iteration 8 did
 * for the decks with no way to see it. Smooth the mask itself and both fall
 * together — a repair. The two columns tell a reader which happened, which is
 * the whole reason iteration 9 split them.
 *
 * `mag` is TILES OF BOUNDARY lying in a flat run of two or more: the length of
 * tile edge a reader can see is a tile edge. A single-tile step is counted
 * where `built-staircase` would excuse it, and the difference is the bevel —
 * a built edge gets a half-tile chamfer on its one-tile steps and a land-use
 * edge gets nothing, which `bevel.ts` states outright. It is a length, in
 * tiles, like `road-deadend`'s and `course-unbuilt`'s.
 */
function landuseStaircase(
  a: Audit,
  minMag: number,
  cut: { label: string; inside: (t: number) => boolean; outside: (t: number) => boolean },
  smoothed: (x: number, y: number) => boolean,
): Finding[] {
  const { W, H, tiles, at } = a;
  const out: Finding[] = [];
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < tiles.length; i++) mask[i] = cut.inside(tiles[i] as number) ? 1 : 0;
  const FACE: Array<[number, number]> = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  for (const bag of components(mask, W, H)) {
    if (bag.length < LANDUSE_MIN_PATCH) continue;
    const b = bbox(bag, W);
    const inBag = new Set(bag);
    // The component's boundary, counted ONCE and independently of the run
    // walk below, so `profile.span` is not the same variable as
    // `profile.faces` and the control comparing them can actually fail. A
    // control whose two sides come from one assignment passes on `0 === 0`,
    // which is how one agent's selftest in this exercise planted no defects
    // and reported green.
    let perimeter = 0;
    for (const i of bag) {
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of FACE) if (cut.outside(at(x + dx, y + dy))) perimeter++;
    }
    let faces = 0;
    let dissolved = 0;
    let mag = 0;
    let bestRun = 0;
    let bestX = 0;
    let bestY = 0;
    for (const [dx, dy] of FACE) {
      // A face pointing north or south lies in a run ALONG x; one pointing
      // east or west lies in a run along y.
      const alongX = dx === 0;
      const u0 = alongX ? b.y0 : b.x0;
      const u1 = alongX ? b.y1 : b.x1;
      const v0 = alongX ? b.x0 : b.y0;
      const v1 = alongX ? b.x1 : b.y1;
      for (let u = u0; u <= u1; u++) {
        let run = 0;
        for (let v = v0; v <= v1 + 1; v++) {
          const x = alongX ? v : u;
          const y = alongX ? u : v;
          const on =
            v <= v1 && inBag.has(y * W + x) && cut.outside(at(x + dx, y + dy));
          if (on) {
            run++;
            faces++;
            if (smoothed(x, y) || smoothed(x + dx, y + dy)) dissolved++;
            continue;
          }
          if (run >= 2) {
            mag += run;
            if (run > bestRun) {
              bestRun = run;
              bestX = alongX ? v - run / 2 : u;
              bestY = alongX ? u : v - run / 2;
            }
          }
          run = 0;
        }
      }
    }
    if (faces === 0 || mag < minMag) continue;
    const uncovered = (faces - dissolved) / faces;
    // The gate, and the control's whole subject: a boundary a smoothing layer
    // covers is not drawn as squares whatever the tiles under it do.
    if (uncovered < LANDUSE_UNCOVERED) continue;
    const [cx, cy, cw] = crop(bestX, bestY, bestRun, W, H);
    out.push({
      sig: 'landuse-staircase',
      x: cx,
      y: cy,
      w: cw,
      severity: mag >= minMag * 4 ? 'high' : 'med',
      rank: mag,
      mag: magOf(mag), // tiles of boundary lying in a flat run of 2 or more
      // Measured, not defaulted. See the note above on why this coming out
      // equal to `mag` is the finding rather than an omission.
      drawn: Math.round(magOf(mag) * uncovered),
      // `span` is the component's perimeter, counted in its own pass above,
      // and `faces` is what the run walk actually put to the smoothing layer.
      // They are equal when the census asked about the whole boundary, which
      // is what `landuseCoastControl`'s WHOLE leg requires — the reason
      // iteration 9 had to build the equivalent leg for `built-staircase`:
      // a census that quietly asks about a subset reads exactly like a census
      // that found nothing.
      profile: { span: perimeter, faces, dissolved },
      reason: `${bag.length}-tile ${cut.label} whose boundary with open ground carries ${mag} tiles of flat tile edge, longest run ${bestRun}, and ${faces - dissolved} of its ${faces} boundary faces lie on NO smoothing layer at all — no coast, bank or deck chain describes a land-use edge and \`bevel.ts\` excludes T_TREES/T_FIELD in as many words ("woodland edges inland are left square too, for now"), so ${(100 * uncovered).toFixed(0)}% of this outline is drawn as the tile squares it is stored as. The coastline is a tile mask too and steps at least as much, and none of ITS steps reaches the screen — \`--selftest\`'s land-use control measures both, on this bake, rather than quoting a figure that can go stale`,
    });
  }
  out.sort((p, q) => q.rank - p.rank);
  return out;
}

/**
 * The land-use cut this signature reports on: the open-country wood fill.
 *
 * `T_PARK` is deliberately not the inside material. Parkland is laid inside a
 * block and its square edge is the BLOCK's edge, which §15.4 says stays square
 * on purpose — the same excuse `built-staircase` grants a quay. This asks only
 * about the open-country fill, where nothing authored the squareness.
 */
const LANDUSE_CUT = {
  label: 'wood',
  inside: (t: number): boolean => t === T_TREES,
  outside: (t: number): boolean => t === T_FIELD || t === T_PARK || t === T_SAND,
};

/** The coastline, as the SAME question asked of a boundary that IS repainted. */
const COAST_CUT = {
  label: 'landmass',
  inside: (t: number): boolean => t !== T_WATER,
  outside: (t: number): boolean => t === T_WATER,
};

/**
 * Every layer a painter smooths a boundary with: the three curve chains, and
 * the half-tile bevel plane (§15).
 *
 * The bevel is in here and not in `built-staircase`'s `onCurve` because the
 * two signatures are asking about different edges. A built edge gets no bevel
 * — `bevel.ts` says quays, decks and cliffs stay square because squareness is
 * what makes them read as built — so adding it there would change nothing and
 * claim something. A NATURAL edge is exactly what the bevel plane is for, and
 * a land-use signature that ignored it would report a bevelled water/meadow
 * step as drawn square when the renderer has already cut it on the diagonal.
 */
function smoothLayer(
  city: BakedCity,
  tiles: Uint8Array,
  W: number,
  H: number,
): (x: number, y: number) => boolean {
  const onCurve = curveLayer(city, tiles, W, H);
  const bev = deriveBevels(tiles, W, H);
  return (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return onCurve(x, y) || bev[y * W + x] !== BEV_NONE;
  };
}

/* ------------------------------------------------------------------ */
/* 8e. bare-corridor — the road that was deleted, in negative space    */
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
          mag: magOf(len * wSpan), // tiles of clearing where the canopy was never put back
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
        mag: magOf(w * h), // tiles of stamped rectangle
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
        mag: magOf(1), // one tile of confetti: here the count IS the magnitude
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
      mag: magOf(list.length * (med - cell)), // tiles of block area beyond the cross streets the authored pitch implies
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
 * stale, and the current reading is **85.3%** (WORLDGEN.md §45).
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
 * median — city-wide 85.3%, not 76.1% (WORLDGEN.md §45). The two lumps are
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
      mag: magOf(r - (covered[di] as number)), // tiles of carriageway with no course over them
      reason: `${d.name}: ${(100 * rate).toFixed(1)}% of ${r} carriageway tiles lie under a course (${courses[di]} courses), against a ${(100 * median).toFixed(1)}% median borough — ${r - (covered[di] as number)} tiles that the kerb casing, the junction punch-out, the ribbon markings, the follower and the kerb bevel all skip, because every one of them is keyed on courses. Missing COURSES, not missing paint: bare tarmac still gets per-tile lane marks`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 12b. course-unbuilt — the road the plan draws and the bake never laid */
/* ------------------------------------------------------------------ */

/**
 * A stretch of AUTHORED road course with no carriageway anywhere under it.
 *
 * WHY IT EXISTS, and it is the most expensive omission this loop has made.
 * `citybake --check` has printed six warnings on every single run of every
 * iteration, and every iteration reported "citybake holds at its six warnings"
 * as a PASS CONDITION. They are not six notes: they are **508 tiles of
 * authored road that simply are not there**, on four named roads — The Ring
 * twice, Marsh Causeway, and Coast Road three times. At 20 px/tile
 * (`evidence/final-review/causeway-end.png`) that is two carriageways ending
 * in mid-air with rounded caps, passing within a tile or two of each other
 * over open water and joining nothing; `coastroad-169.png` is a 169-tile span
 * of water with an orphaned capsule of carriageway stranded on the shore where
 * the road gives up. It is the most visually obvious defect on the map and no
 * signature in this file could see it.
 *
 * WHY NOTHING SAW IT. `road-deadend` is the signature that should have: it
 * looks for a carriageway that stops with nothing beyond. It refuses these
 * because it wants a cap facing OPEN GROUND, and these face water — which is
 * exactly what a legitimate quay, ferry slip or pier looks like from the tile
 * plane, and the map has those. **The tile plane cannot tell a refused
 * crossing from a working quay.** What tells them apart is the PLAN: at a quay
 * the authored course stops at the waterline, and here it runs on for another
 * eighty tiles with nothing under it. So this signature reads `plan.roads` —
 * the AUTHORED ROAD POLYLINES, which no other signature here consults; the
 * four that take a plan take it for its district polygons — and asks the map
 * to account for them.
 *
 * It is the bake's own rule, promoted from a warning nobody rendered into a
 * finding with a magnitude and a crop. `cityCheck.ts` §5 already computes
 * exactly this: the same half-width cross-section, the same "shorter than the
 * road is wide is the rasteriser rounding, not a hole" excuse. The arithmetic
 * is reproduced here rather than imported because this tool is a survey
 * instrument that must be able to run against ANY bake through `--data`, and
 * because a detector that agrees with `citybake --check` to the tile is a
 * detector a reviewer can check without trusting either of them:
 * `evidence/iter11-instrument/probe-gaps.mjs` computes it a third time.
 *
 * GATED ON `road.bridges`, which is the plan's own statement that this road
 * may be carried over water. `cityCheck` gates the same way and the reason is
 * worth restating, because the gate hides exactly one thing on the shipped
 * bake and it should be on the record: **Vasco Avenue, 6 tiles at 86,208 ->
 * 87,212** (crop `76,200,26`). Vasco may not bridge, so no crossing was ever
 * refused for it; its polyline strays out over the water where the coast
 * clipped the carve, while the avenue itself runs on unbroken beside it. That
 * last clause is measured, not assumed: `probe-gaps.mjs` walks each gap and
 * reports its furthest point from ANY carriageway, and Vasco's never gets more
 * than **7 tiles** from tarmac while the six warned spans reach **20 to 39**.
 * A gap on a non-bridging road is the polyline being in the wrong place; a gap
 * on a bridging road is a crossing that was refused or never laid. Only the
 * second is a road that is not there — and a reviewer who crops Vasco sees a
 * continuous avenue, which is the definition of a false positive here.
 *
 * `mag` is TILES OF COURSE with no carriageway under them — a length, like
 * `road-deadend`'s, not an area. That is deliberate: it makes the per-finding
 * magnitudes add to 508, the same 508 the bake prints, so the number can be
 * checked against something outside this file. It satisfies the four
 * properties in `magOf`: it falls as carriageway is laid over part of a span
 * while the finding still fires, it falls only when road appears, it is a
 * property of the map and not of the run, and it is in tiles.
 *
 * `drawn` is left at `mag`, per the default: this is MISSING GROUND, not a
 * drawing defect. Nothing is painted over it, because there is nothing there
 * to paint — which is the whole complaint.
 */
function unbuiltCourses(a: Audit, plan: CityPlan): Finding[] {
  const { W, H, at } = a;
  const out: Finding[] = [];
  for (const road of plan.roads) {
    // See the note above: a road the plan does not allow to bridge cannot
    // have had a crossing refused, so a gap on it is the polyline straying
    // off its own tarmac rather than a carriageway that is missing.
    if (!road.bridges) continue;
    const half = road.width / 2;
    for (const course of roadCourses(road)) {
      // Is any tile of the carriageway's CROSS-SECTION built here? The
      // centreline alone is not the question: a road laid within half a width
      // of a shore keeps the landward half of its tiles, and that is a narrow
      // road, not a missing one.
      const built = (x: number, y: number, nx: number, ny: number): boolean => {
        for (let s = -half; s <= half; s += 0.5) {
          const t = at(Math.round(x + nx * s), Math.round(y + ny * s));
          if (t === T_ROAD || t === T_BRIDGE) return true;
        }
        return false;
      };
      interface Gap {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        len: number;
        wet: number;
        n: number;
        fromStart: boolean;
      }
      let gap: Gap | null = null;
      const gaps: Gap[] = [];
      let sampled = 0;
      for (let k = 0; k + 1 < course.length; k++) {
        const [ax, ay] = course[k] as readonly [number, number];
        const [bx, by] = course[k + 1] as readonly [number, number];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        const steps = Math.max(1, Math.ceil(len * 2));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          sampled++;
          if (built(x, y, nx, ny)) {
            gap = null;
            continue;
          }
          if (gap === null) {
            gap = {
              x0: Math.round(x),
              y0: Math.round(y),
              x1: 0,
              y1: 0,
              len: 0,
              wet: 0,
              n: 0,
              fromStart: sampled === 1,
            };
            gaps.push(gap);
          }
          gap.x1 = Math.round(x);
          gap.y1 = Math.round(y);
          gap.len += len / steps;
          gap.n++;
          if (at(Math.round(x), Math.round(y)) === T_WATER) gap.wet++;
        }
      }
      const openEnd = gap;
      for (const g of gaps) {
        // Shorter than the road is wide is the rasteriser rounding, not a
        // hole: a four-tile carriageway on a bend can miss its own centreline
        // by a tile without anything being absent.
        if (g.len <= road.width) continue;
        // Why the road is missing, in the terms the bake decided it — the
        // same three cases `cityCheck.ts` names, so the two agree in wording
        // as well as in number.
        const why =
          g.fromStart || g === openEnd
            ? 'the course begins or ends out in the water, so a deck would have land on one side only'
            : g.len > plan.maxBridgeSpan
              ? `the narrowest crossing here is longer than the plan's maxBridgeSpan of ${plan.maxBridgeSpan}, so trimBridges took the deck back to water`
              : 'no bridge was laid over it at all';
        const wet = g.n > 0 ? g.wet / g.n : 0;
        const [cx, cy, cw] = crop(
          (g.x0 + g.x1) / 2,
          (g.y0 + g.y1) / 2,
          Math.round(Math.hypot(g.x1 - g.x0, g.y1 - g.y0)),
          W,
          H,
        );
        out.push({
          sig: 'course-unbuilt',
          x: cx,
          y: cy,
          w: cw,
          severity: g.len >= plan.maxBridgeSpan ? 'high' : 'med',
          rank: g.len,
          mag: magOf(g.len), // tiles of authored course carrying no carriageway
          reason: `${road.name}: ${g.len.toFixed(0)} tiles of its ${road.width}-wide course carry no carriageway at all, from ${g.x0},${g.y0} to ${g.x1},${g.y1} (${(100 * wet).toFixed(0)}% of it over open water) — ${why}. The tarmac at either end stops with a rounded cap over water, which reads to \`road-deadend\` as a quay; the plan is what says it is not one`,
        });
      }
    }
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

/**
 * Distance from a point to a course's polyline, in tiles.
 *
 * Takes the polyline rather than a `StreetCourse` so the same arithmetic can
 * be asked of an AUTHORED course from `plan.roads` (`quayControl` does), with
 * no cast between two types that only ever share this one field.
 */
function distToCourse(c: { points: ReadonlyArray<readonly [number, number]> }, x: number, y: number): number {
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
 * How much OTHER carriageway an end opens onto: flood the tarmac from the
 * endpoint and count the tiles reached within `reach` steps that are not this
 * street's own paint.
 *
 * `tarmacBeyond` above marches a straight ray, and a straight ray is the wrong
 * instrument on a map whose streets bend. Iteration 12 measured all five of this
 * signature's shipped findings and every one of them has an end where the ray
 * dies within three tiles while the STREET carries on: following the tarmac from
 * #129's two ends gets 71.1 and 34.8 tiles away, #163's 105.3 and 78.6, #362's
 * 86.7 and 78.9 (`evidence/iter12-streets/why-it-fires.txt`). The ray leaves the
 * carriageway; the carriageway does not stop.
 *
 * Walking through the street's own band is allowed only within `D` tiles ALONG
 * the centreline of the end being tested, so an end may step sideways off its own
 * cap but the flood cannot drive the length of the street and out of the far end.
 * The first version of this measure forbade the band outright and its controls
 * caught it: it walls an endpoint in behind its own tarmac, and read `0 / 0` on
 * the ring, which is a road round the entire city.
 */
function endEscape(a: Audit, c: StreetCourse, fromStart: boolean, reach: number): number {
  const pts = c.points;
  const half = c.width / 2 + 0.5;
  const total = courseLength(c);
  const D = Math.min(total / 2, 6);
  const end = (fromStart ? pts[0] : pts[pts.length - 1]) as readonly [number, number];
  /** null impassable; true escaped tarmac; false own paint, walk through it. */
  const kind = (x: number, y: number): boolean | null => {
    if (!isRoad(a.at(x, y))) return null;
    let best = Infinity;
    let arcAtBest = 0;
    let acc = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k] as readonly [number, number];
      const [bx, by] = pts[k + 1] as readonly [number, number];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const seg = Math.sqrt(l2);
      let t = l2 === 0 ? 0 : ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - x - 0.5, ay + dy * t - y - 0.5);
      if (d < best) {
        best = d;
        arcAtBest = acc + seg * t;
      }
      acc += seg;
    }
    if (best > half) return true;
    return (fromStart ? arcAtBest : total - arcAtBest) <= D ? false : null;
  };
  const seen = new Set<number>();
  let frontier: Array<[number, number]> = [];
  const ex = Math.round(end[0]);
  const ey = Math.round(end[1]);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = ex + dx;
      const y = ey + dy;
      if (x < 0 || y < 0 || x >= a.W || y >= a.H || kind(x, y) === null) continue;
      const k = y * a.W + x;
      if (!seen.has(k)) {
        seen.add(k);
        frontier.push([x, y]);
      }
    }
  }
  let out = 0;
  for (let step = 0; step < reach && frontier.length > 0; step++) {
    const next: Array<[number, number]> = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
        const k = ny * a.W + nx;
        if (seen.has(k)) continue;
        const t = kind(nx, ny);
        if (t === null) continue;
        seen.add(k);
        next.push([nx, ny]);
        if (t) out++;
        if (out > 4000) return out;
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * A short street whose course meets no other course at EITHER end, and whose
 * tarmac stops at both ends too.
 *
 * The point of this one is that connectivity cannot see it. The shipped
 * carriageway is a single 4-connected component of 102,059 tiles — measured, in
 * `evidence/iter12-streets/components.txt`, and it breaks into 7 pieces when the
 * bridge tiles are removed, so the flood that says "one" can see a cut — and
 * `checkCity` is satisfied by a street that is reachable. Degree is a different
 * question, and a street whose both ends are terminal is a street with nowhere
 * to go.
 *
 * ITERATION 12 REPLACED THE END TEST AND THE SHIPPED FINDINGS WENT TO ZERO.
 * The old test was `tarmacBeyond` alone: march the STRAIGHT extension of the
 * last segment and call the end a cap if the carriageway runs out within
 * `capReach`. On a map whose streets bend, that measures where the RAY leaves
 * the road, not where the ROAD stops. All five findings on the iteration-11 bake
 * were false positives of exactly this, each one shown three independent ways in
 * `evidence/iter12-streets/`:
 *
 *   #129 669,153  #163 711,282  #362 80,505 — the ray dies in 1-3 tiles at both
 *     ends; following the tarmac gets 34.8-105.3 tiles away from those same
 *     endpoints, and flooding from them reaches 479-2158 tiles of other road.
 *   #298 254,568 — its EAST end is a genuine cap, two tiles short of the ring
 *     (the ring shave, WORLDGEN.md §14.3 D6, which `road-stops-short` settled in
 *     iteration 9). Its west end opens onto 656 tiles.
 *   #272 469,361 — the islet this comment used to name as the signature's own
 *     designed control, "a fully painted street with a cap at each end, entered
 *     only by leaving Kelvin Bridge sideways at mid-span". The tile dump refutes
 *     that (`dump-272-islet-wide.txt`): it is a spur off a ring road round a
 *     lagoon on the headland, its north end opens onto 182 tiles of that loop,
 *     and only its south end — the tip of the peninsula — is a cap.
 *
 * So the cap test is now `tarmacBeyond` AND `endEscape`: the ray must die AND
 * the end must open onto no more than `capEscape` tiles of other carriageway.
 * `--selftest` still plants a 3-wide street in open field 300 tiles from
 * anything and this still fires on it, which is what says the signature was
 * narrowed rather than switched off.
 *
 * It stays in `NOISY`. The weight costs nothing at zero findings, and a
 * signature demoted the moment it goes quiet is a signature nobody re-reads
 * when it speaks again.
 */
function streetsServingNothing(
  a: Audit,
  city: BakedCity,
  maxLen: number,
  capReach: number,
  capEscape: number,
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
    // ...and the ray dying is not enough: the end must also open onto nothing.
    const e0 = endEscape(a, c, true, 60);
    const e1 = endEscape(a, c, false, 60);
    if (e0 > capEscape || e1 > capEscape) continue;
    const [cx, cy, cw] = crop((p0[0] + q1[0]) / 2, (p0[1] + q1[1]) / 2, Math.ceil(len), a.W, a.H);
    out.push({
      sig: 'street-serves-nothing',
      x: cx,
      y: cy,
      w: cw,
      severity: b0 + b1 <= 2 ? 'med' : 'low',
      rank: 40 - len,
      mag: magOf(len * c.width), // tiles of tarmac in a street with nowhere at either end
      reason: `${len.toFixed(1)}-tile ${c.kind} from ${p0[0].toFixed(0)},${p0[1].toFixed(0)} to ${q1[0].toFixed(0)},${q1[1].toFixed(0)} meets no other centreline at either end, its tarmac stops ${b0} and ${b1} tile(s) past them, and flooding the carriageway from those two ends reaches only ${e0} and ${e1} tiles of any OTHER road — a street whose both ends are terminal. Connectivity cannot see it: the carriageway is one component, so this IS reachable`,
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
/** Above this share of built tiles, the lanes have something to serve. */
const BUILT_SHARE = 0.01;

/**
 * The three gates, in one place, because `--selftest`'s half-fix control has
 * to pick a region this signature ACTUALLY fires on. Its first draft picked
 * the biggest fringe region by road tiles and got 627,380-706,536, which is
 * over the land and road gates and under neither of the findings — so lifting
 * half its carriageway moved nothing and the control read BLIND. A control
 * that selects by different rules than the detector is not a control.
 */
function firesLanes(f: Fringe, minLand: number, minRoadShare: number): boolean {
  return f.land >= minLand && f.road / f.land >= minRoadShare && f.built / f.land < BUILT_SHARE;
}

function lanesServingNothing(
  a: Audit,
  plan: CityPlan,
  minLand: number,
  minRoadShare: number,
): Finding[] {
  const out: Finding[] = [];
  for (const f of fringeRegions(a, plan)) {
    if (!firesLanes(f, minLand, minRoadShare)) continue;
    const roadShare = f.road / f.land;
    const span = Math.max(f.x1 - f.x0 + 1, f.y1 - f.y0 + 1);
    const [cx, cy, cw] = crop((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, span, a.W, a.H);
    out.push({
      sig: 'lanes-serving-nothing',
      x: cx,
      y: cy,
      w: cw,
      severity: f.built === 0 ? 'high' : 'med',
      rank: f.road,
      mag: magOf(f.road), // tiles of carriageway on land no district polygon claims
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

/**
 * The bake's wildness field, asked the way `bake.ts` asks it.
 *
 * `bake.ts:55` and `bake.ts:609`:
 *
 *     const WILD_SEED = 0x7009d5;
 *     const wildAt = (tx, ty) => fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52;
 *
 * This is the ONE rule that decides whether a tile of rural country is wood or
 * meadow. `fbm` itself is imported rather than reimplemented; the seed, the
 * wavelength and the threshold are three numbers copied from a file this tool
 * is not allowed to import from, and a copy can drift. `wildFieldControl` in
 * the selftest is the guard against that drift: it holds this predicate
 * against the shipped ground INSIDE rural blocks, where the fill certainly
 * ran, and fails if the agreement falls anywhere near chance. Change either of
 * these two constants and that control goes red on the next run.
 */
const WILD_SEED = 0x7009d5;
const WILD_GATE = 0.52;
function wildAt(tx: number, ty: number): boolean {
  return fbm(WILD_SEED, tx / 22, ty / 22) >= WILD_GATE;
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
  /** Tiles of this region the wildness field calls WOOD. */
  wild: number;
  /**
   * Tiles the wildness field calls wood and that are not wood on the ground:
   * the only tiles in this region on which the rural fill's own rule and the
   * shipped raster DISAGREE. Zero of them means the fill was asked and said
   * meadow, which is not a defect. See `baldCountry`.
   */
  wildBare: number;
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
      wild: 0,
      wildBare: 0,
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
      if (wildAt(x, y)) {
        f.wild++;
        if (tiles[i] !== T_TREES) f.wildBare++;
      }
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
 * **THE FIELD IS ASKED HERE NOW (iteration 9), and that is a correction.**
 * Iterations 4 to 8 shipped this comment instead:
 *
 *   > Its one hit on the shipped bake is a false positive, and a measured one.
 *   > The 507-tile marsh islet at 322,740 is meadow throughout against a rural
 *   > block next to it that is 50.8% wood — but `bake.ts`'s own wildness field
 *   > says meadow on ALL 507 of those tiles, so the fill declined on purpose
 *   > rather than never being asked. Nothing a raster audit can see
 *   > distinguishes those two, which is the honest limit of this signature.
 *
 * The first half was right and iteration 8 proved it at the source: all 507
 * tiles WERE walked by the blockless-country pass and all 507 came back
 * `meadow`, and city-wide zero of 7,549 blockless rural tiles went unasked
 * (`evidence/iter8-country/`). The second half was wrong. The audit is not
 * confined to the raster — `bake.ts`'s field is arithmetic on two integers,
 * so this tool can ask it directly, and a signature that names ground the
 * fill "was never asked" about has no business firing on ground where the
 * fill's own rule says meadow.
 *
 * So the gate: **a region is refused when not one of its tiles is bare where
 * the wildness field says wood** (`wildBare === 0`). Zero, not a fraction: it
 * is not a tuning parameter but a statement that the raster and the rule agree
 * everywhere in this region, and one tile of disagreement is enough to keep
 * the finding. It cannot suppress ground the fill never visited, because
 * ground the fill never visited keeps the ground pass's meadow on every tile
 * including the ones the field wanted wooded — that is what "never asked"
 * means, and it is what the `unasked-country` control in `--selftest` plants.
 *
 * On every bake the loop has, it removes exactly the Marsh End islet at
 * 322,740 and nothing else: one hit of one on the four bakes from iteration 4
 * on, and one of four on the pre-iteration-3 calibration asset at `e3306c8~2`,
 * where the surviving three carry 661, 203 and 73 tiles of real disagreement
 * between the field and the ground.
 *
 * COST: SCORE and TOTAL both fall without the map changing, so the loop's
 * series is discontinuous at iteration 9. Both series, over every bake, are
 * restated in `evidence/iter9-instrument/history.txt`.
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
    // The fill's own rule, before the neighbours' rate is used as a proxy for
    // it. Not one tile bare where the field says wood means this ground was
    // asked and answered, whatever the block next door happens to look like.
    if (f.wildBare === 0) continue;
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
      mag: magOf(f.land * (inside - outside)), // tiles of wood the fill would have planted at the neighbouring blocks' own rate and did not
      reason: `${name} ${f.x0},${f.y0}-${f.x1},${f.y1}: ${f.land} tiles of country no block covers are ${(100 * outside).toFixed(1)}% wood, against ${(100 * inside).toFixed(1)}% in the ${f.nbLand} tiles of country inside the ${f.nbBlocks} rural block(s) next to them (${ratio.toFixed(2)}x), and ${f.wildBare} of them are bare where the wildness field itself says wood — the rural fill runs over BLOCKS, so ground outside every block was never asked what it is and keeps the bare meadow the ground pass wrote`,
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
          mag: magOf(len * wide), // tiles of slot cut with a ruler
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
  'landuse-staircase',
  'bare-corridor',
  'patch-square',
  'edge-notch',
  'fabric-coarse',
  'course-coverage-outlier',
  'course-unbuilt',
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
  /**
   * What counts as this plant having worked, if "one more finding, and a
   * bigger magnitude" is the wrong question to ask on some bake.
   *
   * Exactly one plant needs this and the reason is worth stating, because the
   * temptation is to loosen the default instead. `country-outside-blocks` can
   * only gain a finding on a bake that still has a QUIET eligible region to
   * spoil. On the pre-iteration-3 calibration bake — the one bake where this
   * defect is known present — every region with a comparator already fires, so
   * there is nothing left to make fire and the count cannot move. Deepening one
   * is then the only defect available, and a magnitude that rises while the
   * count holds is exactly the state iteration 5 proved the count cannot see.
   * The plant says which of the two it staged; the checker does not guess.
   */
  accept?: (before: number, after: number, magBefore: number, magAfter: number) => boolean;
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
  // Set by the `country-outside-blocks` plant: true when the bake had no quiet
  // eligible region left and the plant deepened a firing one instead.
  let countryDeepen = false;
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
        // The meadow has to be clear for CAP_LOOKAHEAD tiles PAST the cap, not
        // just up to it. `deadEnds` looks six tiles straight on for the next
        // carriageway and, if it finds one, files the cap as `road-stops-short`
        // instead — a different signature, so this plant reads SILENT.
        //
        // That is not hypothetical. Until iteration 9 this asked for a 16-deep
        // meadow behind a 14-tile street, clearing only three tiles past the
        // cap, and it worked by luck. Iteration 6's rebake moved two blocks,
        // which re-rolled land use city-wide, which moved `findMeadow`'s first
        // answer from 459,312 to 439,313 — where the coast road runs across the
        // plant's line five tiles below the cap. From `ce3189b` onwards this
        // control has read `SILENT 4 -> 4` and `--selftest` has exited 1, on
        // iterations 6, 7 and 8, without anyone reading it. The plant was
        // wrong, not the detector: the defect it laid was a real
        // `road-stops-short`, which is why `road-stops-short` read 13 -> 16
        // when its own plant adds two.
        //
        // Depth is 14 of street + 6 of lookahead + 2 of margin.
        const [x, y] = findMeadow(base, 5, 14 + CAP_LOOKAHEAD + 2, 80);
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
      sig: 'course-unbuilt',
      where: 'the carriageway lifted out from under a built stretch of an authored bridging road',
      apply: (t, W, _at, plan, base) => {
        // Anchored to the SIGNATURE's own gate, not to a coordinate: a gap
        // counts once it is longer than the road is wide, so the plant lifts
        // four road-widths of carriageway out. Iteration 9's lesson is that a
        // plant pinned to a place drifts when the map moves under it.
        for (const road of plan.roads) {
          if (!road.bridges) continue;
          const need = Math.ceil(road.width * 4);
          const clear = Math.ceil(road.width * 5);
          const half = road.width / 2;
          for (const course of roadCourses(road)) {
            // Resample the course at one tile a step so a window is a length.
            const pts: Array<[number, number, number, number]> = [];
            for (let k = 0; k + 1 < course.length; k++) {
              const [ax, ay] = course[k] as PlanPoint;
              const [bx, by] = course[k + 1] as PlanPoint;
              const len = Math.hypot(bx - ax, by - ay);
              if (len === 0) continue;
              const nx = -(by - ay) / len;
              const ny = (bx - ax) / len;
              for (let s = 0; s < len; s++) {
                const u = s / len;
                pts.push([ax + (bx - ax) * u, ay + (by - ay) * u, nx, ny]);
              }
            }
            const isBuilt = (p: [number, number, number, number]): boolean => {
              for (let s = -half; s <= half; s += 0.5) {
                if (isRoad(base.at(Math.round(p[0] + p[2] * s), Math.round(p[1] + p[3] * s)))) return true;
              }
              return false;
            };
            // A window that is built, with `clear` built samples either side,
            // so the new gap is a NEW finding and not an old one grown.
            for (let i = clear; i + need + clear < pts.length; i++) {
              let ok = true;
              for (let k = i - clear; k < i + need + clear && ok; k++) {
                if (!isBuilt(pts[k] as [number, number, number, number])) ok = false;
              }
              if (!ok) continue;
              for (let k = i; k < i + need; k++) {
                const [x, y, nx, ny] = pts[k] as [number, number, number, number];
                for (let s = -road.width; s <= road.width; s += 0.5) {
                  const tx = Math.round(x + nx * s);
                  const ty = Math.round(y + ny * s);
                  if (tx < 0 || ty < 0 || tx >= W || ty >= base.H) continue;
                  if (isRoad(t[ty * W + tx] as number)) t[ty * W + tx] = T_FIELD;
                }
              }
              const [sx, sy] = pts[i] as [number, number, number, number];
              return [Math.round(sx), Math.round(sy)];
            }
          }
        }
        throw new Error('no built stretch of an authored bridging road to lift the tarmac from');
      },
    },
    {
      sig: 'landuse-staircase',
      where: 'a wood stamped into a meadow with a 5-tile-tread staircase down one side',
      apply: (t, W) => {
        // The same geometry the `built-staircase` plant uses, in TREES rather
        // than LOT, so the two signatures are staged identically and the only
        // difference between them is the material — which is the whole claim.
        const [x, y] = findMeadow(base, 45, 15, 0);
        for (let s = 0; s < 8; s++) {
          for (let dx = 0; dx < 5; dx++) {
            for (let dy = 0; dy < 6; dy++) t[(y + s + dy) * W + x + s * 5 + dx] = T_TREES;
          }
        }
        return [x, y];
      },
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
        //
        // The region has to be one the WILDNESS FIELD wants partly wooded, and
        // the wildest such rather than the biggest outright. Since iteration 9
        // the signature refuses a region on which the field and the raster
        // agree everywhere, so stripping the wood off ground the field calls
        // meadow throughout lays no defect at all — it lays the false positive
        // that was just removed. That is not hypothetical either: picking by
        // land alone read `SILENT 3 -> 3` on the pre-iteration-3 calibration
        // bake, the one bake where this defect is known to be present, while
        // still passing on the shipped one.
        //
        // Prefer a QUIET such region, so the plant makes a finding appear. If
        // the bake has none — every eligible region already firing, which is
        // what the calibration bake looks like — deepen the wildest one that
        // does fire and let `accept` ask for a magnitude instead of a count.
        let best: Orphan | null = null;
        let quiet: Orphan | null = null;
        for (const f of orphanCountry(base, plan)) {
          if (f.land < GATES.orphanLand || f.nbLand < NEIGHBOUR_MIN_COUNTRY) continue;
          if (f.wild < 40) continue;
          const inside = f.nbWood / f.nbLand;
          const fires =
            inside >= NEIGHBOUR_MIN_WOOD && f.wood / f.land < GATES.orphanWood * inside && f.wildBare > 0;
          if (best === null || f.wild > best.wild) best = f;
          if (!fires && (quiet === null || f.wild > quiet.wild)) quiet = f;
        }
        countryDeepen = quiet === null;
        best = quiet ?? best;
        if (best === null) throw new Error('no stretch of wild orphan country to spoil');
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
      accept: (before, after, magBefore, magAfter) =>
        countryDeepen ? after === before && magAfter > magBefore : after > before && magAfter > magBefore,
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
    const clean = run(city, plan, new Set([p.sig])).filter((f) => f.sig === p.sig);
    const spoilt = run(dirty, plan, new Set([p.sig])).filter((f) => f.sig === p.sig);
    const before = clean.length;
    const after = spoilt.length;
    const magBefore = clean.reduce((s, f) => s + f.mag, 0);
    const magAfter = spoilt.reduce((s, f) => s + f.mag, 0);
    const fired = after > before;
    // A defect that was added has to make the magnitude bigger too. A
    // signature that fires with no magnitude behind it contributes nothing to
    // the score, so the score would not see it get fixed either.
    const grew = magAfter > magBefore;
    const ok = p.accept ? p.accept(before, after, magBefore, magAfter) : fired && grew;
    if (!ok) broken++;
    const verdict = ok ? (fired ? 'FIRED  ' : 'DEEPER ') : fired ? 'NOMAG  ' : 'SILENT ';
    console.log(
      `# ${pad(p.sig, 18)}  ${verdict}  ${before} -> ${after}` +
        `  m ${magBefore} -> ${magAfter} at ${planted[0]},${planted[1]} — ${p.where}`,
    );
  }
  console.log(
    `# ${broken === 0 ? 'every planted control fired, and every one moved its magnitude' : `${broken} SIGNATURE(S) DID NOT FIRE OR DID NOT MOVE THEIR MAGNITUDE — those numbers mean nothing`}`,
  );
  console.log('# crossing-missing and fabric-coarse are calibrated against the 1469611 bake (--data), not planted');
  if (halfFixControl(city, plan)) broken++;
  if (wildFieldControl(city, plan)) broken++;
  if (unaskedCountryControl(city, plan)) broken++;
  if (drawnControl(city, plan)) broken++;
  if (quayControl(city, plan)) broken++;
  if (landuseCoastControl(city, plan)) broken++;
  if (broken > 0) process.exitCode = 1;
}

/**
 * The control for THIS TOOL's own headline defect, and the one thing in here
 * that is not about the city.
 *
 * A plant proves a detector can see a defect appear. It does not prove the
 * instrument can see a defect get SMALLER — and that is exactly what failed:
 * iteration 5 cut 203 carriageway tiles out of the shoulder region and the
 * count read 55 either side, because the region was still over the 10% gate
 * and a count only knows fired from not-fired.
 *
 * So: take the real `lanes-serving-nothing` finding on the shipped map, half
 * fix it — lift out half of its carriageway, which is more than iteration 5
 * managed and still nowhere near the gate — and require that the finding is
 * STILL THERE and its magnitude has FALLEN. Fired-and-smaller is the state
 * the old instrument could not distinguish from fired-and-identical.
 *
 * Returns true if the control failed.
 */
function halfFixControl(city: BakedCity, plan: CityPlan): boolean {
  const sig = 'lanes-serving-nothing';
  const only = new Set([sig]);
  const before = run(city, plan, only);
  console.log('# half-fix control: shrink a real finding without curing it');
  if (before.length === 0) {
    console.log(`# ${pad(sig, 18)}  SKIPPED  nothing fires on this bake, so there is nothing to half fix`);
    return false;
  }
  // The region behind the biggest of them, found the same way the signature
  // finds it so the control and the detector speak about the same tiles.
  const a = buildAudit(city);
  const worst = fringeRegions(a, plan)
    .filter((f) => firesLanes(f, GATES.fringeLand, GATES.fringeRoad))
    .sort((p, q) => q.road - p.road)[0];
  if (!worst) {
    console.log(`# ${pad(sig, 18)}  ERROR    the signature fires but no fringe region matches its gates`);
    return true;
  }
  const tiles = city.tiles.slice();
  const { W, H } = a;
  let lifted = 0;
  const half = Math.floor(worst.road / 2);
  for (let y = worst.y0; y <= worst.y1 && lifted < half; y++) {
    for (let x = worst.x0; x <= worst.x1 && lifted < half; x++) {
      const i = y * W + x;
      if (isRoad(tiles[i] as number)) {
        tiles[i] = T_FIELD;
        lifted++;
      }
    }
  }
  void H;
  const after = run({ ...city, tiles }, plan, only);
  const magBefore = before.reduce((s, f) => s + f.mag, 0);
  const magAfter = after.reduce((s, f) => s + f.mag, 0);
  // Still firing, and smaller. Either half missing is the failure.
  const stillFires = after.length === before.length;
  const shrank = magAfter < magBefore;
  const ok = stillFires && shrank;
  console.log(
    `# ${pad(sig, 18)}  ${ok ? 'SHRANK ' : 'BLIND  '}  ${before.length} -> ${after.length}` +
      `  m ${magBefore} -> ${magAfter} after lifting ${lifted} of ${worst.road} carriageway tiles out of ` +
      `${worst.x0},${worst.y0}-${worst.x1},${worst.y1}`,
  );
  console.log(
    `# ${
      ok
        ? 'a partial fix scores: the count held and the magnitude fell'
        : stillFires
          ? 'THE MAGNITUDE DID NOT MOVE FOR A HALF FIX — the score cannot see partial progress'
          : 'the count moved, so this control tested nothing; pick a deeper half fix'
    }`,
  );
  return !ok;
}

/* ------------------------------------------------------------------ */
/* Iteration 9's three controls, for the two corrections it made        */
/* ------------------------------------------------------------------ */

/**
 * CONTROL 1 — the audit's copy of the wildness field is the bake's field.
 *
 * `wildAt` copies three numbers out of `bake.ts` (the seed, the wavelength and
 * the threshold) because this tool may not import from `shared/src`. A copied
 * constant drifts silently: change `0.52` in the bake and `country-outside-
 * blocks` starts refusing regions for a reason that no longer exists, and
 * nothing fails.
 *
 * So hold the predicate against ground where the fill CERTAINLY ran — country
 * inside a rural block — and require it to agree with the raster far better
 * than chance. It reads 88.3% on the shipped bake and 84-88% on every other
 * bake this loop can still read; a wrong seed or a wrong wavelength drops it
 * to roughly 50%, and a wrong threshold to whatever the two canopy shares
 * happen to be. The gate is 75%: comfortably below the worst honest reading
 * and above anything a broken copy reaches.
 *
 * It is deliberately NOT an exact identity. The fill does not plant every tile
 * the field calls wood — a hedgerow, an orchard row, a smallholding and the
 * ride-through guard all overwrite it — so 100% is not the right answer and
 * demanding it would make this control fire on a correct bake.
 *
 * Returns true if the control failed.
 */
const WILD_AGREE_GATE = 0.75;
function wildFieldControl(city: BakedCity, plan: CityPlan): boolean {
  const a = buildAudit(city);
  const { W, H, tiles } = a;
  const owner = ownerPlane(plan, tiles, W, H);
  const ruralBlockTile = new Uint8Array(W * H);
  for (const b of city.blocks) {
    if (b.rural !== true) continue;
    for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) ruralBlockTile[y * W + x] = 1;
    }
  }
  let n = 0;
  let agree = 0;
  let fieldWood = 0;
  let groundWood = 0;
  for (let i = 0; i < W * H; i++) {
    if (ruralBlockTile[i] === 0) continue;
    if (!isCountry(tiles[i] as number)) continue;
    const d = owner[i] as number;
    if (d < 0 || (plan.districts[d] as { rural?: boolean }).rural !== true) continue;
    const x = i % W;
    const y = (i - x) / W;
    const wants = wildAt(x, y);
    const has = tiles[i] === T_TREES;
    n++;
    if (wants) fieldWood++;
    if (has) groundWood++;
    if (wants === has) agree++;
  }
  const share = n === 0 ? 0 : agree / n;
  const ok = n > 1000 && share >= WILD_AGREE_GATE;
  console.log("# wildness-field control: the audit's copy of bake.ts:609 is bake.ts:609");
  console.log(
    `# ${pad('wildAt', 18)}  ${ok ? 'AGREES ' : 'DRIFTED'}  ${(100 * share).toFixed(1)}% of ${n} country tiles ` +
      `inside rural blocks; field says wood on ${((100 * fieldWood) / Math.max(1, n)).toFixed(1)}%, ` +
      `ground is wood on ${((100 * groundWood) / Math.max(1, n)).toFixed(1)}% (gate ${(100 * WILD_AGREE_GATE).toFixed(0)}%)`,
  );
  if (!ok) {
    console.log('# THE COPIED FIELD CONSTANTS NO LONGER MATCH THE BAKE — country-outside-blocks is refusing');
    console.log('# regions on a rule the city does not use. Re-read WILD_SEED / WILD_GATE against bake.ts.');
  }
  return !ok;
}

/**
 * CONTROL 2 — the `wildBare` gate refuses ground the fill answered, and
 * refuses nothing else.
 *
 * A plant proves a detector sees a defect appear. Iteration 9 did the opposite
 * thing — it made a detector DECLINE — and a plant cannot check that at all.
 * The failure mode of a decline is silent by construction: suppress too much
 * and the signature simply reads zero, which is what a clean city reads.
 *
 * Both halves, on the same bake:
 *
 *  A. The gate is load-bearing. Find a region that clears every OTHER gate
 *     — enough land, a real comparator, bald against it — and that the field
 *     says is meadow throughout. It must be absent from the findings, and it
 *     must be the `wildBare === 0` test that removed it. On the shipped bake
 *     this is the Marsh End islet at 322,740, the false positive iteration 8
 *     measured at the source.
 *
 *  B. The gate is not a blanket. Take a quiet region the field wants PARTLY
 *     WOODED, strip its wood to bare meadow and plant the blocks beside it
 *     solid — ground that was never asked, which is what this signature is
 *     for — and require the finding to appear with `wildBare > 0`. If the
 *     predicate suppresses this too, it is wrong, and this line goes red.
 *
 * B is the one that matters. It is written so that any predicate refusing on
 * the region's SHAPE rather than on the field's ANSWER fails it.
 *
 * Returns true if either half failed.
 */
function unaskedCountryControl(city: BakedCity, plan: CityPlan): boolean {
  const sig = 'country-outside-blocks';
  const base = buildAudit(city);
  const regions = orphanCountry(base, plan);
  console.log('# unasked-country control: refuse what the field answered, keep what it did not');
  let bad = 0;

  // -- A: a region every other gate lets through, that the field calls meadow.
  const wouldFire = (f: Orphan): boolean => {
    if (f.land < GATES.orphanLand || f.nbLand < NEIGHBOUR_MIN_COUNTRY) return false;
    const inside = f.nbWood / f.nbLand;
    if (inside < NEIGHBOUR_MIN_WOOD) return false;
    return f.wood / f.land / inside < GATES.orphanWood;
  };
  const answered = regions
    .filter((f) => wouldFire(f) && f.wildBare === 0)
    .sort((p, q) => q.land - p.land)[0];
  if (!answered) {
    console.log(`# ${pad(sig, 18)}  SKIPPED  no region on this bake is bald AND answered-meadow throughout`);
  } else {
    const fired = run(city, plan, new Set([sig])).some((f) =>
      f.reason.includes(`${answered.x0},${answered.y0}-${answered.x1},${answered.y1}`),
    );
    const ok = !fired;
    if (!ok) bad++;
    console.log(
      `# ${pad(sig, 18)}  ${ok ? 'REFUSED' : 'LEAKED '}  ${answered.x0},${answered.y0}-${answered.x1},${answered.y1}: ` +
        `${answered.land} tiles, ${answered.wood} wood, ${answered.wildBare} bare where the field says wood ` +
        `— every other gate passes it, so ${ok ? 'the field is what silenced it' : 'THE GATE DID NOTHING'}`,
    );
  }

  // -- B: bare ground the field wanted wooded, which is what "never asked" is.
  //
  // The transition is BUILT rather than looked for. The first draft picked a
  // region that was quiet on the shipped bake and spoilt it, which worked
  // there and threw `no quiet region` on the pre-iteration-3 calibration bake,
  // where every region with a comparator already fires — so the control
  // vanished on exactly the bake where the defect is known to be present. Both
  // ends are now written by hand onto the same region, so this runs on any
  // bake: wooded (must be silent), then stripped bare with the blocks beside
  // it planted solid (must fire).
  const victim = regions
    .filter(
      (f) =>
        f.land >= GATES.orphanLand &&
        f.nbLand >= NEIGHBOUR_MIN_COUNTRY &&
        f.nbWood / f.nbLand >= NEIGHBOUR_MIN_WOOD &&
        f.wild >= 40,
    )
    .sort((p, q) => q.wild - p.wild)[0];
  if (!victim) {
    console.log(`# ${pad(sig, 18)}  ERROR    no region with a comparator and wild ground in it to work on`);
    return true;
  }
  const where = `${victim.x0},${victim.y0}-${victim.x1},${victim.y1}`;
  const hits = (t: Uint8Array): boolean =>
    run({ ...city, tiles: t }, plan, new Set([sig])).some((f) => f.reason.includes(where));
  const wildBareIn = (t: Uint8Array): number =>
    orphanCountry(buildAudit({ ...city, tiles: t }), plan).find(
      (f) => f.x0 === victim.x0 && f.y0 === victim.y0 && f.x1 === victim.x1 && f.y1 === victim.y1,
    )?.wildBare ?? -1;

  // Wooded: the region agrees with anything, and there is nothing left bare
  // for the field to disagree with.
  const wooded = city.tiles.slice();
  for (const i of victim.bag) if (isCountry(wooded[i] as number)) wooded[i] = T_TREES;
  const quietOk = !hits(wooded) && wildBareIn(wooded) === 0;

  // Stripped, with the blocks next door planted solid: ground nobody asked.
  const spoilt = city.tiles.slice();
  let stripped = 0;
  for (const i of victim.bag) {
    if (spoilt[i] === T_TREES) stripped++;
    if (isCountry(spoilt[i] as number)) spoilt[i] = T_FIELD;
  }
  for (const bi of victim.nb) {
    const b = city.blocks[bi] as (typeof city.blocks)[number];
    for (let y = Math.max(0, b.y); y < Math.min(base.H, b.y + b.h); y++) {
      for (let x = Math.max(0, b.x); x < Math.min(base.W, b.x + b.w); x++) {
        const i = y * base.W + x;
        if (isCountry(city.tiles[i] as number)) spoilt[i] = T_TREES;
      }
    }
  }
  // Assert the size of the plant before believing anything downstream of it —
  // the seventh blind instrument in this exercise was a control that planted
  // nothing and passed on `0 === 0`.
  const wildBareNow = wildBareIn(spoilt);
  const fired = hits(spoilt);
  const ok = quietOk && wildBareNow > 0 && fired;
  if (!ok) bad++;
  console.log(
    `# ${pad(sig, 18)}  ${
      ok ? 'FIRED  ' : !quietOk ? 'NOSTART' : wildBareNow <= 0 ? 'NOPLANT' : 'BLIND  '
    }  ${where}: wooded -> ${hits(wooded) ? 'fires' : 'silent'} (wildBare 0), then stripped of ` +
      `${stripped} wood -> ${fired ? 'fires' : 'SILENT'} with ${wildBareNow} tiles bare where the field ` +
      `says wood — ${
        ok
          ? 'the gate lets genuinely unasked ground through'
          : !quietOk
            ? 'THE WOODED END ALREADY FIRES, so the transition tested nothing'
            : wildBareNow <= 0
              ? 'THE PLANT LEFT NOTHING FOR THE FIELD TO DISAGREE WITH, so this control tested nothing'
              : 'THE GATE SUPPRESSED A REAL DEFECT'
      }`,
  );
  return bad > 0;
}

/**
 * CONTROL 3 — `drawn` is measured off the curve layer, and off nothing else.
 *
 * `built-staircase` now reports how much of each staircase a renderer puts on
 * the screen, and 537 of its 540 tiles come back invisible. A number that says
 * "almost none of this is drawn" is exactly the shape of a blind instrument:
 * it reads the same as a census that consults nothing and returns zero.
 *
 * Three legs, all on the shipped bake:
 *
 *  A. BOTH ANSWERS ARE PRESENT. At least one finding must read fully drawn and
 *     at least one fully dissolved. A census stuck on either answer fails.
 *
 *  B. TAKE THE CURVES AWAY. Re-run against a city with empty `shores`, `banks`
 *     and `courses`. Every finding must then read fully drawn, and the drawn
 *     total must equal the tile total. If blanking the chains does not move
 *     the number, the census is not reading them.
 *
 *  C. THE DECK CHAIN IS WHAT COVERS THE DECKS. Blank ONLY `courses`, so
 *     `buildDeckCut` has nothing to cut from while the coast and bank chains
 *     stand. The four bridge decks must go from dissolved to drawn and the
 *     quays must not move. That is iteration 8's fix, isolated: before it, the
 *     decks were the drawn part of this signature.
 *
 * Returns true if any leg failed.
 */
function drawnControl(city: BakedCity, plan: CityPlan): boolean {
  const sig = 'built-staircase';
  const only = new Set([sig]);
  const base = run(city, plan, only);
  console.log('# drawn control: the curve layer is what dissolves a staircase');
  if (base.length === 0) {
    console.log(`# ${pad(sig, 18)}  SKIPPED  nothing fires on this bake`);
    return false;
  }
  let bad = 0;
  const mag = base.reduce((s, f) => s + f.mag, 0);
  const drawn = base.reduce((s, f) => s + drawnOf(f), 0);
  const full = base.filter((f) => drawnOf(f) === f.mag).length;
  const none = base.filter((f) => drawnOf(f) === 0).length;
  const okA = full > 0 && none > 0;
  if (!okA) bad++;
  console.log(
    `# ${pad(sig, 18)}  ${okA ? 'SPLIT  ' : 'STUCK  '}  ${base.length} findings, ${mag} tiles, ${drawn} drawn` +
      ` — ${full} fully drawn, ${none} fully dissolved${okA ? '' : ' — A CENSUS WITH ONE ANSWER IS NOT A CENSUS'}`,
  );

  // A0. The census asked about the WHOLE outline. This is the leg that catches
  // a narrowing of it, and it was added because the first four legs did not:
  // restoring the pre-iteration-9 `if (at(ox, oy) !== T_WATER) continue` left
  // `--selftest` GREEN at exit 0 — SPLIT, UNCOVER and DECKS all passed while
  // eight inland quays counted zero faces, asked no chain anything and
  // defaulted to "fully drawn". Four of five red controls firing is four of
  // five; the fifth is the one that had to be built.
  const positions = base.reduce((s, f) => s + (f.profile?.span ?? 0), 0);
  const asked = base.reduce((s, f) => s + (f.profile?.faces ?? 0), 0);
  const unasked = base.filter((f) => (f.profile?.faces ?? 0) !== (f.profile?.span ?? -1)).length;
  const okA0 = base.every((f) => f.profile !== undefined) && unasked === 0 && asked === positions;
  if (!okA0) bad++;
  console.log(
    `# ${pad(sig, 18)}  ${okA0 ? 'WHOLE  ' : 'PARTIAL'}  ${asked} of ${positions} profile positions put to the ` +
      `curve layer across ${base.length} edges, ${unasked} edge(s) asked about less than their whole outline` +
      `${okA0 ? ' — every step face was asked, whatever lies beyond it' : ' — A CENSUS OF PART OF AN EDGE CANNOT SAY WHETHER IT IS DRAWN'}`,
  );

  const bare = run({ ...city, shores: [], banks: [], courses: [] }, plan, only);
  const bareMag = bare.reduce((s, f) => s + f.mag, 0);
  const bareDrawn = bare.reduce((s, f) => s + drawnOf(f), 0);
  const okB = bare.length === base.length && bareMag === mag && bareDrawn === bareMag && bareDrawn > drawn;
  if (!okB) bad++;
  console.log(
    `# ${pad(sig, 18)}  ${okB ? 'UNCOVER' : 'BLIND  '}  with every chain removed: ${bare.length} findings, ` +
      `${bareMag} tiles, ${bareDrawn} drawn (was ${drawn})` +
      `${okB ? ' — nothing is painted over, so all of it is drawn' : ' — REMOVING THE CURVES DID NOT MOVE THE DRAWN COLUMN'}`,
  );

  const noDeck = run({ ...city, courses: [] }, plan, only);
  const deckBefore = base.filter((f) => f.reason.startsWith('bridge deck'));
  const deckAfter = noDeck.filter((f) => f.reason.startsWith('bridge deck'));
  const deckDrawnBefore = deckBefore.reduce((s, f) => s + drawnOf(f), 0);
  const deckDrawnAfter = deckAfter.reduce((s, f) => s + drawnOf(f), 0);
  const deckMag = deckBefore.reduce((s, f) => s + f.mag, 0);
  const quayDrawnBefore = drawn - deckDrawnBefore;
  const quayDrawnAfter = noDeck.reduce((s, f) => s + drawnOf(f), 0) - deckDrawnAfter;
  // NOT `deckDrawnAfter === deckMag`. A few deck positions sit on the COAST
  // chain as well — iteration 7 counted seven of them across the four decks,
  // where a deck meets its own shore — so pulling the deck chain out leaves
  // those still covered. What the leg has to prove is that the deck chain is
  // load-bearing for the decks and inert for everything else, and the residue
  // is printed rather than tolerated silently.
  const okC =
    deckBefore.length > 0 &&
    deckDrawnBefore === 0 &&
    deckDrawnAfter > deckDrawnBefore &&
    quayDrawnAfter === quayDrawnBefore;
  if (!okC) bad++;
  console.log(
    `# ${pad(sig, 18)}  ${okC ? 'DECKS  ' : 'BLIND  '}  with only the deck chain removed: the ${deckBefore.length} ` +
      `bridge decks go ${deckDrawnBefore} -> ${deckDrawnAfter} drawn of ${deckMag} tiles ` +
      `(${deckMag - deckDrawnAfter} still on the coast chain, where a deck meets its own shore), the quays hold at ` +
      `${quayDrawnAfter}${okC ? " — iteration 8's curve is what covers the decks and touches nothing else" : ' — THE DECK CHAIN IS NOT WHAT IS BEING READ'}`,
  );
  return bad > 0;
}

/* ------------------------------------------------------------------ */

/**
 * The control for `course-unbuilt`, and it is the one the brief for this
 * signature named: **plant a genuine pier and confirm the signature stays
 * silent.**
 *
 * The defect this signature reports looks, in the tile plane, exactly like a
 * working quay: a carriageway that runs out over water and stops with a
 * rounded cap. `road-deadend` cannot tell them apart and excuses both, which
 * is why 508 tiles of missing road survived ten iterations of this loop. So
 * the control has to show the discrimination working in BOTH directions on the
 * SAME piece of geometry, or it shows nothing:
 *
 *  - SILENT: a pier — an authored bridging road running out over open water,
 *    with carriageway under the whole of it — draws no finding. A road ending
 *    at water is not a defect.
 *  - FIRES: lift the tarmac off the seaward half of that same pier and the
 *    same course, unchanged, fires with the missing half as its magnitude.
 *
 * The only difference between the two halves is whether the CARRIAGEWAY is
 * there, which is the thing the signature claims to measure.
 *
 * Returns true if the control failed.
 */
function quayControl(city: BakedCity, plan: CityPlan): boolean {
  const sig = 'course-unbuilt';
  const only = new Set([sig]);
  const base = buildAudit(city);
  const W = city.widthTiles;
  const H = city.heightTiles;
  console.log('# quay control: a pier is a road that ends at water, and is not this defect');
  // Anchored to the signature's own gate: a gap must be longer than the road
  // is wide, so half of this pier is three widths clear of it either way.
  const WIDTH = 4;
  const LEN = WIDTH * 8;
  const clearOfCourses = (x: number, y: number): boolean =>
    !plan.roads.some((r) => roadCourses(r).some((c) => distToCourse({ points: c }, x, y) < LEN));
  let site: [number, number, number, number] | null = null;
  for (let y = 4; y < H - 4 && site === null; y++) {
    for (let x = 4; x < W - 4 && site === null; x++) {
      if (base.at(x, y) === T_WATER || isRoad(base.at(x, y))) continue;
      for (const [dx, dy] of DIRS) {
        if (dx !== 0 && dy !== 0) continue;
        // ON the map for its whole length. `at` calls everything off the edge
        // sea — that is the city's own rule and what makes a carriageway
        // running off the edge a quay — so without this the search happily
        // picked a shore 8 tiles from the north edge and ran the pier off the
        // map, where nothing can be built and the whole seaward half is a gap
        // by construction. The control read FALSE+ on a working signature.
        // Caught by this control on its first run, and recorded rather than
        // quietly fixed: iteration 9's `road-deadend` plant failed the same
        // way — the staging was wrong, not the detector — and reading it the
        // other way round is what let a red selftest stand for three
        // iterations.
        const ex = x + dx * (LEN + WIDTH);
        const ey = y + dy * (LEN + WIDTH);
        if (ex < 0 || ey < 0 || ex >= W || ey >= H) continue;
        let wet = true;
        for (let s = 1; s <= LEN + WIDTH && wet; s++) {
          for (let k = -WIDTH; k <= WIDTH && wet; k++) {
            const px = x + dx * s + (dx === 0 ? k : 0);
            const py = y + dy * s + (dy === 0 ? k : 0);
            if (base.at(px, py) !== T_WATER) wet = false;
          }
        }
        if (!wet) continue;
        if (!clearOfCourses(x + dx * LEN * 0.5, y + dy * LEN * 0.5)) continue;
        site = [x, y, dx, dy];
        break;
      }
    }
  }
  if (site === null) {
    console.log(`# ${pad(sig, 18)}  ERROR    no open water to build a test pier in`);
    return true;
  }
  const [x0, y0, dx, dy] = site;
  /** Lay the pier's carriageway from the shore out to `upto` tiles. */
  const pier = (upto: number): Uint8Array => {
    const t = city.tiles.slice();
    for (let s = 0; s <= upto; s++) {
      for (let k = -Math.floor(WIDTH / 2); k <= Math.floor(WIDTH / 2); k++) {
        const px = x0 + dx * s + (dx === 0 ? k : 0);
        const py = y0 + dy * s + (dy === 0 ? k : 0);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        t[py * W + px] = T_BRIDGE;
      }
    }
    return t;
  };
  const road = {
    name: 'Test Pier',
    points: [
      [x0, y0],
      [x0 + dx * LEN, y0 + dy * LEN],
    ] as PlanPoint[],
    width: WIDTH,
    bridges: true,
    curve: false,
    median: 0,
  };
  const withPier: CityPlan = { ...plan, roads: [...plan.roads, road] };
  const before = run(city, plan, only);
  const whole = run({ ...city, tiles: pier(LEN) }, withPier, only);
  const halfBuilt = run({ ...city, tiles: pier(Math.floor(LEN / 2)) }, withPier, only);
  const magOfAll = (f: Finding[]): number => f.reduce((s, g) => s + g.mag, 0);
  const silentOk = whole.length === before.length && magOfAll(whole) === magOfAll(before);
  const firesOk = halfBuilt.length === before.length + 1 && magOfAll(halfBuilt) > magOfAll(whole);
  console.log(
    `# ${pad(sig, 18)}  ${silentOk ? 'SILENT ' : 'FALSE+ '}  a ${LEN}-tile pier at ${x0},${y0} heading ${dirName(dx, dy)} with carriageway under all of it: ` +
      `${before.length} -> ${whole.length} findings, m ${magOfAll(before)} -> ${magOfAll(whole)} — a road that ends at open water with a cap is a quay, not a missing crossing`,
  );
  console.log(
    `# ${pad(sig, 18)}  ${firesOk ? 'FIRED  ' : 'BLIND  '}  the same course with the seaward ${LEN - Math.floor(LEN / 2)} tiles of tarmac lifted off: ` +
      `${whole.length} -> ${halfBuilt.length} findings, m ${magOfAll(whole)} -> ${magOfAll(halfBuilt)} — the carriageway is the only thing that changed`,
  );
  if (!silentOk || !firesOk) {
    console.log(`# ${pad(sig, 18)}  CONTROL FAILED — this signature cannot tell a pier from a hole`);
    return true;
  }
  return false;
}

/**
 * The control for `landuse-staircase`, and it exists because the final visual
 * review's FIRST probe for this defect was wrong and its own control said so.
 *
 * That probe counted axis-aligned boundary runs of 3+ tiles and expected the
 * curve-drawn coastline to score low as a comparison. It did not: woodland
 * 8,135 tiles and coastline 1,946 with a longest run of 46, nearly as
 * staircased — because both are tile masks and a tile mask has no other shape.
 * **The tile plane is not the discriminator.** A signature built on it would
 * re-report the coastline as a defect, and the coastline is the thing on this
 * map that is drawn CORRECTLY.
 *
 * So this control asks the same walk three ways and requires all three:
 *
 *  - COAST: the identical measure over the WATER/land boundary is silent, on
 *    a tile plane every bit as stepped as the woodland's.
 *  - UNCOVER: take the curve layer away and that same coastline fires, with at
 *    least as many tiles as the woodland — the tile plane is held constant
 *    across this leg and the one above, so the only thing that moved is the
 *    drawing. This is the leg that would have refuted the bad probe.
 *  - PAINTED: give the WOODLAND a curve layer over every tile and it goes
 *    silent — so what fires the signature is the absence of a painter, not the
 *    material.
 *
 * Returns true if the control failed.
 */
function landuseCoastControl(city: BakedCity, plan: CityPlan): boolean {
  // The plan is not read here: unlike every other control in this file, this
  // one is entirely about the tile plane and the painters over it. Taken as an
  // argument anyway so the four controls share one shape at the call site.
  void plan;
  const a = buildAudit(city);
  const smooth = smoothLayer(city, a.tiles, a.W, a.H);
  const sum = (f: Finding[]): number => f.reduce((s, g) => s + g.mag, 0);
  const wood = landuseStaircase(a, GATES.minSpan, LANDUSE_CUT, smooth);
  const coast = landuseStaircase(a, GATES.minSpan, COAST_CUT, smooth);
  const coastBare = landuseStaircase(a, GATES.minSpan, COAST_CUT, () => false);
  const woodPainted = landuseStaircase(a, GATES.minSpan, LANDUSE_CUT, () => true);
  console.log('# land-use control: the curve layer is the discriminator, not the tile plane');
  const coastOk = coast.length === 0;
  const bareOk = coastBare.length > 0 && sum(coastBare) >= sum(wood);
  const paintedOk = woodPainted.length === 0;
  // The anti-narrowing leg, the same one iteration 9 had to build for
  // `built-staircase` after four red controls passed a census that had gone
  // blind on eight of its twenty-four edges.
  const positions = wood.reduce((s, f) => s + (f.profile?.span ?? 0), 0);
  const asked = wood.reduce((s, f) => s + (f.profile?.faces ?? 0), 0);
  const partial = wood.filter((f) => (f.profile?.faces ?? 0) !== (f.profile?.span ?? -1)).length;
  const wholeOk =
    wood.length > 0 && wood.every((f) => f.profile !== undefined) && partial === 0 && asked === positions;
  console.log(
    `# ${pad('landuse-staircase', 18)}  ${coastOk ? 'COAST  ' : 'FALSE+ '}  the same walk over the WATER/land boundary: ${coast.length} findings — every one of its boundary faces is on a shore chain, so none of its steps is drawn`,
  );
  console.log(
    `# ${pad('landuse-staircase', 18)}  ${bareOk ? 'UNCOVER' : 'BROKEN '}  with the curve layer taken away, that identical coastline gives ${coastBare.length} findings and ${sum(coastBare)} tiles against woodland's ${wood.length} and ${sum(wood)} — the TILE PLANE says the coast is the worse staircase, which is why a tile-plane measure of this defect is wrong`,
  );
  console.log(
    `# ${pad('landuse-staircase', 18)}  ${paintedOk ? 'PAINTED' : 'BROKEN '}  with a curve layer over every tile, the woodland gives ${woodPainted.length} findings — the absence of a painter is what fires this, not the material`,
  );
  console.log(
    `# ${pad('landuse-staircase', 18)}  ${wholeOk ? 'WHOLE  ' : 'PARTIAL'}  ${asked} of ${positions} boundary faces put to the smoothing layer across ${wood.length} woods, ${partial} asked about less than their whole boundary${wholeOk ? ' — every face was asked, whatever lies beyond it' : ' — A CENSUS THAT ASKS ABOUT A SUBSET AND DEFAULTS THE REST IS NOT A CENSUS'}`,
  );
  if (!coastOk || !bareOk || !paintedOk || !wholeOk) {
    console.log(`# ${pad('landuse-staircase', 18)}  CONTROL FAILED — this signature is reading the tile plane, not the drawing`);
    return true;
  }
  return false;
}

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
  /**
   * Carriageway an end may OPEN ONTO — measured by flooding the tarmac, not by
   * marching a ray — before that end is not a cap. See `endEscape`.
   */
  capEscape: number;
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
  capEscape: 24,
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
  if (want('landuse-staircase')) {
    findings.push(
      ...landuseStaircase(a, GATES.minSpan, LANDUSE_CUT, smoothLayer(city, a.tiles, a.W, a.H)),
    );
  }
  if (want('bare-corridor')) findings.push(...bareCorridors(a, GATES.minLen));
  if (want('patch-square')) findings.push(...squarePatches(a));
  if (want('edge-notch')) findings.push(...edgeNotches(a));
  if (want('fabric-coarse')) findings.push(...coarseFabric(city, plan, GATES.fabric));
  if (want('course-coverage-outlier')) findings.push(...coverageOutliers(city, plan, GATES.coverage));
  if (want('course-unbuilt')) findings.push(...unbuiltCourses(a, plan));
  if (want('street-serves-nothing')) {
    findings.push(...streetsServingNothing(a, city, GATES.serves, GATES.cap, GATES.capEscape));
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

/**
 * Every blockless rural country region, with the numbers
 * `country-outside-blocks` gates on.
 *
 * A diagnostic, not a signature. It exists because iteration 9's gate changed
 * which regions are eligible, and the selftest plant has to pick its victim on
 * what the bake actually contains rather than on whichever region happened to
 * work on the shipped map — the previous plant passed on the shipped bake and
 * planted a false positive on the calibration bake, which is the bake that
 * matters.
 */
function dumpRegions(city: BakedCity, plan: CityPlan): void {
  const a = buildAudit(city);
  const rs = orphanCountry(a, plan).sort((p, q) => q.land - p.land);
  console.log('# blockless rural country regions: land wood wild wildBare | nbLand nbWood | fires?');
  for (const f of rs) {
    if (f.land < 40) continue;
    const inside = f.nbLand > 0 ? f.nbWood / f.nbLand : 0;
    const outside = f.wood / f.land;
    const sized = f.land >= GATES.orphanLand && f.nbLand >= NEIGHBOUR_MIN_COUNTRY;
    const cmp = inside >= NEIGHBOUR_MIN_WOOD;
    const bald = cmp && outside / inside < GATES.orphanWood;
    const name = (plan.districts[f.district] as { name?: string } | undefined)?.name ?? '?';
    console.log(
      `${pad(`${f.x0},${f.y0}-${f.x1},${f.y1}`, 20)} ${pad(name, 14)} ` +
        `land=${String(f.land).padStart(5)} wood=${String(f.wood).padStart(5)} ` +
        `wild=${String(f.wild).padStart(5)} wildBare=${String(f.wildBare).padStart(5)} | ` +
        `nbLand=${String(f.nbLand).padStart(5)} nbWood=${String(f.nbWood).padStart(5)} | ` +
        `${sized ? 'sized' : '-----'} ${cmp ? 'cmp' : '---'} ${bald ? 'bald' : '----'} ` +
        `${sized && bald && f.wildBare > 0 ? 'FIRES' : '.....'}`,
    );
  }
}

function main(): void {
  let dataPath = '';
  let planPath = '';
  let regions = false;
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
    if (key === 'regions') regions = true;
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
  if (regions) {
    dumpRegions(city, plan);
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
        console.log(
          `${pad(f.sig, 18)}  ${pad(`${f.x},${f.y},${f.w}`, 14)}  ${pad(f.severity, 5)}  ${pad(`m=${f.mag}`, 9)}  ${f.reason}`,
        );
      }
      if (bag.length > shown.length) {
        const rest = bag.slice(shown.length).reduce((s, f) => s + f.mag, 0);
        console.log(
          `${pad(sig, 18)}  ${pad('-', 14)}  ${pad('-', 5)}  ${pad(`m=${rest}`, 9)}  ... and ${bag.length - shown.length} more (--all to list)`,
        );
      }
    }
  }
  // Widened from 18 because three signature names are longer than that and
  // pushed their own numbers out of column. With one number a reader could
  // still find it; with three they cannot.
  const SW = 23;
  const row = (name: string, n: string, m: string, sc: string, dr: string, tail = ''): string =>
    `# ${pad(name, SW)}  ${n.padStart(6)}  ${m.padStart(7)}  ${sc.padStart(9)}  ${dr.padStart(9)}${tail}`;
  console.log(row('summary', 'count', 'tiles', 'score', 'drawn'));
  let total = 0;
  let totalTiles = 0;
  let totalScore = 0;
  let totalDrawn = 0;
  for (const sig of ALL_SIGS) {
    if (!want(sig)) continue;
    const bag = bySig.get(sig) ?? [];
    const n = bag.length;
    const m = bag.reduce((s, f) => s + f.mag, 0);
    const d = bag.reduce((s, f) => s + drawnOf(f), 0);
    const sc = m * weightOf(sig);
    const dr = d * weightOf(sig);
    total += n;
    totalTiles += m;
    totalScore += sc;
    totalDrawn += dr;
    console.log(
      row(
        sig,
        String(n),
        String(m),
        sc.toFixed(1),
        dr.toFixed(1),
        NOISY.has(sig) ? `  noisy x${NOISY_WEIGHT}` : '',
      ),
    );
  }
  console.log(row('TOTAL', String(total), String(totalTiles), totalScore.toFixed(1), totalDrawn.toFixed(1)));
  console.log(`# SCORE ${totalScore.toFixed(1)}, in weighted tiles of defect, against TOTAL ${total} candidates.`);
  console.log('# TOTAL is the count, and it was broken on purpose TWICE. Iteration 9 taught');
  console.log('# country-outside-blocks to ask the bake\'s own wildness field, removing a false positive.');
  console.log('# Iteration 11 ADDED two signatures for defects nothing here could see: course-unbuilt,');
  console.log('# the 508 tiles of authored road the bake has warned about on every run since the loop');
  console.log('# began, and landuse-staircase, the land-use fill no painter repaints. So a number from');
  console.log('# iterations 5-10 is on an older instrument and does not compare with one from this.');
  console.log('# Every bake the loop has is restated on THIS instrument in');
  console.log('# evidence/iter11-instrument/history.txt (iteration 9\'s two series are in');
  console.log('# evidence/iter9-instrument/history.txt); the deltas BETWEEN iterations are unchanged,');
  console.log('# because neither correction moved with the map.');
  console.log('# SCORE is what moves when a defect gets SMALLER without going away — which a count cannot see.');
  console.log('# SCORE is an area, so the signature covering the most ground dominates it; a small signature\'s');
  console.log('# progress shows in its own `tiles` column, which is the same measurement unweighted.');
  console.log(`# DRAWN ${totalDrawn.toFixed(1)} is the part of SCORE a renderer actually PUTS ON THE SCREEN.`);
  console.log('# SCORE counts defects in the TILE PLANE — which is also what collision drives against — and');
  console.log('# a defect can be in the tile plane and painted over: a quay stepping every three tiles is');
  console.log('# repainted on a chord by the coast, bank or deck curve and cannot be seen. Those tiles stay');
  console.log('# in SCORE, because a renderer change can expose them again without one tile of ground moving,');
  console.log('# and are subtracted in DRAWN, because a reviewer sent to look at them will see nothing.');
  console.log('# The two differ only where a signature has MEASURED its own drawing, which today is');
  console.log('# `built-staircase` and `landuse-staircase`; every other signature is a defect in the');
  console.log('# ground, and ground is drawn. Those two are the same census pointed at different edges');
  console.log('# and they come out opposite: 97% of the built staircase is repainted and invisible,');
  console.log('# 90% of the land-use staircase is on no painter at all and is what the player sees.');
  console.log('# `landuse-staircase` is the first signature whose SCORE and DRAWN being EQUAL is a');
  console.log('# measurement rather than a default — and the reason a human found it and this did not.');
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

main();
