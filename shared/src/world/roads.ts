import { deriveSeed, nextIntRange, seedRng } from '../rng/prng.js';
import type { WorldgenParams } from './params.js';
import { DISTRICT_TYPES, T_ROAD, type BlockRect, type DistrictType } from './types.js';

/**
 * L2 of the layer stack, unbounded: an infinite jittered arterial lattice,
 * with the ground between arterials divided into CELLS — and the cell is
 * the unit of chunk-local generation. Everything inside a cell (secondary
 * roads, blocks, and downstream: buildings, landmarks, shops) derives its
 * randomness from hash(seed, cell index), never from a shared stream and
 * never from the window, so ANY window that contains a cell materialises
 * the identical cell. That property is what makes the world nearly
 * infinite: the map is a viewport, not a place.
 */

export interface WorldCell {
  /** Lattice indices (can be negative: the lattice runs forever). */
  i: number;
  j: number;
  /** Interior rect between the arterial bands, in GLOBAL tiles. */
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  /** This cell's blocks, in WINDOW-LOCAL tiles (may overhang the window). */
  blocks: BlockRect[];
}

export interface RoadsResult {
  cells: WorldCell[];
  /** Tiles carved by an ARTERIAL specifically — the only roads that bridge. */
  arterialMask: Uint8Array;
}

/**
 * Centre of arterial lattice line k on an axis: pitch plus hashed jitter.
 * A pure function of (seed, axis, k) — line 40 000 is as cheap and as
 * deterministic as line 4.
 */
export function arterialCoord(
  seed: number,
  axis: 'x' | 'y',
  k: number,
  spacing: number,
): number {
  const u = (deriveSeed(seed, `arterial.${axis}.${k}`) >>> 0) / 4294967296;
  return Math.round(k * spacing + (u - 0.5) * spacing * 0.5);
}

export function generateRoads(
  tiles: Uint8Array,
  params: WorldgenParams,
  districtIdxAt: (gx: number, gy: number) => number,
  seed: number,
): RoadsResult {
  const wx = params.windowX;
  const wy = params.windowY;
  const W = params.widthTiles;
  const H = params.heightTiles;
  const aw = params.arterialWidth;
  const sw = params.secondaryWidth;
  const sp = params.arterialSpacing;
  const half = Math.floor(aw / 2);

  const arterialMask = new Uint8Array(W * H);

  /** Carve a GLOBAL rect as road, clipped to the window. */
  const carveG = (gx: number, gy: number, gw: number, gh: number, arterial: boolean): void => {
    const x1 = Math.max(0, gx - wx);
    const y1 = Math.max(0, gy - wy);
    const x2 = Math.min(W, gx + gw - wx);
    const y2 = Math.min(H, gy + gh - wy);
    for (let ty = y1; ty < y2; ty++) {
      for (let tx = x1; tx < x2; tx++) {
        tiles[ty * W + tx] = T_ROAD;
        if (arterial) arterialMask[ty * W + tx] = 1;
      }
    }
  };

  // Arterial lattice lines whose band can touch the window. Jitter is at
  // most spacing/4, so one line of slack each side is plenty.
  const kx0 = Math.floor(wx / sp) - 1;
  const kx1 = Math.ceil((wx + W) / sp) + 1;
  const ky0 = Math.floor(wy / sp) - 1;
  const ky1 = Math.ceil((wy + H) / sp) + 1;
  for (let k = kx0; k <= kx1; k++) {
    carveG(arterialCoord(seed, 'x', k, sp) - half, wy, aw, H, true);
  }
  for (let k = ky0; k <= ky1; k++) {
    carveG(wx, arterialCoord(seed, 'y', k, sp) - half, W, aw, true);
  }

  // Cells between adjacent lattice lines, for every cell whose interior
  // intersects the window. The subdivision below runs in GLOBAL coords with
  // the cell's own derived rng, so a cell half-visible in this window comes
  // out identical to the same cell fully visible in another.
  const cells: WorldCell[] = [];
  for (let j = ky0; j < ky1; j++) {
    const top = arterialCoord(seed, 'y', j, sp) - half + aw;
    const bottom = arterialCoord(seed, 'y', j + 1, sp) - half;
    for (let i = kx0; i < kx1; i++) {
      const left = arterialCoord(seed, 'x', i, sp) - half + aw;
      const right = arterialCoord(seed, 'x', i + 1, sp) - half;
      const gw = right - left;
      const gh = bottom - top;
      if (gw < 3 || gh < 3) continue;
      if (left >= wx + W || left + gw <= wx || top >= wy + H || top + gh <= wy) continue;

      const cell: WorldCell = { i, j, gx: left, gy: top, gw, gh, blocks: [] };
      let rng = seedRng(deriveSeed(seed, `cell.roads.${i}.${j}`));

      // Recursive subdivision to the local district's block size — the same
      // algorithm the bounded generator used, FIFO queue and all, just fed
      // by the cell's own stream and speaking global coordinates.
      const queue: Array<{ x: number; y: number; w: number; h: number }> = [
        { x: left, y: top, w: gw, h: gh },
      ];
      while (queue.length > 0) {
        const r = queue.shift() as { x: number; y: number; w: number; h: number };
        const districtIdx = districtIdxAt(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
        const district = DISTRICT_TYPES[districtIdx] as DistrictType;
        const [minB, maxB] = params.blockSize[district];

        const splitW = r.w > maxB;
        const splitH = r.h > maxB;
        if (!splitW && !splitH) {
          if (r.w >= 3 && r.h >= 3) {
            cell.blocks.push({ x: r.x - wx, y: r.y - wy, w: r.w, h: r.h, district });
          }
          continue;
        }
        if (splitW && (!splitH || r.w >= r.h)) {
          const lo = r.x + Math.max(3, Math.floor(minB / 2));
          const hi = r.x + r.w - Math.max(3, Math.floor(minB / 2)) - sw;
          if (hi <= lo) {
            cell.blocks.push({ x: r.x - wx, y: r.y - wy, w: r.w, h: r.h, district });
            continue;
          }
          let cut: number;
          [cut, rng] = nextIntRange(rng, lo, hi + 1);
          carveG(cut, r.y, sw, r.h, false);
          queue.push({ x: r.x, y: r.y, w: cut - r.x, h: r.h });
          queue.push({ x: cut + sw, y: r.y, w: r.x + r.w - cut - sw, h: r.h });
        } else {
          const lo = r.y + Math.max(3, Math.floor(minB / 2));
          const hi = r.y + r.h - Math.max(3, Math.floor(minB / 2)) - sw;
          if (hi <= lo) {
            cell.blocks.push({ x: r.x - wx, y: r.y - wy, w: r.w, h: r.h, district });
            continue;
          }
          let cut: number;
          [cut, rng] = nextIntRange(rng, lo, hi + 1);
          carveG(r.x, cut, r.w, sw, false);
          queue.push({ x: r.x, y: r.y, w: r.w, h: cut - r.y });
          queue.push({ x: r.x, y: cut + sw, w: r.w, h: r.y + r.h - cut - sw });
        }
      }

      // Keep only blocks that touch the window at all; the rest belong to
      // other viewports.
      cell.blocks = cell.blocks.filter(
        (b) => b.x < W && b.x + b.w > 0 && b.y < H && b.y + b.h > 0,
      );
      cells.push(cell);
    }
  }
  return { cells, arterialMask };
}
