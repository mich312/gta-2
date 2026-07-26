import type { PlayerState } from 'shared';
import {
  ATLAS_ROTATION_STEPS,
  CAR_COLORS,
  COSMETIC_OUTFITS,
  PED_HATS,
  PED_OUTFITS,
  REMOTE_SHIRTS,
} from './style.js';
import { hashPick, shade } from './visualRng.js';

/**
 * Procedural sprite atlas with pre-baked rotations.
 *
 * Sprites are painted once (pixel art, facing +x), then every rotation step
 * is rasterised into a grid canvas up front. At draw time a rotation is a
 * single un-transformed drawImage of a cell — no per-frame ctx.rotate, no
 * shimmer between frames that share an angle bucket, and identical pixels
 * for every entity at the same angle.
 *
 * Variants are lazy: sprites are keyed by a tiny grammar that encodes their
 * palette (`hum:<shirt>,<pants>,<skin>,<hair>,<hat>,<armed>`;
 * `car:<style>,<hex>`; `boat:<hex>`; `prop:<kind>`; `blob:<w>x<h>`), and a
 * painter is invoked on first use. A new outfit or car colour is a new key,
 * not new code.
 */

interface Baked {
  canvas: HTMLCanvasElement;
  cell: number;
  steps: number;
  frames: number;
}

type Painter = (ctx: CanvasRenderingContext2D, cx: number, cy: number, frame: number) => void;

interface SpriteSpec {
  w: number;
  h: number;
  frames: number;
  steps: number;
  paint: Painter;
}

const SKIN_TONES = ['#d8a577', '#c68d5c', '#a06a42', '#7c4f2f', '#e7bd91'] as const;
const HAIR = ['#2b2118', '#4a3524', '#141414', '#5b4423', '#7a6a4f', '#3a2a1c'] as const;
const OUTLINE = '#0e1013';

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

export class SpriteAtlas {
  private readonly baked = new Map<string, Baked>();

  /**
   * Draw `key` centred at (x, y) rotated to `angle`. Frames select walk
   * cycle / animation variants. Coordinates are snapped to whole pixels.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    key: string,
    x: number,
    y: number,
    angle: number,
    frame = 0,
  ): void {
    const b = this.get(key);
    const tau = Math.PI * 2;
    const a = ((angle % tau) + tau) % tau;
    const step = Math.round((a / tau) * b.steps) % b.steps;
    const f = Math.min(b.frames - 1, Math.max(0, frame | 0));
    ctx.drawImage(
      b.canvas,
      step * b.cell,
      f * b.cell,
      b.cell,
      b.cell,
      Math.floor(x) - (b.cell >> 1),
      Math.floor(y) - (b.cell >> 1),
      b.cell,
      b.cell,
    );
  }

  private get(key: string): Baked {
    const hit = this.baked.get(key);
    if (hit) return hit;
    const spec = resolveSpec(key);
    const baked = bake(spec);
    this.baked.set(key, baked);
    return baked;
  }
}

/** Rasterise every (rotation, frame) cell for a sprite spec. */
function bake(spec: SpriteSpec): Baked {
  const cell = Math.ceil(Math.hypot(spec.w, spec.h)) + 2;
  const canvas = document.createElement('canvas');
  canvas.width = cell * spec.steps;
  canvas.height = cell * spec.frames;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for atlas bake');
  ctx.imageSmoothingEnabled = false;

  // Paint the base art once per frame, then stamp rotated copies.
  const base = document.createElement('canvas');
  base.width = spec.w;
  base.height = spec.h;
  const bctx = base.getContext('2d');
  if (!bctx) throw new Error('no 2d context for atlas base');
  bctx.imageSmoothingEnabled = false;

  for (let f = 0; f < spec.frames; f++) {
    bctx.clearRect(0, 0, spec.w, spec.h);
    spec.paint(bctx, spec.w / 2, spec.h / 2, f);
    for (let s = 0; s < spec.steps; s++) {
      ctx.save();
      ctx.translate(s * cell + cell / 2, f * cell + cell / 2);
      ctx.rotate((s / spec.steps) * Math.PI * 2);
      ctx.drawImage(base, -spec.w / 2, -spec.h / 2);
      ctx.restore();
    }
  }
  return { canvas, cell, steps: spec.steps, frames: spec.frames };
}

function resolveSpec(key: string): SpriteSpec {
  const sep = key.indexOf(':');
  const kind = sep === -1 ? key : key.slice(0, sep);
  const arg = sep === -1 ? '' : key.slice(sep + 1);
  switch (kind) {
    case 'hum':
      return humanoidSpec(arg);
    case 'car':
      return carSpec(arg);
    case 'boat':
      return boatSpec(arg);
    case 'prop':
      return propSpec(arg);
    case 'blob':
      return blobSpec(arg);
    default:
      throw new Error(`unknown sprite key: ${key}`);
  }
}

// ---------------------------------------------------------------- humanoids

function humanoidSpec(arg: string): SpriteSpec {
  const [shirt = '#888888', pants = '#444444', skin = '#d8a577', hair = '#2b2118', hat = '', armedStr = '0'] =
    arg.split(',');
  const armed = armedStr === '1';
  return {
    w: 16,
    h: 16,
    frames: 4,
    steps: ATLAS_ROTATION_STEPS,
    paint: (ctx, _cx, _cy, frame) => paintHumanoid(ctx, { shirt, pants, skin, hair, hat, armed }, frame),
  };
}

interface HumanoidLook {
  shirt: string;
  pants: string;
  skin: string;
  hair: string;
  /** Cap colour ('' = bare head). */
  hat: string;
  armed: boolean;
}

/** Pixel-perfect filled ellipse via scanlines (no anti-aliased path edges). */
function pixelEllipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
): void {
  ctx.fillStyle = color;
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
    const f = 1 - (dy * dy) / (ry * ry);
    if (f < 0) continue;
    const hw = Math.round(rx * Math.sqrt(f));
    if (hw <= 0) continue;
    ctx.fillRect(cx - hw, cy + dy, hw * 2, 1);
  }
}

/**
 * Top-down person, facing +x. 16×16, centre (8,8). Shoulders read as a wide
 * ellipse perpendicular to facing; the head (mostly hair from above) sits a
 * touch forward so the silhouette points where the player aims. Walk cycle
 * is a 4-beat arm/foot swing: 0 idle, 1 left forward, 2 idle, 3 right.
 */
function paintHumanoid(ctx: CanvasRenderingContext2D, look: HumanoidLook, frame: number): void {
  const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const shoe = shade(look.pants, -0.3);

  // Feet peek out fore/aft of the torso mid-stride.
  if (swing !== 0) {
    px(ctx, 7 + swing * 2, 4, 2, 2, shoe);
    px(ctx, 7 - swing * 2, 10, 2, 2, shoe);
  }

  // Torso: dark rim, shirt body, lit ridge along the spine.
  pixelEllipse(ctx, 7, 8, 4.2, 5.4, OUTLINE);
  pixelEllipse(ctx, 7, 8, 3.4, 4.6, look.shirt);
  pixelEllipse(ctx, 6, 8, 1.4, 3.2, shade(look.shirt, 0.16));

  // Arms + hands.
  const sleeve = shade(look.shirt, -0.18);
  if (look.armed) {
    // Two-handed grip forward; barrel clears the silhouette.
    px(ctx, 9, 8, 3, 2, sleeve);
    px(ctx, 11, 8, 2, 2, look.skin);
    px(ctx, 12, 8, 4, 1, '#16181c');
    px(ctx, 12, 9, 2, 1, '#3a3e46');
  } else {
    px(ctx, 8 + swing, 3, 2, 2, sleeve);
    px(ctx, 9 + swing, 3, 1, 2, look.skin);
    px(ctx, 8 - swing, 11, 2, 2, sleeve);
    px(ctx, 9 - swing, 11, 1, 2, look.skin);
  }

  // Head: hair disc nudged forward, face sliver at the brow.
  const cap = look.hat !== '';
  const cover = cap ? look.hat : look.hair;
  pixelEllipse(ctx, 9, 8, 2.4, 2.4, shade(cover, -0.3));
  pixelEllipse(ctx, 9, 8, 1.8, 1.8, cover);
  px(ctx, 11, 7, 1, 2, look.skin);
  if (cap) {
    px(ctx, 12, 7, 1, 2, shade(look.hat, 0.3)); // brim
    if (look.hat === '#233d73') px(ctx, 8, 7, 1, 1, '#d8b64a'); // cop badge glint
  } else {
    px(ctx, 8, 7, 2, 1, shade(look.hair, 0.28)); // sheen
  }
}

/** Stable humanoid key for a player entity. */
export function playerSpriteKey(p: PlayerState, isLocal: boolean): string {
  const cosmetic = COSMETIC_OUTFITS[p.cosmeticId];
  const shirt = cosmetic ? cosmetic.shirt : isLocal ? '#e8e8ee' : remoteShirt(p.id);
  const pants = cosmetic ? cosmetic.pants : isLocal ? '#3a4048' : '#31465f';
  const skin = SKIN_TONES[hashPick(11, p.id, 0, SKIN_TONES.length)] as string;
  const hair = HAIR[hashPick(13, p.id, 1, HAIR.length)] as string;
  const armed = p.activeWeapon >= 0 && p.weapons.length > 0 ? '1' : '0';
  return `hum:${shirt},${pants},${skin},${hair},,${armed}`;
}

export function copSpriteKey(): string {
  return 'hum:#2b4a8a,#1c2f57,#d8a577,#141414,#233d73,1';
}

export function pedSpriteKey(id: number): string {
  const outfit = PED_OUTFITS[hashPick(17, id, 2, PED_OUTFITS.length)] as (typeof PED_OUTFITS)[number];
  const skin = SKIN_TONES[hashPick(11, id, 3, SKIN_TONES.length)] as string;
  const hair = HAIR[hashPick(13, id, 4, HAIR.length)] as string;
  // Roughly one in five wears a hat — crowds read as individuals, not clones.
  const hat = hashPick(19, id, 6, 5) === 0 ? (PED_HATS[hashPick(29, id, 7, PED_HATS.length)] as string) : '';
  return `hum:${outfit.shirt},${outfit.pants},${skin},${hair},${hat},0`;
}

function remoteShirt(id: number): string {
  return REMOTE_SHIRTS[id % REMOTE_SHIRTS.length] as string;
}

// --------------------------------------------------------------------- cars

export type CarStyle = 'sedan' | 'wagon' | 'van' | 'taxi';

/** Sprite key for any vehicle entity: boats by kind, cars by hashed style. */
export function vehicleSpriteKey(v: { id: number; kind: string }): string {
  if (v.kind === 'boat') {
    return `boat:${BOAT_COLORS[hashPick(41, v.id, 10, BOAT_COLORS.length)] as string}`;
  }
  // Body style per id: mostly sedans, a few wagons and vans, the odd taxi.
  const roll = hashPick(31, v.id, 8, 10);
  const style: CarStyle = roll < 5 ? 'sedan' : roll < 7 ? 'wagon' : roll < 9 ? 'van' : 'taxi';
  const body =
    style === 'taxi' ? '#e0b91f' : (CAR_COLORS[hashPick(23, v.id, 5, CAR_COLORS.length)] as string);
  return `car:${style},${body}`;
}

const BOAT_COLORS = ['#d8d4c8', '#7a3434', '#33586e', '#3d6b4f', '#c2ab66'] as const;

function carSpec(arg: string): SpriteSpec {
  const [styleRaw = 'sedan', color = '#b03a3a'] = arg.split(',');
  const style = styleRaw as CarStyle;
  return {
    w: 28,
    h: 16,
    frames: 1,
    steps: ATLAS_ROTATION_STEPS,
    paint: (ctx) => paintCar(ctx, style, color),
  };
}

/** Car facing +x, 28×16 canvas, body 24×12 centred; style varies the shell. */
function paintCar(ctx: CanvasRenderingContext2D, style: CarStyle, body: string): void {
  const dark = shade(body, -0.28);
  const lite = shade(body, 0.16);

  // Wheels poke out beyond the body silhouette.
  px(ctx, 6, 1, 4, 2, '#17181c');
  px(ctx, 6, 13, 4, 2, '#17181c');
  px(ctx, 19, 1, 4, 2, '#17181c');
  px(ctx, 19, 13, 4, 2, '#17181c');

  // Outline + body (corners nicked for a rounded shell).
  px(ctx, 2, 2, 24, 12, OUTLINE);
  px(ctx, 3, 3, 22, 10, body);
  px(ctx, 3, 3, 1, 1, OUTLINE);
  px(ctx, 3, 12, 1, 1, OUTLINE);
  px(ctx, 24, 3, 1, 1, OUTLINE);
  px(ctx, 24, 12, 1, 1, OUTLINE);

  // Panel shading: lit ridge along the sprite's "up" edge, shaded sill low.
  px(ctx, 4, 3, 20, 1, lite);
  px(ctx, 4, 12, 20, 1, dark);

  if (style === 'van') {
    // One long box: tall cargo body, cab window right up front.
    px(ctx, 5, 4, 15, 8, OUTLINE);
    px(ctx, 6, 5, 13, 6, shade(body, -0.10));
    px(ctx, 6, 5, 13, 1, shade(body, 0.08)); // roof ridge
    px(ctx, 20, 4, 1, 8, dark); // cab bulkhead seam
    px(ctx, 21, 5, 2, 6, '#a7d4e8'); // windshield
    px(ctx, 5, 5, 1, 6, dark); // rear doors seam
  } else {
    // Bonnet/boot seams.
    px(ctx, 21, 4, 1, 8, dark);
    px(ctx, 8, 4, 1, 8, dark);

    // Cabin: roof slab + glass. Wagons stretch the roof to the tail.
    const cabX = style === 'wagon' ? 6 : 10;
    const cabW = style === 'wagon' ? 13 : 9;
    px(ctx, cabX, 4, cabW, 8, OUTLINE);
    px(ctx, cabX + 1, 5, cabW - 2, 6, shade(body, -0.12));
    px(ctx, cabX + cabW - 2, 5, 2, 6, '#a7d4e8'); // windshield
    px(ctx, cabX + 1, 5, 1, 6, '#7fa8bf'); // rear glass
    px(ctx, cabX + 2, 5, cabW - 4, 1, '#8fb8cd'); // side glass
    px(ctx, cabX + 2, 10, cabW - 4, 1, '#6f96ab');
    if (style === 'taxi') {
      px(ctx, 13, 6, 3, 4, '#1a1a20'); // roof sign
      px(ctx, 14, 7, 1, 2, '#f2e3a0');
      px(ctx, 4, 3, 2, 1, '#17181c'); // checker hints along the sill
      px(ctx, 7, 3, 2, 1, '#17181c');
      px(ctx, 4, 12, 2, 1, '#17181c');
      px(ctx, 7, 12, 2, 1, '#17181c');
    }
  }

  // Lights: headlights forward, taillights rear.
  px(ctx, 25, 4, 1, 2, '#f2e3a0');
  px(ctx, 25, 10, 1, 2, '#f2e3a0');
  px(ctx, 2, 4, 1, 2, '#c23434');
  px(ctx, 2, 10, 1, 2, '#c23434');
}

// -------------------------------------------------------------------- boats

function boatSpec(arg: string): SpriteSpec {
  const hull = arg || '#d8d4c8';
  return {
    w: 32,
    h: 14,
    frames: 1,
    steps: ATLAS_ROTATION_STEPS,
    paint: (ctx) => paintBoat(ctx, hull),
  };
}

/** Small motor launch facing +x: pointed bow, open stern, little cabin. */
function paintBoat(ctx: CanvasRenderingContext2D, hull: string): void {
  const dark = shade(hull, -0.3);
  const deck = shade(hull, 0.12);

  // Hull: outline tapering to the bow at +x.
  px(ctx, 2, 3, 22, 8, OUTLINE);
  px(ctx, 24, 4, 3, 6, OUTLINE);
  px(ctx, 27, 5, 2, 4, OUTLINE);
  px(ctx, 29, 6, 1, 2, OUTLINE);
  px(ctx, 3, 4, 21, 6, hull);
  px(ctx, 24, 5, 3, 4, hull);
  px(ctx, 27, 6, 2, 2, hull);

  // Deck planking + gunwale shading.
  px(ctx, 4, 4, 19, 1, deck);
  px(ctx, 4, 9, 19, 1, dark);
  px(ctx, 22, 5, 4, 4, deck); // foredeck

  // Cabin amidships with a windscreen facing the bow.
  px(ctx, 10, 4, 8, 6, OUTLINE);
  px(ctx, 11, 5, 6, 4, shade(hull, -0.16));
  px(ctx, 16, 5, 1, 4, '#a7d4e8');

  // Stern details: outboard block + wake notch.
  px(ctx, 2, 6, 1, 2, '#2a2d33');
  px(ctx, 3, 5, 2, 4, dark);
}

// -------------------------------------------------------------------- props

function propSpec(arg: string): SpriteSpec {
  const paint = PROP_PAINTERS[arg];
  if (!paint) throw new Error(`unknown prop sprite: ${arg}`);
  const size = arg.startsWith('fence') ? { w: 18, h: 10 } : { w: 10, h: 10 };
  return { ...size, frames: 1, steps: ATLAS_ROTATION_STEPS, paint };
}

const PROP_PAINTERS: Record<string, Painter> = {
  lamp: (ctx) => {
    px(ctx, 3, 3, 4, 4, '#22252a'); // base plate
    px(ctx, 4, 4, 2, 2, '#555c64'); // pole (seen from above)
    px(ctx, 3, 3, 1, 1, '#6a727c');
  },
  lamp_broken: (ctx) => {
    px(ctx, 2, 4, 6, 2, '#3a3e44'); // toppled pole
    px(ctx, 7, 3, 2, 3, '#2a2d31'); // shattered head
    px(ctx, 3, 3, 1, 1, '#84763a'); // glass shard glint
  },
  bin: (ctx) => {
    px(ctx, 2, 2, 6, 6, OUTLINE);
    px(ctx, 3, 3, 4, 4, '#3d6b4f');
    px(ctx, 3, 3, 4, 1, '#4d8262');
    px(ctx, 4, 4, 2, 2, '#2c4d39'); // lid handle
  },
  bin_broken: (ctx) => {
    px(ctx, 1, 4, 7, 3, '#35543f');
    px(ctx, 2, 2, 3, 2, '#57604f'); // spilled trash
    px(ctx, 6, 6, 3, 2, '#4c5245');
    px(ctx, 4, 7, 2, 1, '#6a6f5d');
  },
  fence: (ctx) => {
    px(ctx, 1, 3, 16, 3, OUTLINE);
    px(ctx, 2, 4, 14, 1, '#8a7557');
    px(ctx, 1, 3, 16, 1, '#66563f');
    for (const post of [2, 8, 14]) px(ctx, post, 2, 2, 5, '#5b4c37');
  },
  fence_broken: (ctx) => {
    px(ctx, 1, 5, 7, 2, '#6d5c43');
    px(ctx, 10, 4, 7, 2, '#66563f');
    px(ctx, 4, 2, 2, 5, '#5b4c37');
    px(ctx, 12, 3, 2, 2, '#4c3f2d');
  },
};

export function propSpriteKey(kind: string, intact: boolean): string {
  return `prop:${intact ? kind : `${kind}_broken`}`;
}

// ------------------------------------------------------------ shadow blobs

function blobSpec(arg: string): SpriteSpec {
  const [wStr = '10', hStr = '6'] = arg.split('x');
  const w = Math.max(2, Number.parseInt(wStr, 10));
  const h = Math.max(2, Number.parseInt(hStr, 10));
  return {
    w: w + 2,
    h: h + 2,
    frames: 1,
    steps: 16,
    paint: (ctx, cx, cy) => {
      ctx.fillStyle = 'rgba(8, 10, 16, 0.30)';
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}
