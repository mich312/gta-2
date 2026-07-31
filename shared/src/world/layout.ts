import { latticeHash } from './fields.js';
import type { CityPlan, PlanAvenue, PlanDistrict } from './plan.js';
import {
  DISTRICT_TYPES,
  T_BANK,
  T_BRIDGE,
  T_FIELD,
  T_ROAD,
  T_SAND,
  T_WATER,
  type BlockRect,
  type DistrictType,
} from './types.js';

/**
 * The authored plan (`plan.ts`) expanded into ground: water, districts,
 * streets, bridges, shores and the block rectangles the fill passes build in.
 *
 * Everything here is a pure function of the plan — no seed, no window, no
 * noise field deciding where a city goes. The one hashed thing is the
 * coastline wobble, and it is hashed off the plan's own chunk indices so that
 * editing the picture moves only the shore the edit touched.
 */

/** A block, plus which authored landmark (if any) has claimed it. */
export interface LayoutBlock extends BlockRect {
  /** Index into `plan.landmarks`, or -1. A claimed block is not built on. */
  landmark: number;
}

export interface CityLayout {
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
  district: Uint8Array;
  blocks: LayoutBlock[];
  /** 1 where the coast picture says water, before roads bridged any of it. */
  water: Uint8Array;
  /** Which district entry owns each tile; -1 outside every borough. */
  owner: Int16Array;
}

const DISTRICT_IDX: Record<DistrictType, number> = Object.fromEntries(
  DISTRICT_TYPES.map((d, i) => [d, i]),
) as Record<DistrictType, number>;

/**
 * The coastline: the plan's chunk picture, corner-rounded and edge-worn.
 *
 * A raster of the picture alone would give the islands square corners on an
 * eight-tile grid, which reads as a tilemap rather than as a coast. Convex
 * corners are cut back on the diagonal and concave ones filled in, and each
 * straight run of shore is eroded by nought to two tiles from a hash of the
 * chunk it belongs to — so the shore is ragged, and identical every time,
 * and an edit to one part of the picture cannot move the shore anywhere else.
 */
function paintCoast(plan: CityPlan): Uint8Array {
  const c = plan.chunkTiles;
  const cw = (plan.coast[0] as string).length;
  const ch = plan.coast.length;
  const W = plan.widthTiles;
  const H = plan.heightTiles;
  const land = (cx: number, cy: number): boolean =>
    cx >= 0 && cy >= 0 && cx < cw && cy < ch && (plan.coast[cy] as string)[cx] === '#';

  const WOBBLE = 0x5ea50fa1;
  /** How many tiles of this chunk's shore have been eaten away, 0..2. */
  const wear = (cx: number, cy: number, edge: number): number =>
    Math.floor(latticeHash(WOBBLE, cx * 4 + edge, cy) * 3);

  const water = new Uint8Array(W * H);
  const R = Math.max(2, Math.floor(c / 2) - 1);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const cx = Math.floor(tx / c);
      const cy = Math.floor(ty / c);
      const lx = tx - cx * c;
      const ly = ty - cy * c;
      // The corner of this chunk the tile sits nearest, and how far it is
      // from that corner along each axis.
      const hx = lx < c / 2 ? -1 : 1;
      const hy = ly < c / 2 ? -1 : 1;
      const dx = hx < 0 ? lx : c - 1 - lx;
      const dy = hy < 0 ? ly : c - 1 - ly;
      const here = land(cx, cy);
      const acrossX = land(cx + hx, cy);
      const acrossY = land(cx, cy + hy);

      let wet: boolean;
      if (here) {
        // Cut the diagonal off a headland; wear back a straight shore.
        if (!acrossX && !acrossY && !land(cx + hx, cy + hy)) wet = dx + dy < R;
        else if (!acrossX) wet = dx < wear(cx, cy, hx < 0 ? 0 : 1);
        else if (!acrossY) wet = dy < wear(cx, cy, hy < 0 ? 2 : 3);
        else wet = false;
      } else {
        // Fill the inside of a bay's corner so it is a curve, not a step.
        wet = !(acrossX && acrossY && dx + dy < R);
      }
      if (wet) water[ty * W + tx] = 1;
    }
  }
  return water;
}

/** Whether a road may be carried across water here, along one axis. */
function bridgeable(
  water: Uint8Array,
  W: number,
  H: number,
  tx: number,
  ty: number,
  dx: number,
  dy: number,
  maxSpan: number,
): boolean {
  // Land within maxSpan in BOTH directions, or it is not a crossing: the
  // open sea has no far bank, so a road pointed at it simply stops.
  let ahead = false;
  let behind = false;
  for (let s = 1; s <= maxSpan; s++) {
    const x = tx + dx * s;
    const y = ty + dy * s;
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (water[y * W + x] !== 1) {
      ahead = true;
      break;
    }
  }
  for (let s = 1; s <= maxSpan; s++) {
    const x = tx - dx * s;
    const y = ty - dy * s;
    if (x < 0 || y < 0 || x >= W || y >= H) break;
    if (water[y * W + x] !== 1) {
      behind = true;
      break;
    }
  }
  return ahead && behind;
}

export function buildLayout(plan: CityPlan): CityLayout {
  const W = plan.widthTiles;
  const H = plan.heightTiles;
  const water = paintCoast(plan);
  const tiles = new Uint8Array(W * H);
  const district = new Uint8Array(W * H).fill(DISTRICT_IDX.park);
  const owner = new Int16Array(W * H).fill(-1);
  for (let i = 0; i < tiles.length; i++) tiles[i] = water[i] === 1 ? T_WATER : T_FIELD;

  // Boroughs, in plan order: later rectangles win, so an overlap is an edit
  // rather than an error.
  for (const [di, d] of plan.districts.entries()) {
    const [rx, ry, rw, rh] = d.rect;
    const idx = DISTRICT_IDX[d.district];
    for (let ty = ry; ty < ry + rh; ty++) {
      for (let tx = rx; tx < rx + rw; tx++) {
        district[ty * W + tx] = idx;
        owner[ty * W + tx] = di;
      }
    }
  }

  const carve = (x: number, y: number, w: number, h: number, arterial: boolean): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
        const i = ty * W + tx;
        if (water[i] !== 1) {
          tiles[i] = T_ROAD;
          continue;
        }
        // Over water only an avenue goes, and only where the far bank is
        // close enough to reach: that is what a bridge is.
        if (!arterial) continue;
        const dx = h >= w ? 0 : 1;
        const dy = h >= w ? 1 : 0;
        if (bridgeable(water, W, H, tx, ty, dx, dy, plan.maxBridgeSpan)) tiles[i] = T_BRIDGE;
      }
    }
  };

  const avenue = (a: PlanAvenue): void => {
    const half = Math.floor(a.width / 2);
    if (a.axis === 'h') carve(a.from, a.pos - half, a.to - a.from, a.width, true);
    else carve(a.pos - half, a.from, a.width, a.to - a.from, true);
  };
  for (const a of plan.avenues) avenue(a);

  // Street lattices, one per borough rectangle. Cuts at the rectangle's own
  // edge as well as at every pitch, so two boroughs that meet get one street
  // between them rather than a seam with no way through.
  const cuts = (start: number, extent: number, pitch: number, width: number): number[] => {
    const out = [start];
    if (pitch >= width + 3) for (let p = start + pitch; p < start + extent - width; p += pitch) out.push(p);
    return out;
  };

  const blocks: LayoutBlock[] = [];
  const landmarkAt = (x: number, y: number, w: number, h: number): number => {
    for (const [li, l] of plan.landmarks.entries()) {
      const [lx, ly, lw, lh] = l.rect;
      if (lx < x + w && lx + lw > x && ly < y + h && ly + lh > y) return li;
    }
    return -1;
  };

  /**
   * Is there already road under this proposed street, or right beside it?
   *
   * A lattice cut that lands a tile or two off an avenue does not read as two
   * streets: it reads as one very wide one, and the traffic model agrees —
   * `signals.isJunctionTile` calls any tarmac that is over-wide across BOTH
   * axes a junction, so a five-tile band of road turns the entire avenue into
   * one enormous junction with forty arms. Cuts that would double up on
   * something already carved are dropped, and the blocks either side become
   * one block.
   */
  const doubledUp = (
    pos: number,
    from: number,
    to: number,
    width: number,
    vertical: boolean,
  ): boolean => {
    const CLEAR = 3;
    let conflicts = 0;
    let n = 0;
    for (let a = from; a < to; a += 3) {
      n++;
      for (let b = pos - CLEAR; b < pos + width + CLEAR; b++) {
        const tx = vertical ? b : a;
        const ty = vertical ? a : b;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = tiles[ty * W + tx] as number;
        if (t === T_ROAD || t === T_BRIDGE) {
          conflicts++;
          break;
        }
      }
    }
    // A street CROSSING this one conflicts near the crossing and nowhere
    // else, so a handful of hits is normal; one running ALONGSIDE conflicts
    // the whole way down.
    return n > 0 && conflicts * 5 >= n * 2;
  };

  for (const d of plan.districts) {
    const [rx, ry, rw, rh] = d.rect;
    const { pitchX, pitchY, width } = d.street;
    // Cut positions stay in the list whether or not they get carved: where
    // one was dropped there is already road, so it still bounds a block.
    const xs = cuts(rx, rw, pitchX, width);
    const ys = cuts(ry, rh, pitchY, width);
    for (const x of xs) if (!doubledUp(x, ry, ry + rh, width, true)) carve(x, ry, width, rh, false);
    for (const y of ys) if (!doubledUp(y, rx, rx + rw, width, false)) carve(rx, y, rw, width, false);

    for (let j = 0; j < ys.length; j++) {
      const by = (ys[j] as number) + width;
      const bh = (j + 1 < ys.length ? (ys[j + 1] as number) : ry + rh) - by;
      if (bh < 4) continue;
      for (let i = 0; i < xs.length; i++) {
        const bx = (xs[i] as number) + width;
        const bw = (i + 1 < xs.length ? (xs[i + 1] as number) : rx + rw) - bx;
        if (bw < 4) continue;
        // A block that is mostly bay is not a block. Two fifths of dry land
        // is enough to be worth a kerb; below that the shore reads better
        // with nothing on it.
        let dry = 0;
        for (let ty = by; ty < by + bh; ty++) {
          for (let tx = bx; tx < bx + bw; tx++) if (water[ty * W + tx] !== 1) dry++;
        }
        if (dry * 5 < bw * bh * 2) continue;
        blocks.push({
          x: bx,
          y: by,
          w: bw,
          h: bh,
          district: d.district,
          rural: d.rural,
          landmark: d.rural ? -1 : landmarkAt(bx, by, bw, bh),
        });
      }
    }
  }

  // Shores, last of the ground passes and before anything is built: the strip
  // where land meets water is nobody's block. The city gets a stone quay one
  // tile deep, the countryside a beach two tiles up the sand.
  const wetAt = (tx: number, ty: number): boolean =>
    tx < 0 || ty < 0 || tx >= W || ty >= H ? false : water[ty * W + tx] === 1;
  const wetNear = (tx: number, ty: number, r: number): boolean => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if ((dx !== 0 || dy !== 0) && wetAt(tx + dx, ty + dy)) return true;
      }
    }
    return false;
  };
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_FIELD) continue;
      const d = DISTRICT_TYPES[district[i] as number] as DistrictType;
      const urban = d !== 'park';
      if (wetAt(tx + 1, ty) || wetAt(tx - 1, ty) || wetAt(tx, ty + 1) || wetAt(tx, ty - 1)) {
        tiles[i] = urban ? T_BANK : T_SAND;
      } else if (!urban && wetNear(tx, ty, 2)) {
        tiles[i] = T_SAND;
      }
    }
  }

  // A street does not end in the sea. Carriageway that touches open water
  // becomes quay — the walkable stone strip a hull moors against — unless it
  // is the approach to a bridge, where ending at the water is the point.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      if (tiles[i] !== T_ROAD) continue;
      if (!(wetAt(tx + 1, ty) || wetAt(tx - 1, ty) || wetAt(tx, ty + 1) || wetAt(tx, ty - 1))) continue;
      const onBridge =
        tiles[i + 1] === T_BRIDGE ||
        tiles[i - 1] === T_BRIDGE ||
        (ty + 1 < H && tiles[i + W] === T_BRIDGE) ||
        (ty > 0 && tiles[i - W] === T_BRIDGE);
      if (!onBridge) tiles[i] = T_BANK;
    }
  }

  // Orphan carriageway: the scraps a street leaves behind when the quay ate
  // the rest of it, and the odd length of road stranded on a spit the plan
  // put no crossing to. They are not streets — nothing can drive off them —
  // but they are road as far as the traffic model is concerned, and an
  // ambient car spawned on one is a car that can never get anywhere and a
  // route planner that returns null. Only the network survives.
  const label = new Int32Array(W * H).fill(-1);
  const members: number[][] = [];
  const isRoad = (i: number): boolean => tiles[i] === T_ROAD || tiles[i] === T_BRIDGE;
  for (let s0 = 0; s0 < tiles.length; s0++) {
    if (!isRoad(s0) || (label[s0] as number) >= 0) continue;
    const id = members.length;
    const bag: number[] = [s0];
    label[s0] = id;
    for (let q = 0; q < bag.length; q++) {
      const i = bag[q] as number;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if ((label[j] as number) >= 0 || !isRoad(j)) continue;
        label[j] = id;
        bag.push(j);
      }
    }
    members.push(bag);
  }
  let biggest = 0;
  let roadTiles = 0;
  for (const bag of members) {
    roadTiles += bag.length;
    if (bag.length > (members[biggest] as number[]).length) biggest = members.indexOf(bag);
  }
  // If pruning would take most of the city with it, the plan is broken — a
  // bridge that does not land, most likely — and quietly deleting half the
  // streets is the worst possible way to report that.
  const kept = members.length > 0 ? (members[biggest] as number[]).length : 0;
  if (roadTiles > 0 && kept * 5 < roadTiles * 3) {
    throw new Error(
      `city plan: the road network is in pieces — the largest holds ${kept} of ${roadTiles} tiles`,
    );
  }
  for (const [id, bag] of members.entries()) {
    if (id === biggest) continue;
    for (const i of bag) tiles[i] = T_FIELD;
  }

  return { widthTiles: W, heightTiles: H, tiles, district, blocks, water, owner };
}

/** The borough entry that owns a tile, or null out in the open. */
export function districtOwnerAt(
  plan: CityPlan,
  layout: CityLayout,
  tx: number,
  ty: number,
): PlanDistrict | null {
  if (tx < 0 || ty < 0 || tx >= layout.widthTiles || ty >= layout.heightTiles) return null;
  const i = layout.owner[ty * layout.widthTiles + tx] as number;
  return i < 0 ? null : (plan.districts[i] as PlanDistrict);
}
