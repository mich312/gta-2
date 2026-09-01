/* Do the three painters agree about where a wood ends? (§46)
 *
 * Iteration 8 wired three painters for the deck and this iteration wires the
 * same three for the wood, so the same question has to be asked of them: at
 * every sub-texel of every tile the wood curve crosses, does each painter put
 * that sub-texel on the same side of the line?
 *
 *   1. mapgen's per-pixel field    — `wildDepth(wx, wy) >= 0`, in mapRender
 *   2. the 3D prism                — `shoreHalf(seg, false)`, in cityGeometry
 *   3. the 2D canvas               — `chainSide(seg, ux, uy)`, in tiles.ts
 *      and the canopy planting     — the same `chainSide`, in scenery.ts
 *
 * 2 and 3 read the CHORD; 1 reads the FIELD the chord is a secant of, so they
 * can differ by the chord's own bow. That is the same relationship §45 shipped
 * between mapgen's `deckDepth` pass and the client's deck chain, and this
 * measures the size of it instead of assuming it is small.
 *
 * The rules are TRANSCRIBED from the painters rather than called, exactly as
 * `client/test/bridgeParapet.test.ts` transcribes the ground-plane rule: a
 * check that calls into the painter cannot see the painter's convention being
 * changed out from under the chain.
 *
 * CONTROL: the same census with the 3D rule's SIDE FLIPPED must go red. A
 * parity check that cannot fail is not a parity check.
 *
 *   node evidence/iter12/painter-parity.mjs
 */
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity, buildWoodCut, wildDepth, shoreHalf, chainSide,
} from '../../shared/dist/index.js';

const src = readFileSync('shared/src/world/city.data.ts', 'utf8');
const q0 = src.indexOf('"'), q1 = src.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(src.slice(q0, q1 + 1))));
const W = city.widthTiles, H = city.heightTiles;
const cut = buildWoodCut(city.tiles, W, H);

/** Is a point inside this polygon? The 3D prism's top face covers `dry`. */
const inPoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const SUB = 8;
function census(flip3d) {
  let sampled = 0, wood2d = 0, wood3d = 0, woodPix = 0;
  let d23 = 0, d13 = 0, d12 = 0;
  let area = 0, tiles = 0;
  for (const [idx, seg] of cut) {
    const tx = idx % W;
    const ty = (idx - tx) / W;
    const dry = shoreHalf(seg, false);
    const wet = shoreHalf(seg, true);
    if (dry.length >= 3 && wet.length >= 3) {
      // The two halves have to partition the square exactly: a chord through
      // it leaves nothing over and counts nothing twice.
      const a = (p) => {
        let s = 0;
        for (let i = 0; i < p.length; i++) {
          const [x1, y1] = p[i];
          const [x2, y2] = p[(i + 1) % p.length];
          s += x1 * y2 - x2 * y1;
        }
        return Math.abs(s) / 2;
      };
      area += Math.abs(a(dry) + a(wet) - 1);
      tiles++;
    }
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const ux = (sx + 0.5) / SUB;
        const uy = (sy + 0.5) / SUB;
        sampled++;
        // 1. mapgen: the field itself, at the pixel's world position.
        const p1 = wildDepth(tx + ux, ty + uy) >= 0;
        // 2. 3D: inside the wooded half `buildWoodPrisms` lays the canopy on.
        const p2raw = inPoly(dry, ux, uy);
        const p2 = flip3d ? !p2raw : p2raw;
        // 3. 2D canvas / canopy planting: `chainSide` is -1 on the right of
        //    travel, and `woodCut` puts OPEN COUNTRY on the right.
        const p3 = chainSide(seg, ux, uy) > 0;
        if (p1) woodPix++;
        if (p2) wood3d++;
        if (p3) wood2d++;
        if (p2 !== p3) d23++;
        if (p1 !== p3) d13++;
        if (p1 !== p2) d12++;
      }
    }
  }
  return { sampled, woodPix, wood3d, wood2d, d23, d13, d12, area, tiles };
}

const r = census(false);
console.log(`\n  wood curve crosses ${cut.size} tiles; ${r.sampled} sub-texels sampled at ${SUB}x${SUB}\n`);
console.log(`  called WOOD by   mapgen (field)  ${r.woodPix}`);
console.log(`                   3D    (prism)   ${r.wood3d}`);
console.log(`                   2D    (chord)   ${r.wood2d}\n`);
console.log(`  3D vs 2D  disagree ${r.d23} of ${r.sampled}  (${(100 * r.d23 / r.sampled).toFixed(3)}%)  — both read the CHORD, so this must be 0`);
console.log(`  mapgen vs 2D       ${r.d13} of ${r.sampled}  (${(100 * r.d13 / r.sampled).toFixed(3)}%)  — field against its own secant`);
console.log(`  mapgen vs 3D       ${r.d12} of ${r.sampled}  (${(100 * r.d12 / r.sampled).toFixed(3)}%)`);
console.log(`\n  the two halves partition the square: worst area error ${r.area.toExponential(2)} over ${r.tiles} tiles`);

const c = census(true);
const ok = r.d23 === 0 && c.d23 > 0;
console.log(`\n  CONTROL, 3D side flipped: 3D vs 2D disagree ${c.d23} of ${c.sampled} — ${c.d23 > 0 ? 'red, as it must be' : 'STILL ZERO, THIS CHECK IS BLIND'}`);
console.log(`\n  VERDICT: ${ok ? 'the chord painters agree exactly and the check can fail' : '*** PARITY BROKEN OR CHECK BLIND ***'}\n`);
if (!ok) process.exitCode = 1;
