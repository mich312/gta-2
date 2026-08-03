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
  parseCityPlan,
  pointInPoly,
  type CityMap,
  type CityPlan,
} from 'shared';
import { loadWorldgenParams } from '../tuning.js';
import { encodePng, hexToRgb } from './png.js';

/**
 * pnpm mapgen — look at the city without launching the game.
 *
 *   pnpm mapgen [--seed=N] [--out=path.png]   whole map, 2 px per tile
 *   pnpm mapgen --crop=x,y,w[,h]              close-up in tiles, scaled to read
 *   pnpm mapgen --sheet[=path.png]            the fabric-review contact sheet
 *   pnpm mapgen --stats                       per-borough fabric numbers
 *
 * The ground is the same picture whatever the seed: it comes out of the bake
 * (`pnpm citybake`). What the seed moves is the furniture the render marks —
 * shops, spawns — which is exactly the part a session is allowed to vary.
 *
 * The stats and the sheet are the review tools of WORLDGEN.md §13: tuning the
 * street fabric by eyeballing one full-map render is how a citywide single
 * orientation went unnoticed. The sheet retakes the §13.1 evidence crops in
 * one command; the stats table states per borough what the eye would have to
 * measure — how the streets point, how big the blocks are, and how far the
 * shore is from the nearest carriageway.
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

/**
 * The three §13.1 review crops, in tiles. Fixed on purpose: the point of the
 * contact sheet is that the same three places are retaken after every fabric
 * wave and diffed by eye against `evidence/city-fabric-review.png`.
 *
 *   A — both banks of the strait: do the boroughs read as different fabrics?
 *   B — the Old Quarter: do the streets meet the avenues, or get sliced?
 *   C — Sunridge ring and shore: does the city meet its waterfront and park?
 */
const SHEET_CROPS: Array<[number, number, number, number]> = [
  [225, 175, 250, 250],
  [475, 100, 250, 250],
  [210, 470, 250, 250],
];
const SHEET_OUT = 'evidence/city-fabric-review.png';

interface Render {
  rgba: Uint8Array;
  w: number;
  h: number;
}

/** Render a tile rect of the map at `scale` px per tile, markers included. */
function render(
  map: CityMap,
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
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) put(tx * scale + px, ty * scale + py, c);
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
        put((s.doorX - x0) * scale + dx, (s.doorY - y0) * scale + dy, c);
      }
    }
  }
  for (const p of map.playerSpawns) {
    put(Math.floor((p.x / 16 - x0) * scale), Math.floor((p.y / 16 - y0) * scale), [255, 255, 255]);
  }
  return { rgba, w: W, h: H };
}

/** The three review crops side by side on a dark ground. */
function renderSheet(map: CityMap, palette: PaletteFile): Render {
  const SCALE = 2;
  const MARGIN = 4;
  const crops = SHEET_CROPS.map(([x, y, w, h]) => render(map, palette, x, y, w, h, SCALE));
  const w = MARGIN + crops.reduce((acc, c) => acc + c.w + MARGIN, 0);
  const h = 2 * MARGIN + Math.max(...crops.map((c) => c.h));
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 20;
    rgba[i * 4 + 1] = 24;
    rgba[i * 4 + 2] = 32;
    rgba[i * 4 + 3] = 255;
  }
  let atX = MARGIN;
  for (const c of crops) {
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const src = (y * c.w + x) * 4;
        const dst = ((y + MARGIN) * w + x + atX) * 4;
        rgba[dst] = c.rgba[src] as number;
        rgba[dst + 1] = c.rgba[src + 1] as number;
        rgba[dst + 2] = c.rgba[src + 2] as number;
        rgba[dst + 3] = 255;
      }
    }
    atX += c.w + MARGIN;
  }
  return { rgba, w, h };
}

/* ------------------------------------------------------------------ */
/* Per-borough fabric stats.                                           */
/* ------------------------------------------------------------------ */

/**
 * Which borough owns each tile, recomputed from the plan the same way the
 * layout does (`layout.ts` borough pass): point-in-polygon at tile centres,
 * later polygons winning. Recomputed rather than baked because ownership is
 * a review question, not something the game needs at runtime.
 */
function ownerPlane(plan: CityPlan, W: number, H: number): Int16Array {
  const owner = new Int16Array(W * H).fill(-1);
  for (const [di, d] of plan.districts.entries()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of d.area) {
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    for (let ty = Math.max(0, Math.floor(y0)); ty <= Math.min(H - 1, Math.ceil(y1)); ty++) {
      for (let tx = Math.max(0, Math.floor(x0)); tx <= Math.min(W - 1, Math.ceil(x1)); tx++) {
        if (pointInPoly(d.area, tx + 0.5, ty + 0.5)) owner[ty * W + tx] = di;
      }
    }
  }
  return owner;
}

/**
 * How a road tile points: the longest straight run of road through it, over
 * the two axes and the two diagonals. Statistically honest at borough scale
 * even though any one junction tile is ambiguous — a lattice borough should
 * score ~100% axis, and until the §13 fabrics land, every borough will.
 */
function orientationBins(
  tiles: Uint8Array,
  W: number,
  H: number,
  owner: Int16Array,
  boroughs: number,
): { axis: Int32Array; diag: Int32Array } {
  const axis = new Int32Array(boroughs);
  const diag = new Int32Array(boroughs);
  const isRoad = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const t = tiles[y * W + x] as number;
    return t === T_ROAD || t === T_BRIDGE;
  };
  const DIRS: Array<[number, number, boolean]> = [
    [1, 0, true],
    [0, 1, true],
    [1, 1, false],
    [1, -1, false],
  ];
  const CAP = 10;
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (tiles[ty * W + tx] !== T_ROAD) continue;
      const own = owner[ty * W + tx] as number;
      if (own < 0) continue;
      let best = -1;
      let bestAxis = true;
      for (const [dx, dy, isAxis] of DIRS) {
        let run = 1;
        for (let s = 1; s <= CAP && isRoad(tx + dx * s, ty + dy * s); s++) run++;
        for (let s = 1; s <= CAP && isRoad(tx - dx * s, ty - dy * s); s++) run++;
        if (run > best) {
          best = run;
          bestAxis = isAxis;
        }
      }
      if (bestAxis) axis[own] = (axis[own] as number) + 1;
      else diag[own] = (diag[own] as number) + 1;
    }
  }
  return { axis, diag };
}

/**
 * Distance from every land tile to the nearest carriageway, in tiles, by BFS.
 * The shore rows of this field are the §13.5 waterfront invariant-to-be: a
 * city that owns its waterfront has a street within a few tiles of the quay.
 */
function roadDistance(tiles: Uint8Array, W: number, H: number): Int32Array {
  const dist = new Int32Array(W * H).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i] as number;
    if (t === T_ROAD || t === T_BRIDGE) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    const x = i % W;
    const y = (i - x) / W;
    const d = dist[i] as number;
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
      if ((dist[j] as number) >= 0 || tiles[j] === T_WATER) continue;
      dist[j] = d + 1;
      queue.push(j);
    }
  }
  return dist;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] as number;
}

function printStats(map: CityMap, plan: CityPlan): void {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const owner = ownerPlane(plan, W, H);
  const n = plan.districts.length;
  const { axis, diag } = orientationBins(map.tiles, W, H, owner, n);
  const dist = roadDistance(map.tiles, W, H);

  const land = new Int32Array(n);
  const road = new Int32Array(n);
  const built = new Int32Array(n);
  const shore: number[][] = Array.from({ length: n }, () => []);
  let strayShore = 0;
  const wet = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && map.tiles[y * W + x] === T_WATER;
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx;
      const t = map.tiles[i] as number;
      if (t === T_WATER) continue;
      const own = owner[i] as number;
      const onShore = wet(tx + 1, ty) || wet(tx - 1, ty) || wet(tx, ty + 1) || wet(tx, ty - 1);
      if (own < 0) {
        // Shore nobody owns is still shore — the warp pushes beaches past the
        // borough outlines, and dropping them would flatter the numbers.
        if (onShore) strayShore++;
        continue;
      }
      land[own] = (land[own] as number) + 1;
      if (t === T_ROAD || t === T_BRIDGE) road[own] = (road[own] as number) + 1;
      if (t === T_BUILDING) built[own] = (built[own] as number) + 1;
      // Unreachable shore (an island the roads never visit) sorts as very
      // far, not as very near — Gannet Rock is meant to be roadless, and a
      // -1 sentinel at the front of a sorted list would flatter every p50.
      if (onShore) (shore[own] as number[]).push((dist[i] as number) < 0 ? Infinity : (dist[i] as number));
    }
  }

  const blockCount = new Int32Array(n);
  const blockAreas: number[][] = Array.from({ length: n }, () => []);
  for (const b of map.blocks) {
    const cx = Math.min(W - 1, Math.max(0, Math.floor(b.x + b.w / 2)));
    const cy = Math.min(H - 1, Math.max(0, Math.floor(b.y + b.h / 2)));
    const own = owner[cy * W + cx] as number;
    if (own < 0) continue;
    blockCount[own] = (blockCount[own] as number) + 1;
    (blockAreas[own] as number[]).push(b.w * b.h);
  }

  const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
  const num = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
  console.log(
    `\n${pad('borough', 16)}${pad('district', 12)}${num('land', 7)}${num('road%', 7)}` +
      `${num('bldg%', 7)}${num('blocks', 8)}${num('medblk', 8)}${num('axis%', 7)}` +
      `${num('diag%', 7)}${num('shore', 7)}${num('sh-p50', 8)}${num('sh-p95', 8)}`,
  );
  for (const [di, d] of plan.districts.entries()) {
    const l = land[di] as number;
    const o = (axis[di] as number) + (diag[di] as number);
    const areas = (blockAreas[di] as number[]).sort((a, b) => a - b);
    const sh = (shore[di] as number[]).sort((a, b) => a - b);
    const pct = (v: number, of: number): string => (of > 0 ? ((v * 100) / of).toFixed(0) : '-');
    const dst = (v: number): string => (Number.isFinite(v) ? String(v) : 'inf');
    console.log(
      `${pad(d.name, 16)}${pad(d.district, 12)}${num(String(l), 7)}` +
        `${num(pct(road[di] as number, l), 7)}${num(pct(built[di] as number, l), 7)}` +
        `${num(String(blockCount[di] as number), 8)}${num(String(percentile(areas, 50)), 8)}` +
        `${num(pct(axis[di] as number, o), 7)}${num(pct(diag[di] as number, o), 7)}` +
        `${num(String(sh.length), 7)}${num(dst(percentile(sh, 50)), 8)}` +
        `${num(dst(percentile(sh, 95)), 8)}`,
    );
  }
  if (strayShore > 0) console.log(`(${strayShore} shore tiles outside every borough polygon)`);
}

/* ------------------------------------------------------------------ */

function main(): void {
  let seed = 1;
  let out = '';
  let crop: [number, number, number, number] | null = null;
  let sheet: string | null = null;
  let stats = false;
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)(?:=(.+))?$/.exec(a);
    if (!m) continue;
    const key = m[1] as string;
    const val = m[2];
    if (key === 'seed' && val) seed = Number.parseInt(val, 10);
    if (key === 'out' && val) out = val;
    if (key === 'stats') stats = true;
    if (key === 'sheet') sheet = val ?? SHEET_OUT;
    if (key === 'crop' && val) {
      const parts = val.split(',').map((v) => Number.parseInt(v, 10));
      if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) {
        throw new Error(`--crop wants x,y,w[,h] in tiles, got "${val}"`);
      }
      const [x, y, w] = parts as [number, number, number];
      crop = [x, y, w, parts.length > 3 ? (parts[3] as number) : w];
    }
  }

  // The city is the same every time; the seed only moves the furniture.
  const params = loadWorldgenParams();
  const palette = JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/palette.json')), 'utf8'),
  ) as PaletteFile;

  const t0 = performance.now();
  const map = generateCity(seed, params);
  const genMs = performance.now() - t0;

  let picture: Render;
  if (sheet !== null) {
    picture = renderSheet(map, palette);
    if (!out) out = sheet;
  } else if (crop) {
    const [x, y, w, h] = crop;
    // Scaled so a close-up is actually close: a 60-tile crop renders at 8 px
    // per tile, the whole map still at 2.
    const scale = Math.max(2, Math.min(8, Math.floor(1024 / Math.max(w, h))));
    picture = render(map, palette, x, y, w, h, scale);
    if (!out) out = `mapgen-crop-${x}-${y}.png`;
  } else {
    picture = render(map, palette, 0, 0, map.widthTiles, map.heightTiles, 2);
    if (!out) out = `mapgen-seed${seed}.png`;
  }

  writeFileSync(out, encodePng(picture.w, picture.h, picture.rgba));
  console.log(
    `seed=${seed} gen=${genMs.toFixed(0)}ms blocks=${map.blocks.length} ` +
      `buildings=${map.buildings.length} shops=${map.shops.length} ` +
      `carSpawns=${map.vehicleSpawns.length} playerSpawns=${map.playerSpawns.length} -> ${out}`,
  );

  if (stats) {
    const plan = parseCityPlan(
      JSON.parse(readFileSync(new URL(import.meta.resolve('shared/data/city-plan.json')), 'utf8')),
    );
    printStats(map, plan);
  }
}

main();
