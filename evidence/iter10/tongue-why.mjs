// Why is the tarmac at the three bare caps under no course?
//
// Two candidate mechanisms, and they want different fixes:
//   (a) the centreline was RECORDED over this tarmac and `trimCourses`
//       (bake.ts) cut it off — the curve exists in the layout and is thrown
//       away at bake time;
//   (b) the carve never recorded a centreline here at all — the tarmac is the
//       rasterised disc of something that was not written down.
//
// Distinguished by asking the LAYOUT's courses (pre-trim) the same question the
// bake's courses were asked. Needs the pass hook in shared/src/world/layout.ts.
//
//   node evidence/iter10/tongue-why.mjs
import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout, T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const layout = buildLayout(plan);

function coverOf(courses, extra) {
  const cover = new Uint8Array(W * H);
  for (const c of courses) {
    if (c.kind === 'path') continue;
    const half = c.width / 2 + extra;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k], [bx, by] = c.points[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) {
          if (cover[ty * W + tx]) continue;
          let t = l2 === 0 ? 0 : ((tx + 0.5 - ax) * dx + (ty + 0.5 - ay) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(ax + dx * t - tx - 0.5, ay + dy * t - ty - 0.5) <= half) cover[ty * W + tx] = 1;
        }
    }
  }
  return cover;
}

const baked = coverOf(city.courses, 0.55);
const pre = coverOf(layout.courses, 0.55);

let road = 0, cb = 0, cp = 0, rescued = 0;
for (let i = 0; i < W * H; i++) {
  if (!isRoad(city.tiles[i])) continue;
  road++;
  if (baked[i]) cb++;
  if (pre[i]) cp++;
  if (!baked[i] && pre[i]) rescued++;
}
console.log('=== does the LAYOUT already have a curve over the bare tarmac? ===');
console.log(`  carriageway tiles                                   ${road}`);
console.log(`  covered by BAKED courses (what the renderer sees)    ${cb}  (${((cb / road) * 100).toFixed(1)}%)`);
console.log(`  covered by LAYOUT courses (before trimCourses)       ${cp}  (${((cp / road) * 100).toFixed(1)}%)`);
console.log(`  bare in the bake but covered in the layout           ${rescued}  (${((rescued / road) * 100).toFixed(1)}% of all carriageway)`);
console.log(`  => trimCourses accounts for ${((rescued / (road - cb)) * 100).toFixed(1)}% of the ${road - cb} bare tiles`);

console.log('\n=== the three bare caps, tile by tile ===');
for (const [x, y, name] of [[415, 672, 'esplanade'], [321, 327, 'Ravenhill spine'], [342, 312, 'Ravenhill spine']]) {
  const i = y * W + x;
  console.log(`  ${x},${y} ${name}: baked-cover ${baked[i] ? 'YES' : 'no'}  layout-cover ${pre[i] ? 'YES' : 'no'}` +
    `  => ${!baked[i] && pre[i] ? '(a) trimCourses threw the curve away' : !baked[i] && !pre[i] ? '(b) no centreline was ever recorded here' : 'covered'}`);
}
console.log(`  478,600 New Suburbs crescent: baked-cover ${baked[600 * W + 478] ? 'YES' : 'no'} (the control — this one is drawn kerbed)`);
