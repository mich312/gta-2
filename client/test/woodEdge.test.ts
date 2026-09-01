import { beforeAll, describe, expect, it } from 'vitest';
import { generateCity, parseWorldgenParams, type CityMap } from 'shared';
import worldgenJson from 'shared/data/worldgen.json';
import palette from 'shared/data/palette.json';
import { render } from '../../server/src/tools/mapRender.js';

/**
 * Is a wood's edge DRAWN as a curve, or as the tile squares it is stored as?
 *
 * This is written against the PICTURE and imports nothing from the fix, so it
 * runs on the tree either side of it. That matters twice over here: it is the
 * check that would have caught the defect, and it is the check that keeps a
 * future painter change from putting the staircase back — a test that only
 * compiles against the repair is neither.
 *
 * ## The defect
 *
 * Woodland is planted from a field — `wildAt` is `fbm(WILD_SEED, tx / 22,
 * ty / 22) >= 0.52`, one sample per tile — so a wood's outline is that field's
 * level set and the `T_TREES` mask is the level set point-sampled. Every other
 * boundary of that shape on this map is drawn from the curve it was sampled
 * from: the coast (§18), the shore band's inner edge (§39), the bridge deck
 * (§45). The land-use boundary had none of the three, and `bevel.ts` refused
 * it in as many words — *"woodland edges inland are left square too, for
 * now"*. `evidence/final-review/islet-zoom.png` is what that looks like at
 * 20 px per tile: a smoothly curved coastline with a perfect tile staircase
 * of woodland inside it, and you can count the steps.
 *
 * ## What is asserted, and why in pixels
 *
 * The tile plane cannot tell a drawn staircase from a well-drawn one — the
 * coastline is a tile mask too, and by every tile-plane measure it steps
 * WORSE than the woodland does, while none of its steps reaches the screen.
 * So this asks the only question that separates them: **of the woodland
 * boundary a reader can see, how much of it runs along a whole tile edge?**
 * Measured in the rendered image, at 20 px per tile, over the islet the
 * visual review photographed.
 *
 * A boundary drawn from the tile mask can only run along tile edges, so its
 * answer is 100% by construction. A boundary drawn from a curve crosses tile
 * squares at whatever angle the curve runs at, and its answer is whatever the
 * curve's own shape says — for this islet, under a third.
 *
 * The COASTLINE in the same crop is the control, and it is the reason there
 * is a number to compare against rather than a threshold somebody picked: it
 * is a tile mask drawn from its own curve, in the same picture, at the same
 * scale, by the same renderer. The woodland edge has no business being more
 * axis-aligned than the water's edge beside it.
 */

const params = parseWorldgenParams(worldgenJson);
let map: CityMap;

beforeAll(() => {
  map = generateCity(1, params);
});

/** The photographed islet: `--crop=317,720,26 --scale=20`. */
const CROP = { x: 317, y: 720, w: 26, h: 26, scale: 20 };

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * How much of a two-colour boundary in a picture runs along a WHOLE TILE EDGE.
 *
 * Walked in pixels: a boundary pixel-face is one where the two colours meet,
 * and a face is "on a tile edge" when it lies exactly on a tile line of the
 * render AND is part of an unbroken run of at least one whole tile's worth of
 * faces along that line. One tile, not two, because a single tile step is
 * precisely what a bevel could have chamfered and what the audit excuses.
 *
 * Colour comparison is exact. The renderer fills flat colours from the
 * palette, so a pixel is one material or the other and there is nothing to
 * threshold — which is what makes this a census rather than an estimate.
 */
function tileEdgeShare(
  px: Uint8Array,
  W: number,
  H: number,
  scale: number,
  a: RGB,
  b: RGB,
): { faces: number; onTileEdge: number } {
  const isA = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    return px[i] === a[0] && px[i + 1] === a[1] && px[i + 2] === a[2];
  };
  const isB = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const i = (y * W + x) * 4;
    return px[i] === b[0] && px[i + 1] === b[1] && px[i + 2] === b[2];
  };
  let faces = 0;
  let onTileEdge = 0;
  // Horizontal faces (a above b, or b above a) lie in runs along x, on the
  // line y; the line is a tile line when y is a multiple of `scale`.
  for (let y = 1; y < H; y++) {
    const onLine = y % scale === 0;
    let run = 0;
    for (let x = 0; x <= W; x++) {
      const on =
        x < W && ((isA(x, y - 1) && isB(x, y)) || (isB(x, y - 1) && isA(x, y)));
      if (on) {
        faces++;
        run++;
        continue;
      }
      if (onLine && run >= scale) onTileEdge += run;
      run = 0;
    }
  }
  for (let x = 1; x < W; x++) {
    const onLine = x % scale === 0;
    let run = 0;
    for (let y = 0; y <= H; y++) {
      const on =
        y < H && ((isA(x - 1, y) && isB(x, y)) || (isB(x - 1, y) && isA(x, y)));
      if (on) {
        faces++;
        run++;
        continue;
      }
      if (onLine && run >= scale) onTileEdge += run;
      run = 0;
    }
  }
  return { faces, onTileEdge };
}

describe('a wood is drawn as the curve it was planted from', () => {
  it('does not run its edge along whole tile edges the way its own tile mask does', () => {
    const pic = render(
      map,
      palette,
      CROP.x,
      CROP.y,
      CROP.w,
      CROP.h,
      CROP.scale,
    );
    const trees = hexToRgb(palette.trees);
    const field = hexToRgb(palette.field);
    const water = hexToRgb(palette.water);
    const bank = hexToRgb(palette.bank);

    const wood = tileEdgeShare(pic.rgba, pic.w, pic.h, CROP.scale, trees, field);
    // The islet really does carry a woodland boundary in this crop. Without
    // this the assertion below passes on an empty census — the failure mode
    // this exercise has caught eleven instruments in.
    expect(wood.faces).toBeGreaterThan(200);

    // The control, in the same picture: the waterline itself. A tile mask
    // drawn from its own curve. The islet's shore is quay (`T_BANK`) rather
    // than sand, so the waterline in this crop is bank against water. The
    // colours come from the palette file the renderer itself reads, so they
    // cannot be assumed wrong: a palette edit moves both sides together.
    const coast = tileEdgeShare(pic.rgba, pic.w, pic.h, CROP.scale, bank, water);
    expect(coast.faces).toBeGreaterThan(200);
    const coastShare = coast.onTileEdge / coast.faces;
    // The control has to be LOW, or the comparison below is comparing two
    // staircases and would pass on the defect.
    expect(coastShare).toBeLessThan(0.25);

    const woodShare = wood.onTileEdge / wood.faces;
    // Printed so the control run can be QUOTED rather than described: this
    // test's whole argument is that the two numbers below are different
    // things, and a reader has to be able to see both on both trees.
    console.log(
      `  islet 317,720 at 20 px/tile — woodland edge on whole tile edges: ` +
        `${wood.onTileEdge} of ${wood.faces} px (${(100 * woodShare).toFixed(1)}%)` +
        `   |   waterline control: ${coast.onTileEdge} of ${coast.faces} px ` +
        `(${(100 * coastShare).toFixed(1)}%)`,
    );
    // Before the fix this reads 1.00 against the coast's 0.00: every visible
    // face of the wood lies on a whole tile edge and not one face of the
    // water's does.
    expect(woodShare).toBeLessThan(0.5);
  });
});
