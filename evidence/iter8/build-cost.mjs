// What the deck cut costs to build, against the machinery it sits beside.
//
//   node evidence/iter8/build-cost.mjs
//
// `buildDeckCut` runs once per `TileLayer.setMap` and once per `buildCity`,
// which with ROAM on is once per rebase and not once per frame. The number
// worth knowing is not the absolute one but the ratio to `shoreChains`,
// which both of those already call at the same point for the same reason.
import { loadBake, NEW, S } from '../iter7/lib.mjs';
const c = loadBake(NEW);
const { buildDeckCut, shoreChains } = S;
for (const [name, fn] of [
  ['shoreChains(shores)', () => shoreChains(c.shores, c.widthTiles, c.heightTiles)],
  ['buildDeckCut', () => buildDeckCut(c.tiles, c.widthTiles, c.heightTiles, c.courses)],
]) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) fn();
  console.log(`${name.padEnd(22)} ${((performance.now() - t0) / 5).toFixed(1)} ms`);
}
