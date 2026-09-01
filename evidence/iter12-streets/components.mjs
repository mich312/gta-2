// Is the carriageway really one component, and where do the flagged streets sit
// in it?
//
// `street-serves-nothing`'s own reason text asserts "the carriageway is one
// component, so this IS reachable". That claim has never been measured in this
// loop; it is quoted from `checkCity`, which floods DRIVABLE ground (field,
// sand, lot, quay), not carriageway. If the tarmac is in fact several
// components, a fragment in a small one is a different and much worse defect
// than a fragment in the big one.
//
// CONTROL, and my first one was wrong. I wrote "a map with islands must give
// more than one component; one component covering everything means the flood is
// measuring the wrong material" — and it printed exactly that. It is not the
// flood that was wrong, it is the premise: every scrap of tarmac on this map IS
// connected, because the bridges connect it, and 102,059 is the same figure
// `evidence/iter5/measure-reachability.mjs` reports. A control has to be able to
// FAIL for a reason other than the one I expected, so it is replaced by one that
// does not assume the answer: knock out every T_BRIDGE tile and re-flood. If the
// component count does not rise, the flood cannot see a cut and its "one
// component" is worthless.
//
//   pnpm build && node evidence/iter12-streets/components.mjs
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const clen = (p) => { let l = 0; for (let k = 1; k < p.length; k++) l += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return l; };

/** 4-connected flood over whatever `passable` accepts. */
function flood(passable) {
  const comp = new Int32Array(W * H).fill(-1);
  const sizes = [];
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    const k0 = y0 * W + x0;
    if (comp[k0] !== -1 || !passable(x0, y0)) continue;
    const id = sizes.length;
    let n = 0;
    const st = [k0];
    comp[k0] = id;
    while (st.length) {
      const k = st.pop(); n++;
      const x = k % W, y = (k - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (comp[nk] !== -1 || !passable(nx, ny)) continue;
        comp[nk] = id; st.push(nk);
      }
    }
    sizes.push(n);
  }
  return { comp, sizes };
}

const { comp, sizes } = flood((x, y) => isRoad(at(x, y)));
const order = sizes.map((n, i) => [i, n]).sort((a, b) => b[1] - a[1]);
const total = sizes.reduce((a, b) => a + b, 0);
console.log(`=== CARRIAGEWAY components (T_ROAD | T_BRIDGE | T_RAMP, 4-connected) ===`);
console.log(`  ${total} tarmac tiles in ${sizes.length} components`);
console.log(`  largest 8: ${order.slice(0, 8).map(([, n]) => n).join(', ')}`);
console.log(`  largest holds ${((order[0][1] / total) * 100).toFixed(1)}% of the tarmac`);

/* CONTROL — cut every bridge tile and the flood must break into many pieces. */
const cut = flood((x, y) => { const t = at(x, y); return t === T_ROAD || t === T_RAMP; });
console.log(`  CONTROL, every T_BRIDGE tile removed: ${cut.sizes.length} components, largest ${Math.max(...cut.sizes)}`);
console.log(`  => the flood ${cut.sizes.length > sizes.length ? 'CAN see a cut' : 'CANNOT see a cut — it is not measuring connection'}; on the real map the tarmac is ${sizes.length === 1 ? 'genuinely ONE piece' : sizes.length + ' pieces'}\n`);

const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');
const big = order[0][0];
const compAtPoint = (x, y) => {
  for (let r = 0; r <= 4; r++)
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = (Math.round(y) + dy) * W + Math.round(x) + dx;
      if (k >= 0 && k < W * H && comp[k] !== -1) return comp[k];
    }
  return -1;
};

console.log('=== every baked road course NOT in the main carriageway component ===\n');
let off = 0;
for (const c of roads) {
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  const id = compAtPoint((p0[0] + q1[0]) / 2, (p0[1] + q1[1]) / 2);
  if (id === big) continue;
  off++;
  console.log(`  #${c.i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)} len=${clen(c.points).toFixed(1)} ${c.kind} — component ${id} of ${id === -1 ? '(none found)' : sizes[id] + ' tiles'}`);
}
if (off === 0) console.log('  (none — every baked road course sits in the main component)');

console.log('\n=== the six under review ===\n');
for (const i of [129, 163, 272, 298, 332, 362]) {
  const c = roads.find((r) => r.i === i);
  const p0 = c.points[0], q1 = c.points[c.points.length - 1];
  const id = compAtPoint((p0[0] + q1[0]) / 2, (p0[1] + q1[1]) / 2);
  console.log(`  #${i} ${p0[0].toFixed(0)},${p0[1].toFixed(0)}->${q1[0].toFixed(0)},${q1[1].toFixed(0)}: component ${id} (${sizes[id]} tiles)${id === big ? ' = MAIN' : ' — ISOLATED ISLAND OF TARMAC'}`);
}
