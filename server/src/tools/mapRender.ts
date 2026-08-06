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
