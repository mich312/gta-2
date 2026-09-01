// `edge-notch  m=1  a single water tile at 625,642`. Is it iteration 11's litter,
// and is it real?
//
// Runs `edgeNotches`' rule verbatim over the bake BEFORE iteration 11 and the
// bake after it, and prints what changed on the ground around the tile.
//
// CONTROL: the same rule must find the SAME notches on both bakes everywhere the
// two bakes are identical. A rule that reports a different set on unchanged
// ground is reading something other than the tiles.
//
//   pnpm build && node evidence/iter12-streets/notch.mjs <path-to-old-city.data.ts>
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const T = S;
const OLD = process.argv[2];
if (!OLD) throw new Error('pass the path to the pre-iteration-11 city.data.ts');

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NAME = new Map([
  [T.T_FIELD, 'field'], [T.T_ROAD, 'road'], [T.T_SIDEWALK, 'sidewalk'], [T.T_BUILDING, 'building'],
  [T.T_PARK, 'park'], [T.T_LOT, 'lot'], [T.T_WATER, 'water'], [T.T_BRIDGE, 'bridge'],
  [T.T_RAMP, 'ramp'], [T.T_FLOOR, 'floor'], [T.T_BANK, 'bank'], [T.T_TREES, 'trees'],
  [T.T_SAND, 'sand'], [T.T_RUNWAY, 'runway'],
]);
const isNatural = (t) => t === T.T_FIELD || t === T.T_PARK || t === T.T_TREES || t === T.T_SAND || t === T.T_WATER;

/** `edgeNotches` from server/src/tools/mapAudit.ts, rule for rule. */
function notches(city) {
  const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T.T_WATER : tiles[y * W + x]);
  const out = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const t = tiles[y * W + x];
    if (!isNatural(t)) continue;
    if (t !== T.T_WATER && !DIRS.some(([dx, dy]) => at(x + dx, y + dy) === T.T_WATER)) continue;
    const n = DIRS.map(([dx, dy]) => at(x + dx, y + dy));
    const other = n.filter((u) => u !== t);
    if (other.length < 3) continue;
    const u = other[0];
    if (!other.every((v) => v === u)) continue;
    if (!isNatural(u)) continue;
    out.push({ x, y, t, u });
  }
  return out;
}

const before = loadBake(OLD);
const after = loadBake(NEW);
const W = after.widthTiles, H = after.heightTiles;
if (before.widthTiles !== W || before.heightTiles !== H) throw new Error('bakes differ in size — not comparable');

const nb = notches(before), na = notches(after);
const key = (n) => `${n.x},${n.y}`;
const sb = new Set(nb.map(key)), sa = new Set(na.map(key));
console.log(`=== edge-notch, rule for rule, on both bakes ===`);
console.log(`  before iteration 11 (${OLD.split('/').pop()}): ${nb.length}`);
console.log(`  after  iteration 11 (shipped)               : ${na.length}`);
console.log(`  appeared: ${na.filter((n) => !sb.has(key(n))).map((n) => `${n.x},${n.y} ${NAME.get(n.t)} in ${NAME.get(n.u)}`).join('; ') || '(none)'}`);
console.log(`  went away: ${nb.filter((n) => !sa.has(key(n))).map((n) => `${n.x},${n.y} ${NAME.get(n.t)} in ${NAME.get(n.u)}`).join('; ') || '(none)'}`);

/* ---- CONTROL: the rule must agree wherever the two bakes agree ------ */
let diffTiles = 0;
const changed = new Uint8Array(W * H);
for (let i = 0; i < changed.length; i++) if (before.tiles[i] !== after.tiles[i]) { changed[i] = 1; diffTiles++; }
const nearChange = (n) => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = n.x + dx, y = n.y + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && changed[y * W + x]) return true;
  }
  return false;
};
const movedOnUnchangedGround = [...na.filter((n) => !sb.has(key(n))), ...nb.filter((n) => !sa.has(key(n)))].filter((n) => !nearChange(n));
console.log(`\nCONTROL — ${diffTiles} tiles differ between the two bakes`);
console.log(`  notches that appeared or vanished on ground neither bake changed: ${movedOnUnchangedGround.length}`);
console.log(`  => ${movedOnUnchangedGround.length === 0 ? 'the rule reads the tiles and nothing else' : 'THE RULE IS READING SOMETHING OTHER THAN THE TILES'}`);

/* ---- the tile itself, before and after ------------------------------ */
console.log(`\n=== the ground at 625,642, before -> after ===\n`);
const g = (c, x, y) => NAME.get(c.tiles[y * W + x]) ?? '?';
for (let y = 638; y <= 647; y++) {
  let row = `${y} `;
  for (let x = 618; x <= 632; x++) {
    const b = before.tiles[y * W + x], a2 = after.tiles[y * W + x];
    row += b === a2 ? ' ' + (NAME.get(a2) ?? '?')[0] : `[${(NAME.get(b) ?? '?')[0]}>${(NAME.get(a2) ?? '?')[0]}]`;
  }
  console.log(row);
}
console.log(`\n(x runs 618..632; a bracket is a tile iteration 11 changed)`);
console.log(`625,642 was ${g(before, 625, 642)}, is ${g(after, 625, 642)}`);
for (const [dx, dy] of DIRS) console.log(`  neighbour ${625 + dx},${642 + dy}: ${g(before, 625 + dx, 642 + dy)} -> ${g(after, 625 + dx, 642 + dy)}`);

/* ---- how much sand/water changed nearby, and why -------------------- */
let box = 0;
for (let y = 600; y < 680; y++) for (let x = 580; x < 700; x++) if (changed[y * W + x]) box++;
console.log(`\ntiles iteration 11 changed inside 580..700 x 600..680: ${box}`);

/* ---- is it DRAWN? the bevel plane, which is what cuts a natural edge --- */
// `mapaudit` reports edge-notch with DRAWN equal to SCORE, but that equality is
// a DEFAULT, not a measurement: only `built-staircase` and `landuse-staircase`
// measure their own drawing. So measure this one.
const bev = S.deriveBevels(after.tiles, W, H);
let bevelled = 0;
for (let i = 0; i < bev.length; i++) if (bev[i] !== S.BEV_NONE) bevelled++;
console.log(`\n=== is the notch drawn? ===`);
console.log(`CONTROL — the bevel plane cuts ${bevelled} of ${W * H} tiles (${((100 * bevelled) / (W * H)).toFixed(1)}%)`);
console.log(`  => ${bevelled > 0 && bevelled < W * H ? 'it cuts some tiles and not others — it discriminates' : 'BROKEN: it says the same thing everywhere'}`);
const nm = ['NONE', 'NE', 'SE', 'SW', 'NW'];
console.log(`  bevel at 625,642 (the notch): ${nm[bev[642 * W + 625]]}`);
for (const [dx, dy] of DIRS) console.log(`  bevel at ${625 + dx},${642 + dy}: ${nm[bev[(642 + dy) * W + 625 + dx]]}`);

/* ---- the other painter: the shore curve --------------------------- */
const { buildShoreCut } = await import(new URL('../../shared/dist/world/shoreCut.js', import.meta.url).href);
const cut = buildShoreCut(after.shores, W, H);
console.log(`\nCONTROL — the shore curve holds ${cut.slot.size} tiles`);
console.log(`  => ${cut.slot.size > 0 && cut.slot.size < W * H ? 'it covers some tiles and not others — it discriminates' : 'BROKEN'}`);
console.log(`  shore curve at 625,642: ${cut.slot.has(642 * W + 625) ? 'COVERED — the waterline here is repainted on a chord' : 'NOT covered'}`);
for (const [dx, dy] of DIRS) console.log(`  shore curve at ${625 + dx},${642 + dy}: ${cut.slot.has((642 + dy) * W + 625 + dx) ? 'covered' : 'not covered'}`);

/* ---- and what a CAR meets there: the solver's own function --------- */
// `collide.ts:shoreCutAt` replaces the tile square with the shore chord for any
// tile the curve holds, for the renderer AND for the movement solver ("the shape
// that stops a car is the shape that was punched out of the ground"). So ask the
// shipped `isSolidAtWorld` how much of the notch tile is actually solid to a car,
// and compare it with its dry neighbour and with open sea.
const { isSolidAtWorld } = await import(new URL('../../shared/dist/world/collide.js', import.meta.url).href);
const TILE = S.TILE_SIZE;
const fakeMap = { widthTiles: W, heightTiles: H, tiles: after.tiles, shoreCut: cut };
const wetFraction = (tx, ty) => {
  let wet = 0, n = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    n++;
    if (isSolidAtWorld(fakeMap, (tx + (i + 0.5) / 8) * TILE, (ty + (j + 0.5) / 8) * TILE, 'land')) wet++;
  }
  return wet / n;
};
console.log(`\n=== what a car meets, from the shipped collision solver ===`);
console.log(`CONTROL — open sea at 640,642 should be 1.00 solid-to-land: ${wetFraction(640, 642).toFixed(2)}`);
console.log(`CONTROL — dry beach  at 623,643 should be 0.00 solid-to-land: ${wetFraction(623, 643).toFixed(2)}`);
console.log(`  the notch  625,642: ${wetFraction(625, 642).toFixed(2)} of the tile is solid to a car`);
console.log(`  its neighbours 625,641 / 625,643 / 624,642: ${wetFraction(625, 641).toFixed(2)} / ${wetFraction(625, 643).toFixed(2)} / ${wetFraction(624, 642).toFixed(2)}`);

/* ---- WAS THE HAZARD THERE BEFORE? --------------------------------- */
// The detector fired because the NEIGHBOURS changed material (bank -> sand), not
// because the water moved: 625,642 is water in BOTH bakes. So ask the solver the
// same question of the pre-iteration-11 bake. If the tile was already solid to a
// car, iteration 11 did not create a hazard — it made an existing one legible to
// `edge-notch`, whose uniformity test needs all three dry neighbours to match.
const cutBefore = buildShoreCut(before.shores, W, H);
const mapBefore = { widthTiles: W, heightTiles: H, tiles: before.tiles, shoreCut: cutBefore };
const wetBefore = (tx, ty) => {
  let wet = 0, n = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    n++;
    if (isSolidAtWorld(mapBefore, (tx + (i + 0.5) / 8) * TILE, (ty + (j + 0.5) / 8) * TILE, 'land')) wet++;
  }
  return wet / n;
};
console.log(`\n=== the same tile, on the bake BEFORE iteration 11 ===`);
console.log(`CONTROL — open sea at 640,642: ${wetBefore(640, 642).toFixed(2)} (must be 1.00)`);
console.log(`CONTROL — dry beach at 623,643: ${wetBefore(623, 643).toFixed(2)} (must be 0.00)`);
console.log(`  625,642 solid-to-land BEFORE ${wetBefore(625, 642).toFixed(2)} -> AFTER ${wetFraction(625, 642).toFixed(2)}`);
console.log(`  625,641 solid-to-land BEFORE ${wetBefore(625, 641).toFixed(2)} -> AFTER ${wetFraction(625, 641).toFixed(2)}`);
console.log(`  625,643 solid-to-land BEFORE ${wetBefore(625, 643).toFixed(2)} -> AFTER ${wetFraction(625, 643).toFixed(2)}`);
console.log(`  624,642 solid-to-land BEFORE ${wetBefore(624, 642).toFixed(2)} -> AFTER ${wetFraction(624, 642).toFixed(2)}`);
