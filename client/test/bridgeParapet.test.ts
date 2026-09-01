import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  T_BRIDGE,
  T_WATER,
  TILE_SIZE,
  type CityMap,
  buildDeckCut,
  generateCity,
  parseWorldgenParams,
  shoreHalf,
} from 'shared';
import worldgenJson from 'shared/data/worldgen.json';
import palette from 'shared/data/palette.json';
import { buildCity } from '../src/three/cityGeometry.js';

/**
 * What the bridge parapet is standing on.
 *
 * This is written against the BUILT CITY and imports nothing from the fix, so
 * it runs on the tree either side of it. That matters: it is the check that
 * would have caught the defect it was written for, and a check that only
 * compiles against the repair is not that.
 *
 * ## The defect
 *
 * A carriageway is rasterised as a swept disc (`carveCourse`), so a deck's
 * tile mask is its true outline point-sampled at tile centres. `T_BRIDGE` is
 * refused by name in all three painters — "the coast runs UNDER it" in the 2D
 * tile painter, absent from `GROUND_AT_SEA` in 3D — so nothing put the
 * outline back, and `buildBridgeRails` stood a 5-unit parapet on the sample.
 * On a span a few degrees off the axis that sample changes a whole tile every
 * three or four columns, and the parapet jogged a whole tile with it:
 * `evidence/iter7/A-bridge-178-478-eye.png` photographs a span reading as a
 * zig-zag ribbon, and `evidence/iter8/A-bridge-178-478-eye-BEFORE.png` is the
 * same frame retaken by this iteration's tooling.
 *
 * ## What is asserted, and why these two things
 *
 * **Bearing.** A parapet keyed off tile sides can only ever run along an
 * axis. So on a span that is demonstrably NOT axis-aligned, the share of
 * parapet standing within a few degrees of an axis is the whole defect in one
 * number: 100% before, and the span's own bearing after. This does not depend
 * on any threshold anybody chose.
 *
 * **Straightness.** The one that says the deck is fixed rather than merely
 * turned: fit a line to each side's parapet and measure how far the parapet
 * strays from it. A staircase of tile-aligned boxes strays half a tile by
 * construction, which is exactly what a half-tile bevel cannot reach and what
 * `built-staircase` reports.
 *
 * Both are measured on the deck at 178,478 — the largest of the four decks
 * `pnpm mapaudit` flags, m=32, twelve treads over 44 tiles.
 */

const params = parseWorldgenParams(worldgenJson);
let map: CityMap;

beforeAll(() => {
  map = generateCity(1, params);
});

/** The crop `mapaudit` reports for the 178,478 deck. */
const SPAN = { x0: 146, y0: 446, size: 64 };

interface Box {
  /** Centre, in game world px. */
  x: number;
  y: number;
  /** Long axis bearing in the game's y-down frame, radians, folded to [0, pi). */
  bearing: number;
  /** Length of the long axis, world px. */
  len: number;
}

/**
 * Every parapet box in the built city, as a centre and a bearing.
 *
 * Picked out by what it IS rather than by which function made it: kerb
 * coloured, standing 5 px, and long and thin. Nothing else in the city is all
 * three, and reading it off the scene means the test does not care whether
 * the boxes come from a per-tile walk or from a curve.
 */
function parapets(city: CityMap): Box[] {
  const { group } = buildCity(city);
  const kerb = parseInt(palette.kerb.replace('#', ''), 16);
  const out: Box[] = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  group.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const mat = mesh.material as THREE.MeshToonMaterial;
    if (!mat.color || mat.type !== 'MeshToonMaterial') return;
    if (mat.color.getHex() !== kerb) return;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(pos, q, scl);
      // A parapet: 5 px tall, sitting on the deck at z = 0.
      if (Math.abs(scl.z - 5) > 0.01 || Math.abs(pos.z - 2.5) > 0.01) continue;
      e.setFromQuaternion(q, 'XYZ');
      const long = scl.x >= scl.y;
      // The instance's own yaw, plus a quarter turn if the long side is y.
      const yaw = e.z + (long ? 0 : Math.PI / 2);
      out.push({
        x: pos.x,
        y: pos.y,
        bearing: ((yaw % Math.PI) + Math.PI) % Math.PI,
        len: Math.max(scl.x, scl.y),
      });
    }
  });
  return out;
}

/** Boxes whose centre falls inside the flagged crop. */
function inSpan(boxes: Box[]): Box[] {
  const lo = SPAN.x0 * TILE_SIZE;
  const hi = (SPAN.x0 + SPAN.size) * TILE_SIZE;
  const lo2 = SPAN.y0 * TILE_SIZE;
  const hi2 = (SPAN.y0 + SPAN.size) * TILE_SIZE;
  return boxes.filter((b) => b.x >= lo && b.x < hi && b.y >= lo2 && b.y < hi2);
}

/** How far off an axis a bearing is, in degrees: 0 for N-S or E-W. */
function offAxis(bearing: number): number {
  const deg = (bearing * 180) / Math.PI;
  return Math.min(deg, Math.abs(deg - 90), Math.abs(deg - 180));
}

/**
 * The worst distance from a set of points to the line that best fits them, in
 * TILES. Total least squares, so a near-vertical run is measured as fairly as
 * a near-horizontal one.
 */
function strayFromBestLine(pts: Array<{ x: number; y: number }>): number {
  const n = pts.length;
  if (n < 3) return 0;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    syy += (p.y - my) * (p.y - my);
    sxy += (p.x - mx) * (p.y - my);
  }
  // Principal axis of the scatter: the eigenvector of the larger eigenvalue.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  let worst = 0;
  for (const p of pts) {
    const d = Math.abs((p.x - mx) * nx + (p.y - my) * ny);
    if (d > worst) worst = d;
  }
  return worst / TILE_SIZE;
}

describe('the parapet on the bridge deck at 178,478', () => {
  it('is not the tile grid: a span that runs off the axis has a parapet that does too', () => {
    const boxes = inSpan(parapets(map));
    // The span is there at all. A staging check before any conclusion: an
    // empty set passes every assertion below on `0 === 0`, and this exercise
    // has already lost one control that way.
    expect(boxes.length).toBeGreaterThan(40);

    // The deck really does run off the axis here, established from the TILES
    // rather than assumed — so "the parapet is not axis-aligned" is a claim
    // about the fix and not about the map.
    let minX = Infinity;
    let maxX = -Infinity;
    const rowOf = new Map<number, number>();
    for (let ty = SPAN.y0; ty < SPAN.y0 + SPAN.size; ty++) {
      for (let tx = SPAN.x0; tx < SPAN.x0 + SPAN.size; tx++) {
        if (map.tiles[ty * map.widthTiles + tx] !== T_BRIDGE) continue;
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (!rowOf.has(tx)) rowOf.set(tx, ty);
      }
    }
    const rise = (rowOf.get(maxX) as number) - (rowOf.get(minX) as number);
    const run = maxX - minX;
    const deckDeg = (Math.atan2(Math.abs(rise), Math.abs(run)) * 180) / Math.PI;
    expect(deckDeg).toBeGreaterThan(8);
    expect(deckDeg).toBeLessThan(82);

    // And so the parapet must not be. Before the fix every box was a tile
    // side and this share was 1.00.
    const axial = boxes.filter((b) => offAxis(b.bearing) < 5).length;
    expect(axial / boxes.length).toBeLessThan(0.1);
  });

  it('runs straight, rather than stepping half a tile every few tiles', () => {
    const boxes = inSpan(parapets(map));
    expect(boxes.length).toBeGreaterThan(40);

    // Split into the two sides of the span: fit one line through everything
    // (both parapets are parallel and symmetric about the carriageway, so it
    // comes out along the span) and cut on which side of it a box falls.
    let mx = 0;
    let my = 0;
    for (const b of boxes) {
      mx += b.x;
      my += b.y;
    }
    mx /= boxes.length;
    my /= boxes.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const b of boxes) {
      sxx += (b.x - mx) * (b.x - mx);
      syy += (b.y - my) * (b.y - my);
      sxy += (b.x - mx) * (b.y - my);
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const nx = -Math.sin(theta);
    const ny = Math.cos(theta);
    const left = boxes.filter((b) => (b.x - mx) * nx + (b.y - my) * ny > 0);
    const right = boxes.filter((b) => (b.x - mx) * nx + (b.y - my) * ny <= 0);
    expect(left.length).toBeGreaterThan(15);
    expect(right.length).toBeGreaterThan(15);

    // A tile-stepped parapet strays half a tile from its own best-fit line by
    // construction — the tread is flat and the riser is a whole tile, so the
    // line splits the difference. Half of that is the gate: anything at or
    // above it is a staircase a half-tile bevel cannot reach, which is what
    // `built-staircase` is counting.
    expect(strayFromBestLine(left)).toBeLessThan(0.25);
    expect(strayFromBestLine(right)).toBeLessThan(0.25);
  });

  it('still refuses an abutment, and still covers every deck/water face', () => {
    // The rule the old per-tile walk got right and must not be lost: a
    // parapet stands where there is river to fall into, not where the deck
    // runs onto the bank. Every parapet box must have open water within a
    // tile and a half of it.
    const boxes = parapets(map);
    expect(boxes.length).toBeGreaterThan(400);
    let dry = 0;
    for (const b of boxes) {
      let wet = false;
      for (let dy = -1; dy <= 1 && !wet; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = Math.floor(b.x / TILE_SIZE) + dx;
          const ty = Math.floor(b.y / TILE_SIZE) + dy;
          if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
          if (map.tiles[ty * map.widthTiles + tx] === T_WATER) {
            wet = true;
            break;
          }
        }
      }
      if (!wet) dry++;
    }
    expect(dry).toBe(0);

    // And the parapet is CONTINUOUS. Not by total length — a curve is SHORTER
    // than the staircase it replaces, by exactly the factor a diagonal's
    // Manhattan length exceeds its own, so "at least as long as the tile
    // perimeter" is a gate the correct answer fails. By its JOINTS: each box
    // ends where the next begins, so a loose end is a hole in the parapet.
    //
    // This is the check that catches the gapped first draft of this fix,
    // where the "is that the river" probe was still the old third of a tile
    // and landed back on the deck's own square on 104 of 877 chords
    // (`evidence/iter8/rail-probe.mjs`). Each of those is two loose ends.
    const ends: Array<[number, number]> = [];
    for (const b of boxes) {
      const dx = (Math.cos(b.bearing) * b.len) / 2;
      const dy = (Math.sin(b.bearing) * b.len) / 2;
      ends.push([b.x - dx, b.y - dy], [b.x + dx, b.y + dy]);
    }
    // A joint is two ends within a fifth of a tile: the boxes are set inboard
    // by half their width and lengthened by a seam, so two that meet on a
    // bend do so a fraction of a pixel apart rather than exactly.
    const JOIN = TILE_SIZE / 5;
    let loose = 0;
    for (let i = 0; i < ends.length; i++) {
      const [x, y] = ends[i] as [number, number];
      let met = false;
      for (let j = 0; j < ends.length && !met; j++) {
        if ((j >> 1) === (i >> 1)) continue; // the other end of the same box
        const [ox, oy] = ends[j] as [number, number];
        if (Math.abs(ox - x) <= JOIN && Math.abs(oy - y) <= JOIN) met = true;
      }
      if (!met) loose++;
    }
    // The city's bridges have a finite number of runs, and every run has two
    // real ends where the deck reaches its abutment. Sixty is generous room
    // for those on a map with four spans and their approaches; a hundred and
    // four refused chords would put this at over two hundred.
    expect(loose).toBeLessThan(60);
  });
});

/** The area of a tile-local polygon, in tile^2. */
function area(poly: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as [number, number];
    const [xj, yj] = poly[j] as [number, number];
    a += xj * yi - xi * yj;
  }
  return Math.abs(a) / 2;
}

/**
 * 2D and 3D agreeing about where the deck edge is.
 *
 * They can only disagree in one place and it is worth naming: the SIDE. Both
 * painters read one `buildDeckCut` chain, but they cut with it differently —
 * the 3D prism asks `shoreHalf(seg, false)` for the deck half, while the
 * painted ground plane's cutout walks the chain's runs and takes the sign of
 * a cross product per sub-texel (`paintGroundChunk`). Two implementations of
 * "which side is the river", and a flip in either would put tarmac where the
 * water is in exactly one of the two renderers — which, because the 3D city's
 * ground surface IS the 2D painter's own canvas, shows as deck painted on one
 * side of the line with its fascia standing on the other.
 *
 * So: run both rules over every chain on the shipped map and require them to
 * agree everywhere. The cross-product rule is TRANSCRIBED from the painter
 * rather than called, so this fails if the painter's convention is changed
 * out from under the chain — which is the failure a test that called into it
 * would not see.
 */
describe('2D and 3D agree about which side of the deck edge is river', () => {
  it('gives the same answer at every sub-texel of every cut tile', () => {
    const cut = buildDeckCut(map.tiles, map.widthTiles, map.heightTiles, map.courses);
    expect(cut.size).toBeGreaterThan(400);

    /** The painted ground plane's own rule, transcribed from `TileLayer`. */
    const wetByCutMask = (seg: Float32Array, ux: number, uy: number): boolean => {
      let wet = false;
      for (let k = 0; k + 3 < seg.length; k += 2) {
        const ax = seg[k] as number;
        const ay = seg[k + 1] as number;
        const vx = (seg[k + 2] as number) - ax;
        const vy = (seg[k + 3] as number) - ay;
        wet = vx * (uy - ay) - vy * (ux - ax) > 0;
      }
      return wet;
    };

    /** Is a point inside the polygon the 3D prism's top face covers? */
    const inPoly = (poly: Array<[number, number]>, x: number, y: number): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i] as [number, number];
        const [xj, yj] = poly[j] as [number, number];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };

    // The painter's own sub-texel grid: 8 a side, `CUT_SUB`.
    const SUB = 8;
    let sampled = 0;
    let disagree = 0;
    let wetSamples = 0;
    let drySamples = 0;
    for (const seg of cut.values()) {
      const dry = shoreHalf(seg, false);
      const wetHalf = shoreHalf(seg, true);
      // The two halves partition the square: a chord through it leaves
      // nothing over and counts nothing twice.
      expect(area(dry) + area(wetHalf)).toBeCloseTo(1, 6);
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const ux = (sx + 0.5) / SUB;
          const uy = (sy + 0.5) / SUB;
          sampled++;
          const wetHere = wetByCutMask(seg, ux, uy);
          if (wetHere) wetSamples++;
          else drySamples++;
          if (wetHere !== !inPoly(dry, ux, uy)) disagree++;
        }
      }
    }
    // Staging before conclusion. "The two rules agree" is worth nothing if
    // one of the two answers never comes up — a rule that says DRY at every
    // sample agrees perfectly with a rule that says DRY at every sample, and
    // this exercise has already lost four instruments to exactly that shape.
    // So: the samples exist, and BOTH answers really occur in them.
    expect(sampled).toBeGreaterThan(25000);
    expect(wetSamples).toBeGreaterThan(5000);
    expect(drySamples).toBeGreaterThan(5000);
    expect(disagree).toBe(0);
  });
});
