import palette from 'shared/data/palette.json';
import {
  AMBIENT,
  AMBIENT_TINT,
  DEVICE_H,
  DEVICE_W,
  GRADE_DAY,
  GRADE_NIGHT,
  VIGNETTE,
} from './config.js';

export type LightKind = 'lamp' | 'head' | 'red' | 'blue' | 'muzzle' | 'shop';

const LIGHT_COLORS: Record<LightKind, string> = {
  lamp: palette.lampGlow,
  head: palette.headlight,
  red: palette.sirenRed,
  blue: palette.sirenBlue,
  muzzle: palette.muzzle,
  shop: palette.signGlow,
};

const TEX_SIZE = 128;
const CONE_LEN = 128;
const CONE_HALF = 44;

interface PointLight {
  x: number;
  y: number;
  radius: number;
  kind: LightKind;
  alpha: number;
}

interface ConeLight {
  x: number;
  y: number;
  angle: number;
  length: number;
  kind: LightKind;
  alpha: number;
}

/**
 * The lighting pass: a dusk grade multiplied over the finished scene, then
 * every light added back on top.
 *
 * This is the cheapest way to get the look that made top-down city games feel
 * nocturnal and dense — pools under street lamps, headlight cones sweeping the
 * asphalt, sirens strobing off the buildings — without a shader stack. It costs
 * two full-screen composites plus one blit per light, and all the light
 * textures are baked once at construction.
 */
export class LightPass {
  private grade: { r: number; g: number; b: number; tint: number; vignette: number } | null = null;
  private night = 0.5;
  private readonly textures = new Map<LightKind, HTMLCanvasElement>();
  private readonly cones = new Map<LightKind, HTMLCanvasElement>();
  private readonly vignette: HTMLCanvasElement;
  private points: PointLight[] = [];
  private coneList: ConeLight[] = [];

  /** Off by default in daylight; the renderer decides. */
  enabled = true;

  constructor() {
    for (const kind of Object.keys(LIGHT_COLORS) as LightKind[]) {
      this.textures.set(kind, makePointTexture(LIGHT_COLORS[kind]));
      this.cones.set(kind, makeConeTexture(LIGHT_COLORS[kind]));
    }
    this.vignette = makeVignette();
  }

  reset(): void {
    this.points.length = 0;
    this.coneList.length = 0;
  }

  /** Device-pixel position and radius. */
  /**
   * Set the hour, 0 (full day) to 1 (deep night). Left unset, the pass falls
   * back to the fixed dusk it used before there was a clock.
   */
  setNight(amount: number): void {
    const n = Math.max(0, Math.min(1, amount));
    const mix = (a: number, b: number): number => Math.round(a + (b - a) * n);
    this.grade = {
      r: mix(GRADE_DAY.r, GRADE_NIGHT.r),
      g: mix(GRADE_DAY.g, GRADE_NIGHT.g),
      b: mix(GRADE_DAY.b, GRADE_NIGHT.b),
      tint: GRADE_DAY.tint + (GRADE_NIGHT.tint - GRADE_DAY.tint) * n,
      vignette: GRADE_DAY.vignette + (GRADE_NIGHT.vignette - GRADE_DAY.vignette) * n,
    };
    this.night = n;
  }

  /** How dark it is now, for callers that fade lamps in with the dusk. */
  get nightAmount(): number {
    return this.night;
  }

  point(x: number, y: number, radius: number, kind: LightKind, alpha = 1): void {
    if (x < -radius || y < -radius || x > DEVICE_W + radius || y > DEVICE_H + radius) return;
    this.points.push({ x, y, radius, kind, alpha });
  }

  /** A headlight-style beam, pointing along `angle`. */
  cone(x: number, y: number, angle: number, length: number, kind: LightKind, alpha = 1): void {
    if (x < -length || y < -length || x > DEVICE_W + length || y > DEVICE_H + length) return;
    this.coneList.push({ x, y, angle, length, kind, alpha });
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.enabled) {
      this.reset();
      return;
    }

    // Grade first: darken and cool the whole scene so the lights have somewhere
    // to land. One multiply plus one translucent overlay.
    const g = this.grade;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = g ? `rgb(${g.r}, ${g.g}, ${g.b})` : AMBIENT;
    ctx.fillRect(0, 0, DEVICE_W, DEVICE_H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g ? `rgba(24, 34, 58, ${g.tint.toFixed(3)})` : AMBIENT_TINT;
    ctx.fillRect(0, 0, DEVICE_W, DEVICE_H);

    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.coneList) {
      const tex = this.cones.get(c.kind) as HTMLCanvasElement;
      const s = c.length / CONE_LEN;
      ctx.globalAlpha = c.alpha;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.scale(s, s);
      ctx.drawImage(tex, 0, -tex.height / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (const p of this.points) {
      const tex = this.textures.get(p.kind) as HTMLCanvasElement;
      const d = p.radius * 2;
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(tex, p.x - p.radius, p.y - p.radius, d, d);
    }
    ctx.restore();

    // Vignette last, so it darkens the lights too and the frame reads as one
    // exposure rather than a stack of layers.
    ctx.globalAlpha = g ? g.vignette : VIGNETTE;
    ctx.drawImage(this.vignette, 0, 0);
    ctx.globalAlpha = 1;
    this.reset();
  }
}

function makePointTexture(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const r = TEX_SIZE / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, withAlpha(color, 0.95));
  grad.addColorStop(0.35, withAlpha(color, 0.42));
  grad.addColorStop(0.7, withAlpha(color, 0.12));
  grad.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  return canvas;
}

/** A beam pointing along +x, fading out along its length and across its width. */
function makeConeTexture(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CONE_LEN;
  canvas.height = CONE_HALF * 2;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  ctx.beginPath();
  ctx.moveTo(0, CONE_HALF - 4);
  ctx.lineTo(CONE_LEN, 0);
  ctx.lineTo(CONE_LEN, CONE_HALF * 2);
  ctx.lineTo(0, CONE_HALF + 4);
  ctx.closePath();
  ctx.clip();

  const grad = ctx.createLinearGradient(0, 0, CONE_LEN, 0);
  grad.addColorStop(0, withAlpha(color, 0.55));
  grad.addColorStop(0.5, withAlpha(color, 0.22));
  grad.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CONE_LEN, CONE_HALF * 2);

  // Soften the hard clipped edges into the beam.
  const across = ctx.createLinearGradient(0, 0, 0, CONE_HALF * 2);
  across.addColorStop(0, 'rgba(0,0,0,0.75)');
  across.addColorStop(0.5, 'rgba(0,0,0,0)');
  across.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, CONE_LEN, CONE_HALF * 2);
  return canvas;
}

function makeVignette(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = DEVICE_W;
  canvas.height = DEVICE_H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(
    DEVICE_W / 2,
    DEVICE_H / 2,
    Math.min(DEVICE_W, DEVICE_H) * 0.32,
    DEVICE_W / 2,
    DEVICE_H / 2,
    Math.max(DEVICE_W, DEVICE_H) * 0.72,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  // Baked at full strength and modulated with globalAlpha at draw time: the
  // hour changes it every frame, and rebuilding a full-screen radial gradient
  // per frame would turn a free feature into a performance problem.
  grad.addColorStop(1, 'rgba(3, 6, 12, 1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, DEVICE_W, DEVICE_H);
  return canvas;
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
