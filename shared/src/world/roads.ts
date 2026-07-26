import { nextIntRange, nextRange } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import {
  DISTRICT_TYPES,
  T_ROAD,
  tileAt,
  type BlockRect,
  type CityMap,
  type DistrictType,
} from './types.js';

export interface RoadSpan {
  /** Contiguous road tiles before (tx,ty) along the axis. */
  before: number;
  /** Total contiguous road width through (tx,ty) along the axis. */
  width: number;
}

/**
 * Width of the contiguous road span through (tx,ty) along one axis, capped at
 * `cap` tiles per side. On a corridor the crossing axis reads the road's true
 * width; along the corridor it reads long. Both long ⇒ an intersection box.
 * Used by traffic AI, worldgen amenities, and (duplicated for chunk baking)
 * the client ground renderer.
 */
export function roadSpanAt(
  map: CityMap,
  tx: number,
  ty: number,
  axisX: boolean,
  cap = 8,
): RoadSpan {
  const sx = axisX ? 1 : 0;
  const sy = axisX ? 0 : 1;
  let before = 0;
  while (before < cap && tileAt(map, tx - sx * (before + 1), ty - sy * (before + 1)) === T_ROAD) {
    before++;
  }
  let after = 0;
  while (after < cap && tileAt(map, tx + sx * (after + 1), ty + sy * (after + 1)) === T_ROAD) {
    after++;
  }
  return { before, width: before + after + 1 };
}

/** True when (tx,ty) sits inside an intersection box (long spans both ways). */
export function isIntersectionTile(map: CityMap, tx: number, ty: number): boolean {
  if (tileAt(map, tx, ty) !== T_ROAD) return false;
  return roadSpanAt(map, tx, ty, true).width > 6 && roadSpanAt(map, tx, ty, false).width > 6;
}

export interface RoadsResult {
  blocks: BlockRect[];
  rng: number;
}

function carveRect(
  tiles: Uint8Array,
  W: number,
  H: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const x1 = Math.max(0, x);
  const y1 = Math.max(0, y);
  const x2 = Math.min(W, x + w);
  const y2 = Math.min(H, y + h);
  for (let ty = y1; ty < y2; ty++) {
    for (let tx = x1; tx < x2; tx++) {
      tiles[ty * W + tx] = T_ROAD;
    }
  }
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Arterial grid with jittered offsets, then recursive subdivision of each
 * region with secondary roads until block extents fit the local district's
 * target range. Deterministic: FIFO queue, fixed rng order.
 */
export function generateRoads(
  tiles: Uint8Array,
  params: WorldgenParams,
  districtIdxAt: (tx: number, ty: number) => number,
  rng: number,
): RoadsResult {
  const W = params.widthTiles;
  const H = params.heightTiles;
  const aw = params.arterialWidth;
  const sw = params.secondaryWidth;

  // Arterial centre positions, jittered inside their band.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i <= params.arterialsX; i++) {
    const band = W / (params.arterialsX + 1);
    let jitter: number;
    [jitter, rng] = nextRange(rng, -band * 0.25, band * 0.25);
    xs.push(Math.round(band * i + jitter));
  }
  for (let i = 1; i <= params.arterialsY; i++) {
    const band = H / (params.arterialsY + 1);
    let jitter: number;
    [jitter, rng] = nextRange(rng, -band * 0.25, band * 0.25);
    ys.push(Math.round(band * i + jitter));
  }
  for (const x of xs) carveRect(tiles, W, H, x - Math.floor(aw / 2), 0, aw, H);
  for (const y of ys) carveRect(tiles, W, H, 0, y - Math.floor(aw / 2), W, aw);

  // Initial regions between arterials (and the map edge).
  const xCuts = [0, ...xs.map((x) => x - Math.floor(aw / 2)), W];
  const yCuts = [0, ...ys.map((y) => y - Math.floor(aw / 2)), H];
  const queue: Region[] = [];
  for (let yi = 0; yi + 1 < yCuts.length; yi++) {
    for (let xi = 0; xi + 1 < xCuts.length; xi++) {
      const x = xi === 0 ? 0 : (xCuts[xi] as number) + aw;
      const y = yi === 0 ? 0 : (yCuts[yi] as number) + aw;
      const x2 = xCuts[xi + 1] as number;
      const y2 = yCuts[yi + 1] as number;
      if (x2 - x >= 3 && y2 - y >= 3) queue.push({ x, y, w: x2 - x, h: y2 - y });
    }
  }

  const blocks: BlockRect[] = [];
  while (queue.length > 0) {
    const r = queue.shift() as Region;
    const districtIdx = districtIdxAt(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
    const district = DISTRICT_TYPES[districtIdx] as DistrictType;
    const [minB, maxB] = params.blockSize[district];

    const splitW = r.w > maxB;
    const splitH = r.h > maxB;
    if (!splitW && !splitH) {
      if (r.w >= 3 && r.h >= 3) blocks.push({ ...r, district });
      continue;
    }
    // Split the longer offending axis.
    if (splitW && (!splitH || r.w >= r.h)) {
      const lo = r.x + Math.max(3, Math.floor(minB / 2));
      const hi = r.x + r.w - Math.max(3, Math.floor(minB / 2)) - sw;
      if (hi <= lo) {
        blocks.push({ ...r, district });
        continue;
      }
      let cut: number;
      [cut, rng] = nextIntRange(rng, lo, hi + 1);
      carveRect(tiles, W, H, cut, r.y, sw, r.h);
      queue.push({ x: r.x, y: r.y, w: cut - r.x, h: r.h });
      queue.push({ x: cut + sw, y: r.y, w: r.x + r.w - cut - sw, h: r.h });
    } else {
      const lo = r.y + Math.max(3, Math.floor(minB / 2));
      const hi = r.y + r.h - Math.max(3, Math.floor(minB / 2)) - sw;
      if (hi <= lo) {
        blocks.push({ ...r, district });
        continue;
      }
      let cut: number;
      [cut, rng] = nextIntRange(rng, lo, hi + 1);
      carveRect(tiles, W, H, r.x, cut, r.w, sw);
      queue.push({ x: r.x, y: r.y, w: r.w, h: cut - r.y });
      queue.push({ x: r.x, y: cut + sw, w: r.w, h: r.y + r.h - cut - sw });
    }
  }
  return { blocks, rng };
}
