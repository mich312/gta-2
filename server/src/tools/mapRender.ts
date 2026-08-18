import { laneOffset, type Lanes } from 'shared';
import { readFileSync } from 'node:fs';
import {
  DISTRICT_TYPES,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_WATER,
  T_BRIDGE,
  T_BANK,
  T_TREES,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
  T_FLOOR,
  bevelOther,
  inCutHalf,
} from 'shared';
import { courseJunctions, type RoadNet } from 'shared';
import { hexToRgb } from './png.js';

/**
 * Drawing a map, for the tools that look at one.
 *
 * Split out of `mapgen.ts` when a second tool needed it: `plangen.ts` renders
 * a city that has been baked but never shipped, so what the painter is handed
 * has to be the tiles and nothing else — no session, no furniture, no
 * `CityMap`. `RenderableMap` is that minimum, and a `CityMap` satisfies it.
 */

/** The least a thing can be and still be drawable. */
export interface RenderableMap {
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
  district: Uint8Array;
  bevel?: Uint8Array | undefined;
  /**
   * The coastline as closed polylines (WORLDGEN.md §18). Given, the painter
   * shades the coast against the CURVE instead of the tile edge, which is
   * the only way a still can show what the change is for: at two pixels a
   * tile a half-tile bevel is one pixel, and a smooth coast and a stepped
   * one are the same picture.
   */
  shores?: ReadonlyArray<{ points: Array<readonly [number, number]>; land: boolean }> | undefined;
  banks?: ReadonlyArray<{ points: Array<readonly [number, number]>; land: boolean }> | undefined;
  /**
   * The road network as a graph (WORLDGEN.md §40). Given AND asked for, the
   * painter strokes every street between two junctions along the tiles the
   * flood ran through and dots every junction — which is the coverage claim
   * as a picture rather than a count.
   */
  roadNet?: RoadNet | undefined;
  /**
   * The lanes on that graph (WORLDGEN.md §42). Given AND asked for, the
   * painter draws each street's own line and the kerb lane a car keeps to
   * going each way along it — which is the claim "the graph knows where the
   * road is and which side of it you drive on" as a picture.
   */
  lanes?: Lanes | undefined;
  /**
   * The authored road centrelines (WORLDGEN.md §16), in tile units.
   *
   * Without these the tool draws the RASTER of the roads and nothing else,
   * which is how every §16/§21 painting defect stayed invisible to the review
   * loop the docs point at: doubled centre lines, dashes through junctions and
   * ribbon spilling off the carriageway are all properties of the curve layer,
   * and a per-tile colour fill cannot show any of them (VECTOR.md §1.1).
   */
  courses?: ReadonlyArray<{
    points: Array<readonly [number, number]>;
    width: number;
    kind: string;
  }>;
  /**
   * Buildings, so a turned one is drawn as the mass it is drawn as in the
   * game (§20) rather than as the square of tiles underneath it.
   */
  buildings?: ReadonlyArray<{
    x: number;
    y: number;
    w: number;
    h: number;
    angle?: number | undefined;
    district: string;
  }>;
  shops?: ReadonlyArray<{ kind: string; doorX: number; doorY: number }>;
  playerSpawns?: ReadonlyArray<{ x: number; y: number }>;
  /** Gang territory, for the `--turf` wash. Absent on a bare fixture. */
  turfCells?: Uint8Array | undefined;
  turfCellsWide?: number | undefined;
  turfCellTiles?: number | undefined;
  turfHomes?: ReadonlyArray<{ x: number; y: number; gang: number }> | undefined;
}

export interface PaletteFile {
  field: string;
  road: string;
  sidewalk: string;
  park: string;
  lot: string;
  building: Record<string, string>;
  shopGun: string;
  shopClothing: string;
  shopFloor: string;
  roadLane: string;
  water: string;
  bank: string;
  sand: string;
  trees: string;
  runway: string;
  kerb: string;
  uiAccent: string;
}


export interface Render {
  rgba: Uint8Array;
  w: number;
  h: number;
}

/** Where a pixel falls on a polyline: distance from it, and how far along. */
interface Hit {
  /** Perpendicular distance in render px. */
  d: number;
  /** Arc length from the start of the line, in render px. */
  s: number;
}

/**
 * Stroke a polyline into the buffer, `half` px either side of the centre.
 *
 * Distance-to-nearest-segment rather than filled quads, which is the idiom
 * the shore pass above already uses — and it gives round joins and caps for
 * nothing, which is what `lineJoin = 'round'` gives the client's painter.
 *
 * `dash` is measured in ARC LENGTH along the line, so a dash cadence follows
 * a curve instead of being chopped per segment. That is the whole point of
 * drawing the course rather than its tiles: the client's `setLineDash` does
 * the same thing, and a review tool that dashed per segment would show a
 * cadence the game does not have.
 */
function strokeLine(
  put: (x: number, y: number, c: [number, number, number]) => void,
  W: number,
  H: number,
  pts: ReadonlyArray<readonly [number, number]>,
  half: number,
  color: [number, number, number],
  dash?: { on: number; period: number },
): void {
  if (pts.length < 2) return;
  const reach = Math.max(half, 0.5) + 1;
  // One pass per segment, each claiming only the pixels it is nearest to.
  // `seen` keeps a later segment from repainting a pixel an earlier one owns
  // with a worse arc length, which would break the dash cadence at a joint.
  const best = new Map<number, Hit>();
  let s0 = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k] as readonly [number, number];
    const [bx, by] = pts[k + 1] as readonly [number, number];
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.hypot(vx, vy);
    const len2 = vx * vx + vy * vy || 1;
    const lo = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const hi = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + reach));
    const lo2 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const hi2 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + reach));
    for (let py = lo2; py <= hi2; py++) {
      for (let px = lo; px <= hi; px++) {
        const rx = px + 0.5 - ax;
        const ry = py + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (rx * vx + ry * vy) / len2));
        const d = Math.hypot(rx - t * vx, ry - t * vy);
        if (d > half) continue;
        const i = py * W + px;
        const had = best.get(i);
        if (had !== undefined && had.d <= d) continue;
        best.set(i, { d, s: s0 + t * len });
      }
    }
    s0 += len;
  }
  for (const [i, hit] of best) {
    if (dash !== undefined && hit.s % dash.period >= dash.on) continue;
    const px = i % W;
    put(px, (i - px) / W, color);
  }
}

/** Fill an oriented rectangle given its four corners, in render px. */
function fillQuad(
  put: (x: number, y: number, c: [number, number, number]) => void,
  W: number,
  H: number,
  q: ReadonlyArray<readonly [number, number]>,
  color: [number, number, number],
): void {
  let lo = Infinity;
  let hi = -Infinity;
  let lo2 = Infinity;
  let hi2 = -Infinity;
  for (const [x, y] of q) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
    lo2 = Math.min(lo2, y);
    hi2 = Math.max(hi2, y);
  }
  for (let py = Math.max(0, Math.floor(lo2)); py <= Math.min(H - 1, Math.ceil(hi2)); py++) {
    for (let px = Math.max(0, Math.floor(lo)); px <= Math.min(W - 1, Math.ceil(hi)); px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      // Convex, wound consistently: inside is the same side of all four edges.
      let inside = true;
      for (let k = 0; k < q.length && inside; k++) {
        const [ax, ay] = q[k] as readonly [number, number];
        const [bx, by] = q[(k + 1) % q.length] as readonly [number, number];
        if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) inside = false;
      }
      if (inside) put(px, py, color);
    }
  }
}

/** Render a tile rect of the map at `scale` px per tile, markers included. */
export function render(
  map: RenderableMap,
  palette: PaletteFile,
  x0: number,
  y0: number,
  wTiles: number,
  hTiles: number,
  scale: number,
  net = false,
  lanes = false,
  solid = false,
  isSolidAt?: (x: number, y: number) => boolean,
  /**
   * Gang colours by id (index 0 unused), which turns on the turf wash. The
   * colours live in gangs.json rather than the palette because they are the
   * gangs' own; the caller reads them and hands them over, so this file keeps
   * its one dependency on one palette.
   */
  turfColors?: ReadonlyArray<string>,
): Render {
  const W = wTiles * scale;
  const H = hTiles * scale;
  const rgba = new Uint8Array(W * H * 4);

  const colors: Record<number, [number, number, number]> = {
    [T_FIELD]: hexToRgb(palette.field),
    [T_ROAD]: hexToRgb(palette.road),
    [T_SIDEWALK]: hexToRgb(palette.sidewalk),
    [T_PARK]: hexToRgb(palette.park),
    [T_LOT]: hexToRgb(palette.lot),
    [T_WATER]: hexToRgb(palette.water),
    [T_BANK]: hexToRgb(palette.bank),
    [T_SAND]: hexToRgb(palette.sand),
    [T_TREES]: hexToRgb(palette.trees),
    [T_RUNWAY]: hexToRgb(palette.runway),
    [T_BRIDGE]: hexToRgb(palette.kerb),
    [T_FLOOR]: hexToRgb(palette.shopFloor),
  };

  const put = (x: number, y: number, c: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = 255;
  };

  // Tiles belonging to a building that is drawn as a turned mass. Their
  // ground is painted as PLOT, not as wall, and the mass goes on top later —
  // the client's `paintPlot` rule (§20). Without it the square footprint and
  // the turned mass are both drawn in the building's colour and their union
  // is a blob, which reads as neither shape.
  const massTile = new Uint8Array(map.widthTiles * map.heightTiles);
  for (const b of map.buildings ?? []) {
    if ((b.angle ?? 0) === 0) continue;
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
        massTile[ty * map.widthTiles + tx] = 1;
      }
    }
  }
  /** The nearest ground a plot could be surfaced with. See `plotGround`. */
  const plotGround = (mx: number, my: number): number => {
    let ground = T_SIDEWALK;
    let bd = Infinity;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const sx = mx + ox;
        const sy = my + oy;
        if (sx < 0 || sy < 0 || sx >= map.widthTiles || sy >= map.heightTiles) continue;
        const t = map.tiles[sy * map.widthTiles + sx] as number;
        if (t === T_BUILDING || t === T_WATER || t === T_BRIDGE || t === T_ROAD) continue;
        const d = ox * ox + oy * oy;
        if (d < bd) {
          bd = d;
          ground = t;
        }
      }
    }
    return ground;
  };

  for (let ty = 0; ty < hTiles; ty++) {
    const my = y0 + ty;
    if (my < 0 || my >= map.heightTiles) continue;
    for (let tx = 0; tx < wTiles; tx++) {
      const mx = x0 + tx;
      if (mx < 0 || mx >= map.widthTiles) continue;
      const raw = map.tiles[my * map.widthTiles + mx] as number;
      const tile = raw === T_BUILDING && massTile[my * map.widthTiles + mx] === 1
        ? plotGround(mx, my)
        : raw;
      let c: [number, number, number];
      if (tile === T_BUILDING) {
        const d = DISTRICT_TYPES[map.district[my * map.widthTiles + mx] as number] as string;
        c = hexToRgb(palette.building[d] ?? '#888888');
      } else {
        c = colors[tile] ?? [255, 0, 255];
      }
      // A deck is a road held above the water, and this render used to paint
      // it flat kerb grey, which from above is a pale stripe on the sea
      // (PLAN-MAPDESIGN 1.1). The carriageway wears road; the tiles of it that
      // face open water wear the kerb as a parapet; and the water down-sun of
      // a deck takes its shadow. Three rules, and a crossing stops reading as
      // paint on the ocean.
      if (tile === T_BRIDGE) {
        const wet = (nx: number, ny: number): boolean =>
          nx >= 0 && ny >= 0 && nx < map.widthTiles && ny < map.heightTiles
            ? map.tiles[ny * map.widthTiles + nx] === T_WATER
            : false;
        const edge = wet(mx - 1, my) || wet(mx + 1, my) || wet(mx, my - 1) || wet(mx, my + 1);
        c = edge ? (colors[T_BRIDGE] as [number, number, number]) : hexToRgb(palette.road);
      } else if (tile === T_WATER) {
        // A pier every span along the deck's flanks, for the same reason the
        // shadow is here: it is drawn in world units, so it is still there
        // when the whole map is two pixels a tile.
        const abut = (nx: number, ny: number): boolean =>
          nx >= 0 && ny >= 0 && nx < map.widthTiles && ny < map.heightTiles
            ? map.tiles[ny * map.widthTiles + nx] === T_BRIDGE
            : false;
        if (
          (mx + my) % 9 === 0 &&
          (abut(mx - 1, my) || abut(mx + 1, my) || abut(mx, my - 1) || abut(mx, my + 1))
        ) {
          const w = colors[T_WATER] as [number, number, number];
          c = [
            Math.round((w[0] as number) * 0.4),
            Math.round((w[1] as number) * 0.4),
            Math.round((w[2] as number) * 0.4),
          ];
        }
        for (let d = 1; d <= 2; d++) {
          const sx = mx - d;
          const sy = my - d;
          if (sx < 0 || sy < 0) break;
          if (map.tiles[sy * map.widthTiles + sx] !== T_BRIDGE) continue;
          const w = colors[T_WATER] as [number, number, number];
          const k = d === 1 ? 0.55 : 0.78;
          c = [
            Math.round((w[0] as number) * k),
            Math.round((w[1] as number) * k),
            Math.round((w[2] as number) * k),
          ];
          break;
        }
      }
      // The diagonal shoreline, at whatever this render's scale can show of
      // it: the cut half of a bevelled tile wears the neighbour's colour.
      const code = map.bevel ? (map.bevel[my * map.widthTiles + mx] as number) : 0;
      const oc: [number, number, number] | null = code
        ? (colors[bevelOther(map.tiles, map.bevel as Uint8Array, map.widthTiles, mx, my)] ?? null)
        : null;
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const cut =
            oc !== null && inCutHalf(code, ((px + 0.5) / scale) * 16, ((py + 0.5) / scale) * 16);
          put(tx * scale + px, ty * scale + py, cut ? oc : c);
        }
      }
    }
  }

  // Which side of a set of closed rings each pixel falls on, and against
  // which segment. Shared by the two lines below — the waterline and the
  // shore band's inner edge — because they are the same kind of thing asked
  // the same question.
  //
  // Nearest-segment rather than a proper point-in-polygon test, because the
  // question is only ever asked within a tile of the line, where the two
  // agree everywhere except inside the turn of a very sharp corner — and the
  // disagreement there is a fraction of a pixel at any scale a map is drawn
  // at. The client's painter clips real paths and does not approximate.
  const sidesOf = (
    rings: ReadonlyArray<{ points: Array<readonly [number, number]> }>,
    reach: number,
  ): { side: Int8Array; seg: Int32Array; flat: Float64Array } => {
    const best = new Float32Array(W * H).fill(Infinity);
    const side = new Int8Array(W * H);
    const seg = new Int32Array(W * H).fill(-1);
    const flat: number[] = [];
    for (const loop of rings) {
      const n = loop.points.length;
      for (let k = 0; k < n; k++) {
        const [ax, ay] = loop.points[k] as readonly [number, number];
        const [bx, by] = loop.points[(k + 1) % n] as readonly [number, number];
        // Pixel-space endpoints, relative to the crop.
        const pax = (ax - x0) * scale;
        const pay = (ay - y0) * scale;
        const pbx = (bx - x0) * scale;
        const pby = (by - y0) * scale;
        const at = flat.length;
        flat.push(pax, pay, pbx, pby);
        const pad = reach * scale + 1;
        const lo = Math.max(0, Math.floor(Math.min(pax, pbx) - pad));
        const hi = Math.min(W - 1, Math.ceil(Math.max(pax, pbx) + pad));
        const lo2 = Math.max(0, Math.floor(Math.min(pay, pby) - pad));
        const hi2 = Math.min(H - 1, Math.ceil(Math.max(pay, pby) + pad));
        const vx = pbx - pax;
        const vy = pby - pay;
        const len2 = vx * vx + vy * vy || 1;
        for (let py = lo2; py <= hi2; py++) {
          for (let px = lo; px <= hi; px++) {
            const rx = px + 0.5 - pax;
            const ry = py + 0.5 - pay;
            const t = Math.max(0, Math.min(1, (rx * vx + ry * vy) / len2));
            const dx = rx - t * vx;
            const dy = ry - t * vy;
            const d = Math.hypot(dx, dy);
            const i = py * W + px;
            if (d >= (best[i] as number)) continue;
            best[i] = d;
            seg[i] = at;
            // Water is on the right of travel, and with y down the right of
            // a direction is the direction turned a quarter turn clockwise:
            // the cross product comes out positive there.
            side[i] = vx * ry - vy * rx > 0 ? 1 : -1;
          }
        }
      }
    }
    return { side, seg, flat: Float64Array.from(flat) };
  };

  /** A tile's colour, or null where it is not ground at all. */
  const groundOf = (sx: number, sy: number): [number, number, number] | null => {
    if (sx < 0 || sy < 0 || sx >= map.widthTiles || sy >= map.heightTiles) return null;
    const t = map.tiles[sy * map.widthTiles + sx] as number;
    if (t === T_WATER || t === T_BRIDGE) return null;
    if (t === T_BUILDING) {
      const d = DISTRICT_TYPES[map.district[sy * map.widthTiles + sx] as number] as string;
      return hexToRgb(palette.building[d] ?? '#888888');
    }
    return colors[t] ?? null;
  };

  // The coast, repainted against the curve.
  //
  // Every pixel within about a tile of a shore polyline is re-decided: which
  // side of the line it falls on says whether it is sea or shore, and the
  // material it takes is the one belonging to that side. The tile pass above
  // has already put down a staircase; this walks over the staircase with the
  // line the tiles were a rasterisation OF.
  //
  // Which pixels this pass turned into sea, for the band pass below.
  let wetPixel: Uint8Array | null = null;
  if (map.shores !== undefined && map.shores.length > 0) {
    const { side, seg } = sidesOf(map.shores, 1.1);
    const water = colors[T_WATER] as [number, number, number];
    wetPixel = new Uint8Array(W * H);
    /** The material this side of the line is made of, at this pixel. */
    const landAt = (px: number, py: number): [number, number, number] => {
      const mx = x0 + Math.floor(px / scale);
      const my = y0 + Math.floor(py / scale);
      // Own tile first, then the NEAREST dry one in the ring — nearest by
      // where the pixel actually is, not by a fixed order. A beach is one
      // tile of sand with grass behind it, so "first dry neighbour I find"
      // puts a green notch in the sand every time the search order happens
      // to look inland before it looks along the shore.
      const own = groundOf(mx, my);
      if (own !== null) return own;
      let best: [number, number, number] | null = null;
      let bd = Infinity;
      for (const [dx, dy] of [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as const) {
        const near = groundOf(mx + dx, my + dy);
        if (near === null) continue;
        const cx = (mx + dx + 0.5 - x0) * scale;
        const cy = (my + dy + 0.5 - y0) * scale;
        const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
        if (d < bd) {
          bd = d;
          best = near;
        }
      }
      return best ?? (colors[T_FIELD] as [number, number, number]);
    };
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        if ((seg[i] as number) < 0) continue;
        const wet = side[i] === 1;
        if (wet) (wetPixel as Uint8Array)[i] = 1;
        put(px, py, wet ? water : landAt(px, py));
      }
    }
  }

  // The shore band's inner edge, repainted against the curve (§39), and
  // AFTER the waterline so it can be told where the sea now is.
  //
  // Order was the whole difficulty. The waterline's own pass reaches 1.1
  // tiles inland and repaints each pixel as the TILE it sits in, which is a
  // staircase again — and a quay is 1.5 tiles wide, a pond's beach 1.4, so
  // running the band first meant the coast pass walked back over its outer
  // edge and put the steps straight back. Running it second, and skipping
  // whatever the coast pass called sea, leaves each line drawn by the pass
  // that owns it.
  //
  // Both halves are dry here, so neither can be a fixed colour the way the
  // sea is: each takes the nearest tile centre that falls on its own side of
  // the line. That is the same test the client's `paintBandTile` makes, for
  // the same reason — a wooded cliff foot and the wood behind it are the same
  // tile type, so only the line can say which is which.
  if (map.banks !== undefined && map.banks.length > 0) {
    const { side, seg, flat } = sidesOf(map.banks, 1.6);
    const sideAt = (at: number, px: number, py: number): number => {
      const ax = flat[at] as number;
      const ay = flat[at + 1] as number;
      const vx = (flat[at + 2] as number) - ax;
      const vy = (flat[at + 3] as number) - ay;
      return vx * (py - ay) - vy * (px - ax) > 0 ? 1 : -1;
    };
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        const at = seg[i] as number;
        if (at < 0) continue;
        if (wetPixel !== null && wetPixel[i] === 1) continue;
        const want = side[i] as number;
        const mx = x0 + Math.floor(px / scale);
        const my = y0 + Math.floor(py / scale);
        let bd = Infinity;
        let c: [number, number, number] | null = null;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0], [-1, 0], [0, 1], [0, -1],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ] as const) {
          const near = groundOf(mx + dx, my + dy);
          if (near === null) continue;
          const cx = (mx + dx + 0.5 - x0) * scale;
          const cy = (my + dy + 0.5 - y0) * scale;
          if (sideAt(at, cx, cy) !== want) continue;
          const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
          if (d < bd) {
            bd = d;
            c = near;
          }
        }
        if (c !== null) put(px, py, c);
      }
    }
  }


  // The roads, drawn as the CURVES they are (§16) rather than as the tiles
  // they were rasterised into — in the client's own paint order, because the
  // order IS the behaviour under review: casing for every course, then fill
  // for every course (which is what opens a junction), then edge lines, and
  // last the interior repaint and centre dash course by course, widest last
  // and within a width longest last (§21.2, §23.2).
  //
  // Mirroring the order matters more than mirroring the pixels. A tool that
  // drew each course complete before starting the next would show junctions
  // sealed shut and markings stacked — defects the game does not have — and
  // would hide the ones it does.
  const tPx = scale / 16;
  const lane = Math.max(1, tPx);
  if (map.courses !== undefined && map.courses.length > 0) {
    const road = colors[T_ROAD] as [number, number, number];
    const kerb = hexToRgb(palette.kerb);
    const mark = hexToRgb(palette.roadLane);
    const ribbons = map.courses.map((c) => {
      const pts = c.points.map(
        ([px, py]) => [(px - x0) * scale, (py - y0) * scale] as readonly [number, number],
      );
      let len = 0;
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1] as readonly [number, number];
        const [bx, by] = pts[k] as readonly [number, number];
        len += Math.hypot(bx - ax, by - ay);
      }
      return { pts, w: c.width * scale, len };
    });
    for (const r of ribbons) strokeLine(put, W, H, r.pts, (r.w + 4 * tPx) / 2, kerb);
    for (const r of ribbons) strokeLine(put, W, H, r.pts, r.w / 2, road);
    for (const r of ribbons) strokeLine(put, W, H, r.pts, (r.w - 2 * tPx) / 2, mark);
    // A junction is bare asphalt (§26): the crossings come from the curves,
    // and the dash is masked out of them. The tool has to apply the same rule
    // as the game or it cannot be used to check the game applies it.
    const discs = courseJunctions(map.courses).map((j) => ({
      x: (j.x - x0) * scale,
      y: (j.y - y0) * scale,
      r2: (j.r * scale) ** 2,
    }));
    const bare = (px: number, py: number): boolean => {
      for (const d of discs) {
        const dx = px + 0.5 - d.x;
        const dy = py + 0.5 - d.y;
        if (dx * dx + dy * dy <= d.r2) return false;
      }
      return true;
    };
    const order = [...ribbons].sort((a, b) => a.w - b.w || a.len - b.len);
    for (const r of order) {
      strokeLine(put, W, H, r.pts, (r.w - 4 * tPx) / 2, road);
      strokeLine(
        (px, py, c) => {
          if (bare(px, py)) put(px, py, c);
        },
        W,
        H,
        r.pts,
        lane / 2,
        mark,
        { on: 4 * tPx, period: 10 * tPx },
      );
    }
  }

  // Buildings that face a street, drawn as the mass the game draws (§20).
  // Without this the tool shows a city where §20 never happened, and a plot
  // cutter that turned the wrong way would look correct here.
  for (const b of map.buildings ?? []) {
    const deg = b.angle ?? 0;
    if (deg === 0) continue;
    const rad = (deg * Math.PI) / 180;
    const cx = (b.x + b.w / 2 - x0) * scale;
    const cy = (b.y + b.h / 2 - y0) * scale;
    const hw = (b.w / 2) * scale;
    const hh = (b.h / 2) * scale;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const q = ([
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as ReadonlyArray<readonly [number, number]>).map(
      ([px, py]) => [cx + px * cos - py * sin, cy + px * sin + py * cos] as readonly [number, number],
    );
    fillQuad(put, W, H, q, hexToRgb(palette.building[b.district] ?? '#888888'));
  }

  // The road network as a graph (WORLDGEN.md §40): every street between two
  // junctions stroked along the tiles the flood ran through, every junction a
  // dot. What routing actually searches, over the paint it replaced.
  if (net && map.roadNet) {
    // Coloured by what the street is made of (§41.3): an avenue or the ring
    // reads bright, an ordinary street dim, and carriageway no centreline
    // covers — 12% of the streets — grey. The graph knowing this is most of
    // what §40.5 said an edge was missing.
    const wide: [number, number, number] = [40, 220, 255];
    const narrow: [number, number, number] = [30, 130, 160];
    const unknown: [number, number, number] = [130, 130, 130];
    const node: [number, number, number] = [255, 230, 60];
    const rn = map.roadNet;
    for (let e = 0; e < rn.edgeA.length; e++) {
      const w = rn.edgeWidth[e] as number;
      const street = w >= 4 ? wide : w > 0 ? narrow : unknown;
      for (let k = rn.pathOff[e] as number; k < (rn.pathOff[e + 1] as number); k++) {
      const t = rn.pathTiles[k] as number;
      const mx = t % map.widthTiles;
      const my = (t - mx) / map.widthTiles;
      const cx = (mx - x0) * scale + (scale >> 1);
      const cy = (my - y0) * scale + (scale >> 1);
      const r = scale >> 3;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(cx + dx, cy + dy, street);
      }
    }
    for (let n = 0; n < rn.nodeX.length; n++) {
      const cx = Math.round(((rn.nodeX[n] as number) / 16 - x0) * scale);
      const cy = Math.round(((rn.nodeY[n] as number) / 16 - y0) * scale);
      const r = Math.max(1, scale >> 2);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          put(cx + dx, cy + dy, node);
        }
      }
    }
  }

  // What COLLISION thinks, sampled finer than a tile (WORLDGEN.md §43).
  //
  // The one overlay that cannot be inferred from the picture underneath it.
  // Both renderers have cut their coast against the curve since §25, so the
  // waterline has LOOKED right for a long time while a car still stopped at
  // the tile edge behind it — and a still of the ground cannot show that,
  // because the thing that was wrong was invisible. Marking every sample the
  // movement solver calls solid puts the two shapes in one frame.
  if (solid && isSolidAt) {
    const mark: [number, number, number] = [255, 60, 90];
    const sub = Math.max(2, Math.min(8, scale));
    for (let ty = y0; ty < y0 + hTiles; ty++) {
      for (let tx = x0; tx < x0 + wTiles; tx++) {
        for (let sy = 0; sy < sub; sy++) {
          for (let sx = 0; sx < sub; sx++) {
            const wx = (tx + (sx + 0.5) / sub) * 16;
            const wy = (ty + (sy + 0.5) / sub) * 16;
            if (!isSolidAt(wx, wy)) continue;
            // A stipple, not a wash: the ground has to stay readable under it
            // or the picture only shows the overlay. Every other sample, and
            // each one drawn as the block it stands for rather than as one
            // pixel — at a close-up zoom a single pixel per sample is a faint
            // speckle, and this overlay is only ever looked at close up.
            if (((sx + sy) & 1) === 1) continue;
            const step = Math.max(1, Math.round(scale / sub));
            const px = Math.round((tx - x0) * scale + (sx * scale) / sub);
            const py = Math.round((ty - y0) * scale + (sy * scale) / sub);
            for (let by = 0; by < step; by++) {
              for (let bx = 0; bx < step; bx++) put(px + bx, py + by, mark);
            }
          }
        }
      }
    }
  }

  // The lanes on that graph (WORLDGEN.md §42): each street's own LINE, and
  // the kerb lane a car keeps to going each way along it. The line is where
  // the tile centres were pulled onto the course running down the street; the
  // two lanes are a fraction of the tarmac measured either side of it, which
  // is why they narrow where the street does instead of running through the
  // kerb.
  if (lanes && map.lanes) {
    const L = map.lanes;
    const line: [number, number, number] = [90, 90, 110];
    const withEdge: [number, number, number] = [60, 230, 120];
    const against: [number, number, number] = [255, 140, 60];
    const dot = (wx: number, wy: number, c: [number, number, number]): void => {
      const cx = Math.round((wx / 16 - x0) * scale);
      const cy = Math.round((wy / 16 - y0) * scale);
      const r = Math.max(0, (scale >> 3) - 1);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(cx + dx, cy + dy, c);
    };
    for (let e = 0; e + 1 < L.off.length; e++) {
      const lo = L.off[e] as number;
      const hi = L.off[e + 1] as number;
      for (let k = lo; k + 1 < hi; k++) {
        const ax = L.x[k] as number;
        const ay = L.y[k] as number;
        const vx = (L.x[k + 1] as number) - ax;
        const vy = (L.y[k + 1] as number) - ay;
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len === 0) continue;
        const a = k > lo ? k - 1 : k;
        const b = k + 1 < hi ? k + 1 : k;
        const nx = (L.x[b] as number) - (L.x[a] as number);
        const ny = (L.y[b] as number) - (L.y[a] as number);
        const nl = Math.sqrt(nx * nx + ny * ny) || 1;
        const steps = Math.max(1, Math.ceil(len / 2));
        for (let t = 0; t <= steps; t++) {
          const px = ax + (vx * t) / steps;
          const py = ay + (vy * t) / steps;
          dot(px, py, line);
          for (const dir of [1, -1]) {
            const roomR = (dir > 0 ? L.halfR[k] : L.halfL[k]) as number;
            const roomL = (dir > 0 ? L.halfL[k] : L.halfR[k]) as number;
            const off = laneOffset(L.edgeLanes[e] as number, roomR, roomL, 0);
            dot(
              px - (ny / nl) * dir * off,
              py + (nx / nl) * dir * off,
              dir > 0 ? withEdge : against,
            );
          }
        }
      }
    }
  }

  // The turf wash: who holds this ground, over the top of the ground itself.
  // Half strength, because the point of the picture is to read the city
  // THROUGH the territory — a solid fill tells you where a border is and
  // nothing about what the border runs along.
  if (turfColors && map.turfCellsWide && map.turfCellsWide > 0 && map.turfCells) {
    const cellTiles = map.turfCellTiles ?? 12;
    const cw = map.turfCellsWide;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const tx = x0 + px / scale;
        const ty = y0 + py / scale;
        const gang = map.turfCells[Math.floor(ty / cellTiles) * cw + Math.floor(tx / cellTiles)] ?? 0;
        const hex = turfColors[gang];
        if (!hex) continue;
        const [r, g, b] = hexToRgb(hex);
        const i = (py * W + px) * 4;
        rgba[i] = Math.round(((rgba[i] as number) + r) / 2);
        rgba[i + 1] = Math.round(((rgba[i + 1] as number) + g) / 2);
        rgba[i + 2] = Math.round(((rgba[i + 2] as number) + b) / 2);
      }
    }
    // And where each manor is anchored, as a ring you can find at a glance.
    for (const h of map.turfHomes ?? []) {
      const hex = turfColors[h.gang];
      if (!hex) continue;
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        for (const rad of [3.5, 4]) {
          put(
            Math.round(((h.x / 16 - x0) + Math.cos(th) * rad) * scale),
            Math.round(((h.y / 16 - y0) + Math.sin(th) * rad) * scale),
            [255, 255, 255],
          );
        }
      }
    }
  }

  // Overlay markers: shops (bright), player spawns (white dots).
  for (const s of map.shops ?? []) {
    const c = hexToRgb(
      s.kind === 'gun'
        ? palette.shopGun
        : s.kind === 'spray'
          ? palette.uiAccent
          : palette.shopClothing,
    );
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        put((s.doorX - x0) * scale + dx, (s.doorY - y0) * scale + dy, c);
      }
    }
  }
  for (const p of map.playerSpawns ?? []) {
    put(Math.floor((p.x / 16 - x0) * scale), Math.floor((p.y / 16 - y0) * scale), [255, 255, 255]);
  }
  return { rgba, w: W, h: H };
}


/** The palette file every tool draws with. */
export function loadPalette(): PaletteFile {
  return JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/palette.json')), 'utf8'),
  ) as PaletteFile;
}
