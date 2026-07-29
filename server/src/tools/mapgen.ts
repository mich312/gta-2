import { readFileSync, writeFileSync } from 'node:fs';
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
  generateCity,
} from 'shared';
import { loadWorldgenParams } from '../tuning.js';
import { encodePng, hexToRgb } from './png.js';

/**
 * pnpm mapgen --seed=N [--out=path.png] — render a generated city to PNG
 * (2px per tile) so generation quality is judged without launching the game.
 */

interface PaletteFile {
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

function main(): void {
  let seed = 1;
  let out = '';
  let wx: number | null = null;
  let wy: number | null = null;
  let size: number | null = null;
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.+)$/.exec(a);
    if (m && m[1] === 'seed') seed = Number.parseInt(m[2] as string, 10);
    if (m && m[1] === 'out') out = m[2] as string;
    if (m && m[1] === 'wx') wx = Number.parseInt(m[2] as string, 10);
    if (m && m[1] === 'wy') wy = Number.parseInt(m[2] as string, 10);
    if (m && m[1] === 'size') size = Number.parseInt(m[2] as string, 10);
  }
  if (!out) out = `mapgen-seed${seed}.png`;

  const params = loadWorldgenParams();
  // The world is unbounded; --wx/--wy open the window somewhere else in it,
  // and --size opens a bigger one (quotas scale with it by design).
  if (wx !== null) params.windowX = wx;
  if (wy !== null) params.windowY = wy;
  if (size !== null) {
    params.widthTiles = size;
    params.heightTiles = size;
  }
  const palette = JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/palette.json')), 'utf8'),
  ) as PaletteFile;

  const t0 = performance.now();
  const map = generateCity(seed, params);
  const genMs = performance.now() - t0;

  const SCALE = 2;
  const W = map.widthTiles * SCALE;
  const H = map.heightTiles * SCALE;
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
    const i = (y * W + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = 255;
  };

  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      const tile = map.tiles[ty * map.widthTiles + tx] as number;
      let c: [number, number, number];
      if (tile === T_BUILDING) {
        const d = DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as string;
        c = hexToRgb(palette.building[d] ?? '#888888');
      } else {
        c = colors[tile] ?? [255, 0, 255];
      }
      for (let py = 0; py < SCALE; py++) {
        for (let px = 0; px < SCALE; px++) {
          put(tx * SCALE + px, ty * SCALE + py, c);
        }
      }
    }
  }

  // Overlay markers: shops (bright), player spawns (white dots).
  for (const s of map.shops) {
    const c = hexToRgb(
      s.kind === 'gun'
        ? palette.shopGun
        : s.kind === 'spray'
          ? palette.uiAccent
          : palette.shopClothing,
    );
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = s.doorX * SCALE + dx;
        const y = s.doorY * SCALE + dy;
        if (x >= 0 && y >= 0 && x < W && y < H) put(x, y, c);
      }
    }
  }
  for (const p of map.playerSpawns) {
    const x = Math.floor((p.x / 16) * SCALE);
    const y = Math.floor((p.y / 16) * SCALE);
    if (x >= 0 && y >= 0 && x < W && y < H) put(x, y, [255, 255, 255]);
  }

  writeFileSync(out, encodePng(W, H, rgba));
  console.log(
    `seed=${seed} gen=${genMs.toFixed(0)}ms blocks=${map.blocks.length} ` +
      `buildings=${map.buildings.length} shops=${map.shops.length} ` +
      `carSpawns=${map.vehicleSpawns.length} playerSpawns=${map.playerSpawns.length} -> ${out}`,
  );
}

main();
