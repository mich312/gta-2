/*
 * V-R5-A02 / V-R5-A04 — did any landmark's stamped mass survive the bake?
 *
 *   node evidence/round6/V-R5-A02-A04-landmark-mass-census.mjs
 *
 * Reads the SHIPPED bytes only (shared/dist/world/city.data.js — build first
 * with `pnpm build` if dist is stale). For every landmark it takes the
 * building record the stamp pushed (the record covering the landmark's rect)
 * and counts the tiles that record calls wall but the tile plane does not.
 *
 * At fca99c5 this prints exactly one line — Marsh Post, 18 tiles, all T_PARK,
 * columns 540..542 rows 549..554 — and "affected=1 of 29".
 *
 * The 18 tiles are Chapel Green's APRON: the reclaim pass in bake.ts paints
 * `ground(lx-4, ly-4, lw+8, lh+8, RECIPES[kind].apron)` for every claimed
 * landmark, `ground()` guards only on `paintable()`, and `paintable()` allows
 * T_BUILDING. Chapel Green [544,539,12,12] is landmark 26 and Marsh Post is
 * landmark 14, so the green's apron is painted over the police station's
 * already-stamped walls: x 540..559 x y 535..554 clipped to the police rect
 * is exactly 3 columns x 6 rows.
 */
import { decodeBakedCity } from '../../shared/dist/world/bake.js';
import { CITY_DATA } from '../../shared/dist/world/city.data.js';

const T_BUILDING = 3;
const NAMES = { 0: 'FIELD', 1: 'ROAD', 2: 'SIDEWALK', 3: 'BUILDING', 4: 'PARK', 5: 'LOT', 6: 'WATER', 7: 'BANK', 8: 'SAND', 9: 'FLOOR' };

const city = decodeBakedCity(JSON.parse(CITY_DATA));
const W = city.widthTiles;
const H = city.heightTiles;

let affected = 0;
for (const l of city.landmarks) {
  // The stamp's own record: a building whose rect lies inside the landmark's.
  const recs = city.buildings.filter(
    (b) => b.x >= l.x && b.y >= l.y && b.x + b.w <= l.x + l.w && b.y + b.h <= l.y + l.h,
  );
  const lost = {};
  const where = [];
  for (const b of recs) {
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = city.tiles[ty * W + tx];
        if (t === T_BUILDING) continue;
        const k = NAMES[t] ?? String(t);
        lost[k] = (lost[k] ?? 0) + 1;
        where.push(`${tx},${ty}=${k}`);
      }
    }
  }
  const n = where.length;
  if (n === 0) continue;
  affected++;
  console.log(`${l.name} (${l.kind}) rect=[${l.x},${l.y},${l.w},${l.h}] records=${recs.length} lost=${n}`, JSON.stringify(lost));
  console.log('  ' + where.join(' '));
}
console.log(`affected=${affected} of ${city.landmarks.length} landmarks`);
