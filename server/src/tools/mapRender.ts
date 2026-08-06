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
  shops?: ReadonlyArray<{ kind: string; doorX: number; doorY: number }>;
  playerSpawns?: ReadonlyArray<{ x: number; y: number }>;
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

/** Render a tile rect of the map at `scale` px per tile, markers included. */
export function render(
  map: RenderableMap,
  palette: PaletteFile,
  x0: number,
  y0: number,
  wTiles: number,
  hTiles: number,
  scale: number,
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

  for (let ty = 0; ty < hTiles; ty++) {
    const my = y0 + ty;
    if (my < 0 || my >= map.heightTiles) continue;
    for (let tx = 0; tx < wTiles; tx++) {
      const mx = x0 + tx;
      if (mx < 0 || mx >= map.widthTiles) continue;
      const tile = map.tiles[my * map.widthTiles + mx] as number;
      let c: [number, number, number];
      if (tile === T_BUILDING) {
        const d = DISTRICT_TYPES[map.district[my * map.widthTiles + mx] as number] as string;
        c = hexToRgb(palette.building[d] ?? '#888888');
      } else {
        c = colors[tile] ?? [255, 0, 255];
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

  // The coast, repainted against the curve.
  //
  // Every pixel within about a tile of a shore polyline is re-decided: which
  // side of the line it falls on says whether it is sea or shore, and the
  // material it takes is the one belonging to that side. The tile pass above
  // has already put down a staircase; this walks over the staircase with the
  // line the tiles were a rasterisation OF.
  //
  // Nearest-segment rather than a proper point-in-polygon test, because the
  // question is only ever asked within a tile of the line, where the two
  // agree everywhere except inside the turn of a very sharp corner — and the
  // disagreement there is a fraction of a pixel at any scale a map is drawn
  // at. The client's painter clips real paths and does not approximate.
  if (map.shores !== undefined && map.shores.length > 0) {
    const REACH = 1.1;
    const best = new Float32Array(W * H).fill(Infinity);
    const side = new Int8Array(W * H);
    const water = colors[T_WATER] as [number, number, number];
    for (const loop of map.shores) {
      const n = loop.points.length;
      for (let k = 0; k < n; k++) {
        const [ax, ay] = loop.points[k] as readonly [number, number];
        const [bx, by] = loop.points[(k + 1) % n] as readonly [number, number];
        // Pixel-space endpoints, relative to the crop.
        const pax = (ax - x0) * scale;
        const pay = (ay - y0) * scale;
        const pbx = (bx - x0) * scale;
        const pby = (by - y0) * scale;
        const pad = REACH * scale + 1;
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
            // Water is on the right of travel, and with y down the right of
            // a direction is the direction turned a quarter turn clockwise:
            // the cross product comes out positive there.
            side[i] = vx * ry - vy * rx > 0 ? 1 : -1;
          }
        }
      }
    }
    /** The material this side of the line is made of, at this pixel. */
    const landAt = (px: number, py: number): [number, number, number] => {
      const mx = x0 + Math.floor(px / scale);
      const my = y0 + Math.floor(py / scale);
      const sample = (sx: number, sy: number): [number, number, number] | null => {
        if (sx < 0 || sy < 0 || sx >= map.widthTiles || sy >= map.heightTiles) return null;
        const t = map.tiles[sy * map.widthTiles + sx] as number;
        if (t === T_WATER || t === T_BRIDGE) return null;
        if (t === T_BUILDING) {
          const d = DISTRICT_TYPES[map.district[sy * map.widthTiles + sx] as number] as string;
          return hexToRgb(palette.building[d] ?? '#888888');
        }
        return colors[t] ?? null;
      };
      // Own tile first, then the NEAREST dry one in the ring — nearest by
      // where the pixel actually is, not by a fixed order. A beach is one
      // tile of sand with grass behind it, so "first dry neighbour I find"
      // puts a green notch in the sand every time the search order happens
      // to look inland before it looks along the shore.
      const own = sample(mx, my);
      if (own !== null) return own;
      let best: [number, number, number] | null = null;
      let bd = Infinity;
      for (const [dx, dy] of [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as const) {
        const near = sample(mx + dx, my + dy);
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
        if (!Number.isFinite(best[i] as number)) continue;
        put(px, py, side[i] === 1 ? water : landAt(px, py));
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
