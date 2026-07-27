import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, hexToRgb } from './png.js';

/**
 * Sprite-sheet generator: emits client/public/sprites.png (+ a frame map JSON)
 * from `shared/data/sprites.json` and the shared palette.
 *
 * Sprites are described as stacked shapes carrying a *height* (`z`). Height is
 * what makes flat top-down art read as solid: after rasterising, the generator
 * relights every pixel from the height field — warm highlights on facets facing
 * the light, cool shade on facets turned away, ambient occlusion in the
 * creases — then traces a contour around the silhouette. That is the whole
 * trick behind the look; the JSON only ever describes flat shapes.
 *
 * Art is authored at `meta.scale` art-pixels per world-pixel, so a 12 world-px
 * character is a 24 px sprite. Sprites face +x (right); the client bakes
 * rotation frames and drop shadows at load.
 *
 * A new sprite is still just a JSON edit.
 */

type RGB = [number, number, number];

interface Shape {
  rect?: [number, number, number, number];
  disc?: [number, number, number];
  ellipse?: [number, number, number, number];
  /** Closed polygon, [[x,y], ...]. */
  poly?: Array<[number, number]>;
  /** [x0, y0, x1, y1, thickness]. */
  line?: [number, number, number, number, number];
  color: string;
  /** Surface height; drives shading, AO and occlusion. Default 4. */
  z?: number;
  /** Also draw this shape mirrored about the horizontal centreline. */
  mirrorY?: boolean;
  /** Checkerboard-blend towards a second colour for cheap material texture. */
  dither?: string;
  /** Per-pixel brightness jitter, 0..1. Deterministic per sprite. */
  noise?: number;
  /** Keep the silhouette contour off these pixels (glass, glows). */
  noOutline?: boolean;
  /** Blend over what is underneath instead of replacing it, 0..1. */
  alpha?: number;
}

interface SpriteDef {
  w: number;
  h: number;
  /** Rotation pivot in art px; defaults to the sprite centre. */
  pivot?: [number, number];
  shapes: Shape[];
  /** Emit N animation frames; shapes animate via their `anim` offsets. */
  frames?: number;
  /** Palette-key substitution: shapes referencing `$key` emit one sprite each. */
  variants?: Record<string, string[]>;
  /** Shape index -> per-frame [dx, dy] offsets. */
  anim?: Record<string, Array<[number, number]>>;
  /**
   * How many rotation steps the client should bake for this sprite. 0 means the
   * sprite never rotates (decals, effects). Long silhouettes want more steps
   * than round ones.
   */
  rotations?: number;
}

interface Meta {
  /** Art pixels per world pixel. */
  scale: number;
  /** Contour colour (palette key). */
  outline: string;
  /** How strongly the contour tints towards `outline`, 0..1. */
  outlineMix: number;
  /** Light direction in art space, pointing from the surface towards the light. */
  lightX: number;
  lightY: number;
  /** Highlight / shade / AO strengths, 0..1. */
  highlight: number;
  shade: number;
  ao: number;
  /** Warm highlight and cool shade tints (palette keys or hex). */
  warm: string;
  cool: string;
}

interface SpriteFile {
  meta: Meta;
  sprites: Record<string, SpriteDef>;
}

// ── colour helpers ───────────────────────────────────────────────────────────

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/** Deterministic per-sprite noise so regenerating the sheet is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── the per-sprite raster ────────────────────────────────────────────────────

/**
 * A sprite under construction: colour + coverage + a height field. Shapes write
 * all three; the lighting pass reads the height field back.
 */
class Raster {
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;
  readonly z: Float32Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    const n = w * h;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n);
    this.z = new Float32Array(n);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  put(x: number, y: number, c: RGB, z: number, alpha: number): void {
    if (!this.inside(x, y)) return;
    const i = this.idx(x, y);
    if (alpha >= 1) {
      this.r[i] = c[0];
      this.g[i] = c[1];
      this.b[i] = c[2];
      this.a[i] = 1;
      this.z[i] = z;
      return;
    }
    // Blend over whatever is underneath; height follows the dominant layer.
    const under = this.a[i] as number;
    this.r[i] = (this.r[i] as number) * (1 - alpha) + c[0] * alpha;
    this.g[i] = (this.g[i] as number) * (1 - alpha) + c[1] * alpha;
    this.b[i] = (this.b[i] as number) * (1 - alpha) + c[2] * alpha;
    this.a[i] = Math.max(under, alpha);
    if (alpha >= 0.5) this.z[i] = z;
  }
}

// ── rasterising shapes ───────────────────────────────────────────────────────

function fillShape(
  raster: Raster,
  shape: Shape,
  color: RGB,
  ditherColor: RGB | null,
  rand: () => number,
  dx: number,
  dy: number,
  mirror: boolean,
): void {
  const z = shape.z ?? 4;
  const alpha = shape.alpha ?? 1;
  const noise = shape.noise ?? 0;

  const put = (px: number, py: number): void => {
    const x = px + dx;
    let y = py + dy;
    if (mirror) y = raster.h - 1 - y;
    if (!raster.inside(x, y)) return;
    let c = ditherColor && (x + y) % 2 === 0 ? ditherColor : color;
    if (noise > 0) {
      const n = (rand() - 0.5) * 2 * noise * 255;
      c = [clamp255(c[0] + n), clamp255(c[1] + n), clamp255(c[2] + n)];
    }
    raster.put(x, y, c, z, alpha);
  };

  if (shape.rect) {
    const [x, y, w, h] = shape.rect;
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(px, py);
  } else if (shape.disc) {
    const [cx, cy, r] = shape.disc;
    for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
      for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
        const ox = px - cx;
        const oy = py - cy;
        if (ox * ox + oy * oy <= r * r) put(px, py);
      }
    }
  } else if (shape.ellipse) {
    const [cx, cy, rx, ry] = shape.ellipse;
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        const ox = (px - cx) / rx;
        const oy = (py - cy) / ry;
        if (ox * ox + oy * oy <= 1) put(px, py);
      }
    }
  } else if (shape.poly) {
    const pts = shape.poly;
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const [px, py] of pts) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
    }
    for (let py = Math.floor(minY); py <= Math.ceil(maxY); py++) {
      for (let px = Math.floor(minX); px <= Math.ceil(maxX); px++) {
        if (pointInPoly(px + 0.5, py + 0.5, pts)) put(px, py);
      }
    }
  } else if (shape.line) {
    const [x0, y0, x1, y1, thick] = shape.line;
    const half = thick / 2;
    for (let py = Math.floor(Math.min(y0, y1) - half); py <= Math.ceil(Math.max(y0, y1) + half); py++) {
      for (let px = Math.floor(Math.min(x0, x1) - half); px <= Math.ceil(Math.max(x0, x1) + half); px++) {
        if (distToSegment(px + 0.5, py + 0.5, x0, y0, x1, y1) <= half) put(px, py);
      }
    }
  }
}

function pointInPoly(x: number, y: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] as [number, number];
    const [xj, yj] = pts[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / len2));
  return Math.hypot(px - (x0 + vx * t), py - (y0 + vy * t));
}

// ── lighting + contour ───────────────────────────────────────────────────────

/**
 * Relight the raster from its height field. Facets whose neighbour towards the
 * light is lower catch a warm highlight; facets standing below a taller
 * neighbour fall into cool shade, with a softer ambient-occlusion term for
 * anything merely adjacent to something taller.
 */
function relight(raster: Raster, meta: Meta, warm: RGB, cool: RGB): void {
  const { w, h } = raster;
  const lx = Math.abs(meta.lightX) > 0.4 ? Math.sign(meta.lightX) : 0;
  const ly = Math.abs(meta.lightY) > 0.4 ? Math.sign(meta.lightY) : 0;

  const zAt = (x: number, y: number): number => {
    if (!raster.inside(x, y)) return -1;
    const i = raster.idx(x, y);
    return (raster.a[i] as number) > 0 ? (raster.z[i] as number) : -1;
  };

  let maxZ = 0;
  for (let i = 0; i < raster.z.length; i++) {
    if ((raster.a[i] as number) > 0 && (raster.z[i] as number) > maxZ) maxZ = raster.z[i] as number;
  }

  const outR = new Float32Array(raster.r);
  const outG = new Float32Array(raster.g);
  const outB = new Float32Array(raster.b);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = raster.idx(x, y);
      if ((raster.a[i] as number) <= 0) continue;
      const z = raster.z[i] as number;
      let c: RGB = [raster.r[i] as number, raster.g[i] as number, raster.b[i] as number];

      // Rim towards the light: this facet's edge catches the key light.
      if (zAt(x + lx, y + ly) < z) c = mix(c, warm, meta.highlight);
      // Standing in the shadow of a taller neighbour.
      if (zAt(x - lx, y - ly) > z) c = mix(c, cool, meta.shade);

      // Ambient occlusion: anything tucked beside something taller.
      let occluders = 0;
      if (zAt(x + 1, y) > z + 1) occluders++;
      if (zAt(x - 1, y) > z + 1) occluders++;
      if (zAt(x, y + 1) > z + 1) occluders++;
      if (zAt(x, y - 1) > z + 1) occluders++;
      if (occluders > 0) c = mix(c, cool, meta.ao * Math.min(1, occluders / 2));

      // Global height falloff: low surfaces sit deeper in ambient shade.
      if (maxZ > 0) c = mix(c, cool, 0.14 * (1 - z / maxZ));

      outR[i] = c[0];
      outG[i] = c[1];
      outB[i] = c[2];
    }
  }
  raster.r.set(outR);
  raster.g.set(outG);
  raster.b.set(outB);
}

/**
 * Trace a contour just outside the silhouette. The contour is tinted from the
 * pixel it hugs rather than laid down as flat black, which keeps small sprites
 * from reading as stickers.
 */
function outline(raster: Raster, color: RGB, amount: number, skip: Uint8Array): void {
  const { w, h } = raster;
  const adds: Array<[number, RGB]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = raster.idx(x, y);
      if ((raster.a[i] as number) > 0) continue;
      let best = -1;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (!raster.inside(nx, ny)) continue;
          const ni = raster.idx(nx, ny);
          if ((raster.a[ni] as number) <= 0 || skip[ni] === 1) continue;
          if (best < 0 || (raster.z[ni] as number) > (raster.z[best] as number)) best = ni;
        }
      }
      if (best < 0) continue;
      const src: RGB = [raster.r[best] as number, raster.g[best] as number, raster.b[best] as number];
      adds.push([i, mix(src, color, amount)]);
    }
  }
  for (const [i, c] of adds) {
    raster.r[i] = c[0];
    raster.g[i] = c[1];
    raster.b[i] = c[2];
    raster.a[i] = 1;
    raster.z[i] = 0;
  }
}

// ── build one sprite ─────────────────────────────────────────────────────────

function buildSprite(
  seedName: string,
  def: SpriteDef,
  meta: Meta,
  resolve: (key: string) => RGB,
  subst: Record<string, string>,
  frame: number,
): Raster {
  const raster = new Raster(def.w, def.h);
  const rand = mulberry32(hashName(seedName));
  const skip = new Uint8Array(def.w * def.h);
  const key = (c: string): string => (c.startsWith('$') ? (subst[c.slice(1)] ?? c) : c);

  def.shapes.forEach((shape, si) => {
    const color = resolve(key(shape.color));
    const ditherColor = shape.dither ? resolve(key(shape.dither)) : null;
    const off = def.anim?.[String(si)]?.[frame] ?? [0, 0];

    fillShape(raster, shape, color, ditherColor, rand, off[0], off[1], false);
    if (shape.mirrorY) fillShape(raster, shape, color, ditherColor, rand, off[0], -off[1], true);

    if (shape.noOutline) {
      // Remember these pixels so the contour pass ignores them.
      const probe = new Raster(def.w, def.h);
      fillShape(probe, shape, color, null, mulberry32(1), off[0], off[1], false);
      if (shape.mirrorY) fillShape(probe, shape, color, null, mulberry32(1), off[0], -off[1], true);
      for (let i = 0; i < skip.length; i++) if ((probe.a[i] as number) > 0) skip[i] = 1;
    }
  });

  relight(raster, meta, resolve(meta.warm), resolve(meta.cool));
  outline(raster, resolve(meta.outline), meta.outlineMix, skip);
  return raster;
}

/** Cartesian product of the variant axes, e.g. {body:[a,b]} -> [{body:a},{body:b}]. */
function variantCombos(variants: Record<string, string[]> | undefined): Record<string, string>[] {
  if (!variants) return [{}];
  let combos: Record<string, string>[] = [{}];
  for (const [name, values] of Object.entries(variants)) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) for (const v of values) next.push({ ...combo, [name]: v });
    combos = next;
  }
  return combos;
}

// ── packing + output ─────────────────────────────────────────────────────────

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation pivot, relative to the frame's top-left. */
  px: number;
  py: number;
  /** Rotation steps the client bakes; 0 = never rotated. */
  rot: number;
}

const SHEET_MAX_WIDTH = 1024;
const PAD = 1;

/**
 * `--preview` contact sheet: every frame blown up on a mid-grey checkerboard so
 * silhouettes, contours and the height shading can actually be judged by eye.
 * Not shipped to the client.
 */
function writePreview(
  built: Array<{ name: string; raster: Raster }>,
  frames: Record<string, Frame>,
  outDir: string,
  zoom: number,
): void {
  const cell = Math.max(...built.map((b) => Math.max(b.raster.w, b.raster.h))) + 2;
  const cols = Math.max(1, Math.floor(1600 / (cell * zoom)));
  const rows = Math.ceil(built.length / cols);
  const w = cols * cell * zoom;
  const h = rows * cell * zoom;
  const rgba = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const v = dark ? 60 : 82;
      const i = (y * w + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v + 4;
      rgba[i + 2] = v + 8;
      rgba[i + 3] = 255;
    }
  }

  const sorted = [...built].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((item, n) => {
    const col = n % cols;
    const row = Math.floor(n / cols);
    const ox = (col * cell + Math.floor((cell - item.raster.w) / 2)) * zoom;
    const oy = (row * cell + Math.floor((cell - item.raster.h) / 2)) * zoom;
    for (let y = 0; y < item.raster.h * zoom; y++) {
      for (let x = 0; x < item.raster.w * zoom; x++) {
        const si = item.raster.idx(Math.floor(x / zoom), Math.floor(y / zoom));
        const a = item.raster.a[si] as number;
        if (a <= 0) continue;
        const di = ((oy + y) * w + ox + x) * 4;
        if (di < 0 || di + 3 >= rgba.length) continue;
        rgba[di] = clamp255(item.raster.r[si] as number);
        rgba[di + 1] = clamp255(item.raster.g[si] as number);
        rgba[di + 2] = clamp255(item.raster.b[si] as number);
        rgba[di + 3] = 255;
      }
    }
    // Pivot crosshair, so rotation centres can be eyeballed too.
    const f = frames[item.name] as Frame;
    const cx = ox + Math.floor(f.px * zoom);
    const cy = oy + Math.floor(f.py * zoom);
    for (let d = -zoom; d <= zoom; d++) {
      for (const [px, py] of [
        [cx + d, cy],
        [cx, cy + d],
      ] as Array<[number, number]>) {
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const di = (py * w + px) * 4;
        rgba[di] = 255;
        rgba[di + 1] = 0;
        rgba[di + 2] = 255;
      }
    }
  });

  writeFileSync(join(outDir, 'sprites.preview.png'), encodePng(w, h, rgba));
  console.log(`preview: ${built.length} frames -> ${join(outDir, 'sprites.preview.png')} (${w}x${h})`);
}

function main(): void {
  const palette = JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/palette.json')), 'utf8'),
  ) as Record<string, unknown>;
  const file = JSON.parse(
    readFileSync(new URL(import.meta.resolve('shared/data/sprites.json')), 'utf8'),
  ) as SpriteFile;
  const meta = file.meta;

  const resolve = (c: string): RGB => {
    if (c.startsWith('#')) return hexToRgb(c) as RGB;
    const v = palette[c];
    if (typeof v !== 'string') throw new Error(`sprite color '${c}' not in palette`);
    return hexToRgb(v) as RGB;
  };

  // Expand every sprite × variant × frame into a concrete raster.
  const built: Array<{ name: string; raster: Raster; def: SpriteDef }> = [];
  for (const [name, def] of Object.entries(file.sprites)) {
    const combos = variantCombos(def.variants);
    const frameCount = def.frames ?? 1;
    combos.forEach((subst, vi) => {
      for (let f = 0; f < frameCount; f++) {
        let full = name;
        if (combos.length > 1) full += `_v${vi}`;
        if (frameCount > 1) full += `_f${f}`;
        built.push({ name: full, raster: buildSprite(full, def, meta, resolve, subst, f), def });
      }
    });
  }

  // Shelf-pack tallest-first so the sheet stays compact.
  const order = [...built].sort((a, b) => b.raster.h - a.raster.h || a.name.localeCompare(b.name));
  const frames: Record<string, Frame> = {};
  let cursorX = PAD;
  let cursorY = PAD;
  let rowH = 0;
  let sheetW = 0;
  for (const item of order) {
    if (cursorX + item.raster.w + PAD > SHEET_MAX_WIDTH && cursorX > PAD) {
      cursorX = PAD;
      cursorY += rowH + PAD;
      rowH = 0;
    }
    const pivot = item.def.pivot ?? [item.raster.w / 2, item.raster.h / 2];
    frames[item.name] = {
      x: cursorX,
      y: cursorY,
      w: item.raster.w,
      h: item.raster.h,
      px: pivot[0],
      py: pivot[1],
      rot: item.def.rotations ?? 32,
    };
    cursorX += item.raster.w + PAD;
    rowH = Math.max(rowH, item.raster.h);
    sheetW = Math.max(sheetW, cursorX);
  }
  const sheetH = cursorY + rowH + PAD;

  const rgba = new Uint8Array(sheetW * sheetH * 4);
  for (const item of built) {
    const f = frames[item.name] as Frame;
    const { raster } = item;
    for (let y = 0; y < raster.h; y++) {
      for (let x = 0; x < raster.w; x++) {
        const si = raster.idx(x, y);
        const alpha = raster.a[si] as number;
        if (alpha <= 0) continue;
        const di = ((f.y + y) * sheetW + f.x + x) * 4;
        rgba[di] = clamp255(raster.r[si] as number);
        rgba[di + 1] = clamp255(raster.g[si] as number);
        rgba[di + 2] = clamp255(raster.b[si] as number);
        rgba[di + 3] = clamp255(alpha * 255);
      }
    }
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../client/public');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'sprites.png'), encodePng(sheetW, sheetH, rgba));
  writeFileSync(
    join(outDir, 'sprites.meta.json'),
    JSON.stringify({ scale: meta.scale, frames }, null, 2),
  );
  console.log(
    `sprites: ${built.length} frames from ${Object.keys(file.sprites).length} definitions ` +
      `-> client/public/sprites.png (${sheetW}x${sheetH})`,
  );

  const previewArg = process.argv.find((a) => a.startsWith('--preview'));
  if (previewArg) {
    const zoom = Number.parseInt(previewArg.split('=')[1] ?? '6', 10) || 6;
    const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
    const only = onlyArg ? onlyArg.split(',') : null;
    const subset = only ? built.filter((b) => only.some((p) => b.name.startsWith(p))) : built;
    writePreview(subset, frames, join(dirname(fileURLToPath(import.meta.url)), '../../..'), zoom);
  }
}

main();
