/**
 * Read the tile plane out of any `city.data.ts`, and write a mutated one back.
 *
 * `ci/` is not a TypeScript package and does not import from `shared`, so the
 * decode is a COPY of `shared/src/world/bake.ts` (`fromBase64`/`decodePlane`)
 * and `server/src/tools/mapAudit.ts` (`loadBake`) rather than a call into
 * them. That is deliberate: `ci/mapwatch.mjs` has to read the bake at an
 * arbitrary old commit —
 *
 *     git show b5c7805:shared/src/world/city.data.ts > /tmp/iter5.city.data.ts
 *
 * — and an old bake decoded by today's `shared` is exactly the coupling that
 * would make the loop's historical record move under it. The format is
 * run-length pairs (value, run) base64'd; it has not changed in the life of
 * this loop, and `roundTripIsFaithful()` below is the check that says so
 * out loud instead of assuming it.
 *
 * Only the tile plane is decoded eagerly. `blocks` is kept because block
 * COUNT is the mechanism behind city-wide land-use churn (iteration 6: 1182
 * -> 1184 re-rolled buildings and parks in boroughs the fix never touched),
 * so the diff has to be able to say so.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/* Tile ids — shared/src/world/types.ts. Values are part of the baked file
 * format, so these are constants of the DATA, not imports of today's code. */
export const T_FIELD = 0;
export const T_ROAD = 1;
export const T_SIDEWALK = 2;
export const T_BUILDING = 3;
export const T_PARK = 4;
export const T_LOT = 5;
export const T_WATER = 6;
export const T_BRIDGE = 7;
export const T_RAMP = 8;
export const T_FLOOR = 9;
export const T_BANK = 10;
export const T_TREES = 11;
export const T_SAND = 12;
export const T_RUNWAY = 13;

export const TILE_NAME = [
  'FIELD', 'ROAD', 'SIDEWALK', 'BUILDING', 'PARK', 'LOT', 'WATER',
  'BRIDGE', 'RAMP', 'FLOOR', 'BANK', 'TREES', 'SAND', 'RUNWAY',
];

export const nameOf = (v) => TILE_NAME[v] ?? `T${v}`;

/**
 * The CARRIAGEWAY: the surfaces a car drives the road network on.
 *
 * This is the line the whole instrument turns on, so it is drawn narrowly and
 * on purpose. In: `ROAD`, `BRIDGE` (road carried over water) and `RAMP` (road
 * that launches you). Out: `SIDEWALK`, `BANK` and `FLOOR`, which are walking
 * surfaces that move whenever a kerb is re-cut; out: `LOT` and `RUNWAY`, which
 * are drivable ground but not the street network — an airfield apron growing
 * is not "the road network changed". Iteration 6 is the calibration: Kelvin's
 * 34 changed tiles are 23 `FIELD->SIDEWALK` and 10 `FIELD->BUILDING`, and the
 * reviewer who checked that bake tile by tile called it ZERO road transitions.
 * A definition that swept sidewalk in would have contradicted him.
 */
export const CARRIAGEWAY = new Set([T_ROAD, T_BRIDGE, T_RAMP]);
export const isCarriageway = (v) => CARRIAGEWAY.has(v);

/* ------------------------------------------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodePlane(text, length) {
  const bin = Buffer.from(text, 'base64');
  const plane = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    plane.fill(bin[i], at, at + bin[i + 1]);
    at += bin[i + 1];
  }
  if (at !== length) throw new Error(`city: encoded plane is ${at} tiles, expected ${length}`);
  return plane;
}

function encodePlane(plane) {
  const out = [];
  let i = 0;
  while (i < plane.length) {
    const v = plane[i];
    let n = 1;
    while (i + n < plane.length && plane[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  let s = '';
  for (let k = 0; k < out.length; k += 3) {
    const a = out[k], b = k + 1 < out.length ? out[k + 1] : 0, c = k + 2 < out.length ? out[k + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    s += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
    s += k + 1 < out.length ? B64[(n >>> 6) & 63] : '=';
    s += k + 2 < out.length ? B64[n & 63] : '=';
  }
  return s;
}

/**
 * The JSON a `city.data.ts` wraps, unwrapped — or a watch SNAPSHOT, which is
 * the same object with everything but the tile plane and the block count
 * thrown away (213 KB against 1 MB, written beside the plates each iteration
 * so a diff two years from now needs no `git show`).
 */
function unwrap(path) {
  const src = readFileSync(path, 'utf8');
  if (src.trimStart().startsWith('{')) return JSON.parse(src);
  const a = src.indexOf('"');
  const b = src.lastIndexOf('"');
  if (a < 0 || b <= a) throw new Error(`${path} does not look like a city.data.ts`);
  return JSON.parse(JSON.parse(src.slice(a, b + 1)));
}

/**
 * Decode a `city.data.ts` into the parts the watch diff needs.
 *
 * Structural refusals are kept from `decodeBakedCity`: a truncated or
 * hand-mangled file names the field it failed on rather than silently
 * decoding to a plane of zeros, which would read as "the whole city changed".
 */
export function loadTiles(path) {
  const r = unwrap(path);
  if (typeof r !== 'object' || r === null) throw new Error(`${path}: not an object`);
  const { widthTiles, heightTiles } = r;
  if (!Number.isInteger(widthTiles) || widthTiles <= 0) throw new Error(`${path}: widthTiles`);
  if (!Number.isInteger(heightTiles) || heightTiles <= 0) throw new Error(`${path}: heightTiles`);
  if (typeof r.tiles !== 'string') throw new Error(`${path}: tiles plane is not an encoded string`);
  const blocks = Array.isArray(r.blocks) ? r.blocks.length : r.blocks;
  if (!Number.isInteger(blocks)) throw new Error(`${path}: blocks is neither an array nor a count`);
  return {
    path,
    name: String(r.name ?? '?'),
    widthTiles,
    heightTiles,
    blocks,
    tiles: decodePlane(r.tiles, widthTiles * heightTiles),
    raw: r,
  };
}

/** The compact per-iteration snapshot: the tile plane, the size, the blocks. */
export function writeSnapshot(path, bake) {
  writeFileSync(
    path,
    `${JSON.stringify({
      name: bake.name,
      widthTiles: bake.widthTiles,
      heightTiles: bake.heightTiles,
      blocks: bake.blocks,
      tiles: bake.raw.tiles,
    })}\n`,
  );
}

/**
 * Write `city.data.ts` bytes with the tile plane replaced. Used only by the
 * selftest, to build a bake whose difference from the shipped one is exactly
 * what the control claims it is.
 */
export function writeTiles(path, bake, tiles) {
  const out = { ...bake.raw, tiles: encodePlane(tiles) };
  const head = `/*\n * SYNTHETIC bake written by ci/mapwatch.mjs --selftest.\n * Not generated by citybake; do not commit.\n */\n`;
  writeFileSync(path, `${head}export const CITY_DATA = ${JSON.stringify(JSON.stringify(out))};\n`);
}

/**
 * Does encode(decode(x)) === x on the tile plane? If it does not, every
 * reading the selftest takes through a written mutant is measuring the codec
 * rather than the plant.
 */
export function roundTripIsFaithful(bake) {
  return encodePlane(bake.tiles) === bake.raw.tiles;
}
