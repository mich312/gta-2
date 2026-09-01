/**
 * The iteration diff for the visual-map loop.
 *
 * `mapgen` is bit-deterministic — two runs of one command diff to 0 px — so a
 * fixed set of crops rendered every iteration turns "what changed?" into a
 * number instead of a story. Anything non-zero here is a real change to the
 * shipped city, and anything zero is a guarantee that nothing moved.
 *
 *   node ci/mapwatch.mjs <iteration>    render this iteration's watch set
 *   node ci/mapwatch.mjs <n> --diff <m> diff iteration n against iteration m
 *   node ci/mapwatch.mjs --selftest     the control: does the diff still see?
 *   node ci/mapwatch.mjs --tiles-only --tiles-prev a --tiles b   two bakes, no plates
 *
 * Plates land in evidence/watch/iter<n>/. Keep the set FIXED across the loop:
 * a watch crop that moves because you re-aimed it tells you nothing.
 *
 * ## Two readings, and why there have to be two
 *
 * The pixel diff answers HOW MUCH moved. It is the loop's only continuous
 * record back to iteration 1 and it catches things the tile classes cannot —
 * a palette change, a bevel, anything render-only.
 *
 * It cannot answer WHAT moved, and iteration 6 is the proof. The fix closed
 * six street ends in one 192x64 box; the reviewer verified tile by tile that
 * 294 road tiles changed and every one of them was inside it. But the bake
 * changed 969 tiles, because the block count went 1182 -> 1184 and downstream
 * land use is index-coupled to block count, so building and park placement
 * re-rolled city-wide. The watch printed `sunridge 13671 px (2.318%)` and
 * `kelvin 1913 px` and NEITHER WAS ABOUT THE FIX — Sunridge's 216 tiles are
 * `BUILDING->PARK` and `FIELD->BUILDING` with zero road transitions. A reader
 * with only the pixel column would have gone to look at the wrong borough,
 * and every future iteration that moves the block count gets the same wash.
 *
 * So the tile reading sits beside it, from the baked tile planes rather than
 * from pixels: per crop, the carriageway change and the land-use change
 * separately, and then the actual transitions — `BUILDING->PARK 57` next to
 * `FIELD->ROAD 105`. "Did the road network change" is the question this loop
 * asks most iterations, and it is now a column instead of an inference.
 *
 * The tile reading needs the two bakes. Each render snapshots the tile plane
 * beside the plates as `tiles.json` (213 KB), and `--diff` picks both up
 * automatically; for an iteration baked before this existed, hand it the
 * bytes:
 *
 *   git show b5c7805:shared/src/world/city.data.ts > /tmp/iter5.city.data.ts
 *   node ci/mapwatch.mjs 6 --diff 5 --tiles-prev /tmp/iter5.city.data.ts \
 *                                   --tiles      /tmp/iter6.city.data.ts
 *
 * With no bakes to read it says so and prints the pixel table alone, rather
 * than printing a tile table of zeros.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTiles,
  writeTiles,
  writeSnapshot,
  roundTripIsFaithful,
  isCarriageway,
  nameOf,
  T_PARK,
  T_ROAD,
  T_WATER,
} from './citytiles.mjs';

// Six boroughs, the water they meet, and the four places this project has
// already fixed something — those last are regression watches, not surveys.
export const WATCH = [
  ['city',        null,             'the whole map, 2 px a tile'],
  ['ravenhill',   '316,126,96,8',   'Ravenhill — the weave'],
  ['kelvin',      '536,126,96,8',   'Kelvin — tightest streets, alleys'],
  ['sunridge',    '380,484,96,8',   'Sunridge — the southern grid'],
  ['marshend',    '448,614,96,8',   'Marsh End — fringe and airfield'],
  ['portvasco',   '60,305,96,8',    'Port Vasco — across the sound'],
  ['gannet',      '63,602,96,8',    'Gannet Rock — air-only plateau'],
  ['docks',       '20,240,96,8',    'The Docks — contour fabric (A03)'],
  ['strait',      '420,280,96,8',   'the strait crossings (A01)'],
  ['hollis',      '350,400,96,8',   'Hollis Creek (A02)'],
  ['southshore',  '600,570,96,8',   'the south shore and lagoon'],
  ['ringroad',    '300,600,96,8',   'the ring road through open country'],
  ['marshpost',   '524,540,32,20',  'Marsh Post — landmark mass (A04)'],
  ['kelvinbridge','436,336,44,16',  'Kelvin Bridge deck (A01)'],
  ['shoulderb',   '267,312,100,8' , 'region B, the unclaimed shoulder (iter5 reach cut)'],
  ['headlanda',   '393,312,156,8' , 'region A, unclaimed and unfixed (iter5, escalated)'],
];

const MAPGEN = 'server/dist/tools/mapgen.js';
const SHIPPED = 'shared/src/world/city.data.ts';
const SNAP = 'tiles.json';

/**
 * The crop table is the single source of truth for what is watched, so the
 * tile reading derives its rectangles from the SAME strings the renderer
 * passes to `mapgen --crop`. `mapgen` reads `x,y,w[,h]` with h defaulting to
 * w; the fourth field here is the render scale, not a height, so every named
 * crop is the square `w x w`. A null spec is the whole map.
 */
function cropRect(spec, W, H) {
  if (!spec) return { x: 0, y: 0, w: W, h: H };
  const p = spec.split(',').map(Number);
  const x = Math.max(0, p[0]);
  const y = Math.max(0, p[1]);
  return { x, y, w: Math.min(p[2], W - x), h: Math.min(p[2], H - y) };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/*
 * mapgen renders from `shared/dist`, NOT from `shared/src/world/city.data.ts`.
 * `citybake` alone is therefore not enough: with a stale dist, a render after a
 * rebake silently re-draws the PREVIOUS bake, and the plates come back
 * byte-identical to the baseline. That reads exactly like "the renderer cannot
 * show this change" and it cost an iteration-8 agent an hour — it was caught by
 * a bevel count, not by the eye.
 *
 * The whole worth of a watch plate is that it depicts the bake it is filed
 * under, so refuse rather than draw a plate that does not.
 */
function assertDistFresh() {
  const src = 'shared/src/world/city.data.ts';
  const dist = 'shared/dist/world/city.data.js';
  if (!existsSync(dist)) {
    throw new Error(`${dist} does not exist — run \`pnpm build\` before rendering.`);
  }
  // Compare the encoded payload, NOT mtimes. `tsc -b` decides what to rebuild
  // from its own buildinfo, so a file whose mtime moved but whose content did
  // not is never rewritten — an mtime guard then refuses forever and `pnpm
  // build` cannot clear it. A guard whose prescribed remedy does not work is
  // worse than no guard; this one compares the bytes that actually get drawn.
  const payload = (f) => {
    const t = readFileSync(f, 'utf8');
    const a = t.indexOf('"'), b = t.lastIndexOf('"');
    if (a < 0 || b <= a) throw new Error(`${f} does not look like a city.data module`);
    return t.slice(a, b + 1);
  };
  if (payload(src) !== payload(dist)) {
    throw new Error(
      `${dist} does not carry the bake in ${src}.\n` +
      `mapgen renders from dist, so these plates would depict the PREVIOUS bake.\n` +
      `Run \`pnpm build\` first.`);
  }
}

function render(iter) {
  assertDistFresh();
  const dir = join('evidence/watch', `iter${iter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of WATCH) {
    const out = join(dir, `${name}.png`);
    const args = [MAPGEN, `--out=${out}`];
    if (spec) {
      const p = spec.split(',');
      args.push(`--crop=${p[0]},${p[1]},${p[2]}`, `--scale=${p[3]}`);
    }
    execFileSync('node', args, { stdio: 'ignore' });
    process.stdout.write(`  rendered ${name}\n`);
  }
  // The tile plane the plates were drawn from, so the next iteration can diff
  // classes and not only pixels without going back through git.
  try {
    writeSnapshot(join(dir, SNAP), loadTiles(SHIPPED));
    process.stdout.write(`  snapshot ${SNAP}\n`);
  } catch (e) {
    process.stdout.write(`  ! no tile snapshot: ${e.message}\n`);
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* The pixel reading — unchanged, and the loop's continuous record      */
/* ------------------------------------------------------------------ */

function pixelDiff(a, b) {
  const da = join('evidence/watch', `iter${a}`);
  const db = join('evidence/watch', `iter${b}`);
  const px = new Map();
  let moved = 0;
  console.log(`  ${'crop'.padEnd(15)}${'changed px'.padStart(14)}   what it watches`);
  console.log(`  ${'-'.repeat(15)}${'-'.repeat(14)}   ${'-'.repeat(38)}`);
  for (const [name, , what] of WATCH) {
    const fa = join(da, `${name}.png`), fb = join(db, `${name}.png`);
    if (!existsSync(fa) || !existsSync(fb)) { console.log(`  ${name.padEnd(15)}${'—'.padStart(14)}   (no baseline)`); continue; }
    let line = '';
    try {
      line = execFileSync('node', ['evidence/round1/D-pngdiff.mjs', fb, fa], { encoding: 'utf8' }).trim().split('\n').pop();
    } catch { line = 'ERR'; }
    const m = /differing px (\d+)\/(\d+) \(([\d.]+)%\)/.exec(line);
    const size = /SIZE DIFFER/.test(line);
    let cell;
    if (size) { cell = 'SIZE'; moved++; }
    else if (m) { const n = Number(m[1]); if (n > 0) moved++; cell = n === 0 ? '0' : `${m[1]} (${m[3]}%)`; }
    else cell = '?';
    px.set(name, cell);
    console.log(`  ${name.padEnd(15)}${cell.padStart(14)}   ${what}`);
  }
  console.log(`\n  ${moved} of ${WATCH.length} watch crops moved.`);
  return px;
}

/* ------------------------------------------------------------------ */
/* The tile reading — what changed, not just how much                  */
/* ------------------------------------------------------------------ */

/**
 * Every changed tile in a rectangle, bucketed by what the change WAS.
 *
 * A tile is a carriageway change when the two sides disagree about whether it
 * is drivable road: `road+` road appeared, `road-` road went away. Road that
 * merely changed kind (`ROAD->BRIDGE`) is `road~` and still counts as the
 * network moving. Everything else is land use: the transition is recorded but
 * the road columns stay at zero, which is the whole point of the split.
 */
export function tileDelta(prev, cur, rect) {
  const d = {
    changed: 0, roadPlus: 0, roadMinus: 0, roadMix: 0, land: 0,
    trans: new Map(), roadBbox: null,
  };
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const row = y * cur.widthTiles;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const a = prev.tiles[row + x], b = cur.tiles[row + x];
      if (a === b) continue;
      d.changed++;
      const key = a * 256 + b;                 // keyed by tile id, named at print time
      d.trans.set(key, (d.trans.get(key) ?? 0) + 1);
      const ca = isCarriageway(a), cb = isCarriageway(b);
      if (!ca && cb) d.roadPlus++;
      else if (ca && !cb) d.roadMinus++;
      else if (ca && cb) d.roadMix++;
      else { d.land++; continue; }
      // Reached only on a carriageway change, so this is the extent of the
      // ROAD movement and not of the churn around it. On iteration 6 that is
      // the difference between "x 425-544 y 309-312" and the whole map.
      d.roadBbox = d.roadBbox
        ? [Math.min(d.roadBbox[0], x), Math.min(d.roadBbox[1], y), Math.max(d.roadBbox[2], x), Math.max(d.roadBbox[3], y)]
        : [x, y, x, y];
    }
  }
  d.road = d.roadPlus + d.roadMinus + d.roadMix;
  return d;
}

const roadCell = (d) =>
  d.road === 0 ? '0' : `+${d.roadPlus} -${d.roadMinus}${d.roadMix ? ` ~${d.roadMix}` : ''}`;

/** Does this transition touch the carriageway on either side? */
const roadKey = (k) => isCarriageway(k >> 8) || isCarriageway(k & 255);

/** `FIELD->ROAD 105 | PARK->ROAD 60 | ...`, biggest first. */
function transLine(trans, want, cap) {
  const rows = [...trans].filter(([k]) => want(k)).sort((p, q) => q[1] - p[1]);
  if (rows.length === 0) return null;
  const shown = cap > 0 ? rows.slice(0, cap) : rows;
  let s = shown.map(([k, n]) => `${nameOf(k >> 8)}->${nameOf(k & 255)} ${n}`).join(' | ');
  if (rows.length > shown.length) {
    s += `  (+${rows.length - shown.length} more, ${rows.slice(shown.length).reduce((t, r) => t + r[1], 0)} tiles)`;
  }
  return s;
}

function tileTable(prev, cur, all, px) {
  const W = cur.widthTiles, H = cur.heightTiles;
  console.log(`  tiles  ${W}x${H}, blocks ${prev.blocks} → ${cur.blocks}`);
  if (prev.blocks !== cur.blocks) {
    console.log(`  ! block count moved by ${cur.blocks - prev.blocks}. Downstream land use is index-coupled`);
    console.log(`    to block count, so building and park placement re-rolls CITY-WIDE. Land-use`);
    console.log(`    deltas below in boroughs your change never touched are that re-roll.`);
  }
  console.log('');
  console.log(`  ${'crop'.padEnd(15)}${'tiles'.padStart(8)}${'carriageway'.padStart(14)}${'land use'.padStart(10)}   what it watches`);
  console.log(`  ${'-'.repeat(15)}${'-'.repeat(8)}${'-'.repeat(14)}${'-'.repeat(10)}   ${'-'.repeat(38)}`);

  const deltas = [];
  for (const [name, spec, what] of WATCH) {
    const d = tileDelta(prev, cur, cropRect(spec, W, H));
    deltas.push([name, d, what]);
    console.log(
      `  ${name.padEnd(15)}${String(d.changed || 0).padStart(8)}${roadCell(d).padStart(14)}` +
      `${String(d.land || 0).padStart(10)}   ${what}`,
    );
  }

  const whole = deltas[0][1];
  const roadCrops = deltas.slice(1).filter(([, d]) => d.road > 0).map(([n]) => n);
  const landOnly = deltas.slice(1).filter(([, d]) => d.changed > 0 && d.road === 0);
  console.log('');
  if (whole.road === 0) {
    console.log('  CARRIAGEWAY: unchanged. Not one road, bridge or ramp tile moved anywhere on the map.');
  } else {
    const bb = whole.roadBbox;
    console.log(
      `  CARRIAGEWAY: ${whole.road} ${whole.road === 1 ? 'tile' : 'tiles'} (${roadCell(whole)}),` +
      ` all within x ${bb[0]}-${bb[2]} y ${bb[1]}-${bb[3]}.`,
    );
    console.log(`    named crops carrying it: ${roadCrops.length ? roadCrops.join(', ') : 'none — it fell outside every named crop'}`);
  }
  console.log(
    `  LAND USE:    ${whole.land} ${whole.land === 1 ? 'tile' : 'tiles'}${landOnly.length ? `, incl. ${landOnly.map(([n, d]) => `${n} ${d.changed}`).join(', ')} with NO road transition` : ''}.`,
  );

  // The reconciliation the pixel column cannot do for itself: of the crops
  // that moved on screen, which ones moved because the ROAD NETWORK moved?
  // Iteration 6 is why this line exists — `sunridge 13671 px` was the largest
  // borough reading in the table and had nothing to do with the fix.
  if (px) {
    const moved = deltas.slice(1).filter(([n]) => px.get(n) && px.get(n) !== '0' && px.get(n) !== '—');
    const withRoad = moved.filter(([, d]) => d.road > 0);
    const landish = moved.filter(([, d]) => d.road === 0 && d.changed > 0);
    // Pixels moved and NOT ONE tile class in the crop did. This is the class
    // of change the tile reading is blind to and the pixel diff exists for --
    // a palette or bevel change, or a tile just outside the crop bleeding
    // into its edge. Never silently fold it in with land use.
    const renderOnly = moved.filter(([, d]) => d.changed === 0);
    console.log('');
    console.log('  reading the pixel column above:');
    console.log(`    road moved here     ${withRoad.length ? withRoad.map(([n, d]) => `${n} ${px.get(n)} → ${roadCell(d)}`).join(', ') : 'nowhere'}`);
    console.log(`    land use only       ${landish.length ? landish.map(([n]) => `${n} ${px.get(n)}`).join(', ') : 'none'}`);
    console.log(`    pixels only         ${renderOnly.length ? `${renderOnly.map(([n]) => `${n} ${px.get(n)}`).join(', ')}  (no tile class in the crop changed)` : 'none'}`);
    const quiet = deltas.slice(1).filter(([n, d]) => d.changed > 0 && (px.get(n) === '0' || !px.get(n)));
    if (quiet.length) console.log(`    ! tiles moved but no pixels did: ${quiet.map(([n, d]) => `${n} ${d.changed}`).join(', ')}`);
  }

  console.log('\n  transitions per crop (— means the crop did not move)\n');
  for (const [name, d] of deltas) {
    if (d.changed === 0) { console.log(`  ${name.padEnd(15)} —`); continue; }
    console.log(`  ${name.padEnd(15)} ${d.changed} ${d.changed === 1 ? 'tile' : 'tiles'}`);
    const road = transLine(d.trans, roadKey, all ? 0 : 8);
    const land = transLine(d.trans, (k) => !roadKey(k), all ? 0 : 8);
    console.log(`    carriageway   ${road ?? 'NONE'}`);
    console.log(`    land use      ${land ?? 'none'}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */

function resolveBake(explicit, iter) {
  if (explicit) return loadTiles(explicit);
  const snap = join('evidence/watch', `iter${iter}`, SNAP);
  if (existsSync(snap)) return loadTiles(snap);
  return null;
}

function diff(a, b, opt) {
  console.log(`\n  iter${b} → iter${a}\n`);
  const px = pixelDiff(a, b);
  console.log('');
  let prev = null, cur = null;
  try {
    prev = resolveBake(opt.tilesPrev, b);
    cur = resolveBake(opt.tiles, a);
  } catch (e) {
    console.log(`  tiles: FAILED TO READ — ${e.message}\n`);
    return;
  }
  if (!prev || !cur) {
    console.log('  tiles: no snapshot for ' + (!prev ? `iter${b}` : `iter${a}`) + '. The pixel column above is');
    console.log('         the whole reading — it cannot tell a road from a re-rolled park. Pass');
    console.log('         --tiles-prev/--tiles with the two city.data.ts to get the tile table.\n');
    return;
  }
  if (prev.widthTiles !== cur.widthTiles || prev.heightTiles !== cur.heightTiles) {
    console.log(`  tiles: SIZE DIFFER ${prev.widthTiles}x${prev.heightTiles} vs ${cur.widthTiles}x${cur.heightTiles}\n`);
    return;
  }
  tileTable(prev, cur, opt.all, px);
}

/**
 * Two bakes, the tile reading, no plates. `--diff` is the loop's normal entry
 * point; this is the one the selftest and any before/after probe use, so the
 * control drives the SAME `tileTable` a reader sees rather than a private
 * copy of the arithmetic.
 *
 *   node ci/mapwatch.mjs --tiles-only --tiles-prev a.data.ts --tiles b.data.ts
 */
function tilesOnly(opt) {
  if (!opt.tiles || !opt.tilesPrev) {
    console.error('--tiles-only needs both --tiles-prev <file> and --tiles <file>');
    return 2;
  }
  const prev = loadTiles(opt.tilesPrev), cur = loadTiles(opt.tiles);
  console.log(`\n  ${opt.tilesPrev}\n  → ${opt.tiles}\n`);
  if (prev.widthTiles !== cur.widthTiles || prev.heightTiles !== cur.heightTiles) {
    console.log(`  tiles: SIZE DIFFER ${prev.widthTiles}x${prev.heightTiles} vs ${cur.widthTiles}x${cur.heightTiles}\n`);
    return 1;
  }
  tileTable(prev, cur, opt.all, null);
  return 0;
}

/* ------------------------------------------------------------------ */
/* --selftest: the control                                             */
/* ------------------------------------------------------------------ */

/**
 * Six instruments in this exercise have been caught reporting confidently
 * wrong things, one of them a control that read blind on its own first draft.
 * So this one is built to be able to go RED, and the run shows it going red.
 *
 * Four cases, each a synthetic bake written to disk and read back through the
 * same `loadTiles` the real diff uses:
 *
 *   0  round trip     encode(decode(shipped)) === shipped. If the codec is
 *                     not faithful, every reading below measures the codec.
 *   1  identity       a bake against itself must read 0 everywhere. An
 *                     instrument that always finds something is useless.
 *   2  land only      FIELD->PARK inside `sunridge`, nothing else. The tool
 *                     MUST report those tiles and carriageway 0 — this is
 *                     iteration 6's Sunridge in miniature.
 *   3  road only      FIELD->ROAD inside `strait`, nothing else. The tool
 *                     MUST report carriageway +n. This is what stops case 2
 *                     from passing because the road column is dead.
 *   4  contaminated   case 2's plant plus ONE road tile. Case 2's assertion
 *                     is re-run against it and MUST FAIL. This is the red:
 *                     it is the only case that proves "carriageway 0" was a
 *                     measurement rather than a constant.
 */
function selftest() {
  const dir = join(tmpdir(), `mapwatch-selftest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const base = loadTiles(SHIPPED);
  const W = base.widthTiles, H = base.heightTiles;
  const rectOf = (name) => cropRect(WATCH.find((w) => w[0] === name)[1], W, H);
  const at = (x, y) => y * W + x;

  let fails = 0;
  const ok = (pass, label, detail) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
    if (!pass) fails++;
    return pass;
  };

  console.log(`\n  mapwatch selftest — ${base.name} ${W}x${H}, blocks ${base.blocks}\n`);
  ok(roundTripIsFaithful(base), 'case 0  codec round trip',
     'encode(decode(city.data.ts)) is byte-identical');

  // Write the shipped plane back out unchanged and diff it against itself.
  const same = join(dir, 'identity.city.data.ts');
  writeTiles(same, base, base.tiles);
  const id = tileDelta(base, loadTiles(same), cropRect(null, W, H));
  ok(id.changed === 0, 'case 1  identity', `${id.changed} tiles changed, carriageway ${roadCell(id)}`);

  /**
   * Paint `to` over the first `want` tiles of a crop that are neither
   * carriageway nor water nor already `to` — so the plant's size is known
   * exactly and the transitions it makes are exactly the ones intended.
   *
   * The first draft of this selftest planted `FIELD->PARK` down a fixed row
   * and laid ZERO tiles in `strait`, and its "road only reads road" assertion
   * PASSED anyway — `roadPlus === laid` is 0 === 0. That is the sixth blind
   * control in this exercise, caught in its own first run. Hence: `plant`
   * returns its count, and every case asserts the count is the full `PLANT`
   * before it believes anything downstream of it.
   */
  const plant = (plane, rect, to, want) => {
    let n = 0;
    for (let y = rect.y + 2; y < rect.y + rect.h - 2 && n < want; y++) {
      for (let x = rect.x + 2; x < rect.x + rect.w - 2 && n < want; x++) {
        const i = at(x, y), v = plane[i];
        if (v === to || v === T_WATER || isCarriageway(v)) continue;
        plane[i] = to;
        n++;
      }
    }
    return n;
  };
  const PLANT = 200;

  // Case 2: land use only, planted where iteration 6's wash landed.
  const sun = rectOf('sunridge');
  const landPlane = Uint8Array.from(base.tiles);
  const planted = plant(landPlane, sun, T_PARK, PLANT);
  const landFile = join(dir, 'land.city.data.ts');
  writeTiles(landFile, base, landPlane);
  const landBake = loadTiles(landFile);
  const landWhole = tileDelta(base, landBake, cropRect(null, W, H));
  const landSun = tileDelta(base, landBake, sun);
  ok(planted === PLANT, 'case 2  plant landed', `${planted} tiles ->PARK inside sunridge, no road touched`);
  const c2 = (whole, crop) =>
    planted === PLANT && whole.road === 0 && crop.road === 0 &&
    crop.land === planted && whole.changed === planted;
  ok(c2(landWhole, landSun), 'case 2  land only reads no road',
     `map ${landWhole.changed} tiles, carriageway ${roadCell(landWhole)}; sunridge land ${landSun.land}`);

  // Case 3: carriageway only, in a different crop.
  const st = rectOf('strait');
  const roadPlane = Uint8Array.from(base.tiles);
  const laid = plant(roadPlane, st, T_ROAD, PLANT);
  const roadFile = join(dir, 'road.city.data.ts');
  writeTiles(roadFile, base, roadPlane);
  const roadBake = loadTiles(roadFile);
  const roadWhole = tileDelta(base, roadBake, cropRect(null, W, H));
  const roadStrait = tileDelta(base, roadBake, st);
  const roadSun = tileDelta(base, roadBake, sun);
  ok(laid === PLANT, 'case 3  plant landed', `${laid} tiles ->ROAD inside strait`);
  ok(laid === PLANT && roadWhole.roadPlus === laid && roadStrait.roadPlus === laid && roadSun.road === 0,
     'case 3  road only reads road',
     `map carriageway ${roadCell(roadWhole)}; strait ${roadCell(roadStrait)}; sunridge ${roadCell(roadSun)}`);

  // Case 4: the red. Case 2's plant, plus one road tile.
  const dirtyPlane = Uint8Array.from(landPlane);
  let dirtyAt = null;
  for (let y = sun.y + sun.h - 3; y >= sun.y + 2 && !dirtyAt; y--) {
    for (let x = sun.x + 2; x < sun.x + sun.w - 2 && !dirtyAt; x++) {
      const i = at(x, y), v = dirtyPlane[i];
      if (v === T_WATER || isCarriageway(v) || v !== base.tiles[i]) continue;
      dirtyPlane[i] = T_ROAD;
      dirtyAt = [x, y];
    }
  }
  ok(dirtyAt !== null, 'case 4  contaminant landed', `one ->ROAD at ${dirtyAt ? dirtyAt.join(',') : 'NOWHERE'}`);
  const dirtyFile = join(dir, 'contaminated.city.data.ts');
  writeTiles(dirtyFile, base, dirtyPlane);
  const dirtyBake = loadTiles(dirtyFile);
  const dirtyWhole = tileDelta(base, dirtyBake, cropRect(null, W, H));
  const dirtySun = tileDelta(base, dirtyBake, sun);
  const c2OnDirty = c2(dirtyWhole, dirtySun);
  console.log(
    `\n  case 4  the same "land only reads no road" assertion, re-run against a bake\n` +
    `          with ONE road tile planted at ${dirtyAt ? dirtyAt.join(',') : '?'} — it must go RED:\n` +
    `            ${c2OnDirty ? 'PASS' : 'FAIL'}  land only reads no road          ` +
    `map ${dirtyWhole.changed} tiles, carriageway ${roadCell(dirtyWhole)}; sunridge ${roadCell(dirtySun)}`,
  );
  ok(!c2OnDirty && dirtyWhole.roadPlus === 1,
     'case 4  the control went red', 'one planted road tile is enough to fail case 2');

  console.log(`\n  ${fails === 0 ? 'selftest green' : `SELFTEST RED — ${fails} case(s) wrong`}`);
  console.log(`  mutants in ${dir}\n`);
  return fails === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */

/**
 * Arguments. `--diff` stays POSITIONAL-ish, exactly as it has been since
 * iteration 1: it is consumed here and never swallowed by the flag loop.
 *
 * An earlier draft of this parser dropped every `--` token from the
 * positional list, so `6 --diff 5` parsed as "render iteration 6" and
 * silently RE-RENDERED evidence/watch/iter6 over the loop's own baseline.
 * It happened to be harmless -- mapgen is bit-deterministic and the plates
 * came back byte-identical -- but a watch set that can overwrite its own
 * baseline from a typo is not a baseline. Hence the explicit whitelist, and
 * the refusal on an unrecognised argument rather than a silent render.
 */
const argv = process.argv.slice(2);
const opt = { all: false, selftest: false, tilesOnly: false, tiles: null, tilesPrev: null };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tiles') opt.tiles = argv[++i];
  else if (a === '--tiles-prev') opt.tilesPrev = argv[++i];
  else if (a === '--all') opt.all = true;
  else if (a === '--selftest') opt.selftest = true;
  else if (a === '--tiles-only') opt.tilesOnly = true;
  else rest.push(a);
}
const [iter, flag, other] = rest;

const USAGE =
  'usage: node ci/mapwatch.mjs <iteration>\n' +
  '       node ci/mapwatch.mjs <n> --diff <m> [--tiles-prev f --tiles f] [--all]\n' +
  '       node ci/mapwatch.mjs --tiles-only --tiles-prev f --tiles f [--all]\n' +
  '       node ci/mapwatch.mjs --selftest';

if (opt.selftest) process.exit(selftest());
else if (opt.tilesOnly) process.exit(tilesOnly(opt));
else if (flag !== undefined && flag !== '--diff') { console.error(`unknown argument "${flag}"\n${USAGE}`); process.exit(2); }
else if (!iter) { console.error(USAGE); process.exit(2); }
else if (flag === '--diff') {
  if (!other) { console.error(`--diff needs the iteration to compare against\n${USAGE}`); process.exit(2); }
  diff(iter, other, opt);
} else { console.log(`rendering watch set for iteration ${iter}`); const d = render(iter); console.log(`\n  ${WATCH.length} plates in ${d}\n`); }
