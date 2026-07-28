import type { CityMap } from 'shared';
import palette from 'shared/data/palette.json';
import {
  AMBIENT,
  AMBIENT_TINT,
  BLOOM_ALPHA,
  BLOOM_DOWNSCALE,
  GRADE_DAY,
  GRADE_NIGHT,
  LIGHT_CACHE_LIMIT,
  LIGHT_HEIGHT,
  MAX_LIGHT_BAKES,
  MAX_SHADOW_LIGHTS,
  RENDER_SCALE,
  SHADOW_BOUNCE,
  SHADOW_SAMPLES_DYNAMIC,
  SHADOW_SAMPLES_STATIC,
  SKY_BOUNCE,
  SOURCE_RADIUS,
  VIGNETTE,
} from './config.js';
import { hash2, noise1 } from './noise.js';
import {
  type Occluder,
  entityEdges,
  occluderEdges,
  punchShadows,
  sampleAlpha,
  sampleOffset,
} from './shadows.js';
import { viewport } from './viewport.js';

export type LightKind = 'lamp' | 'head' | 'red' | 'blue' | 'muzzle' | 'shop' | 'window' | 'fire';

/**
 * Whether a light is stopped by the city.
 *
 * `static` is the same answer every frame — a lamp post has not moved since
 * worldgen — so it is baked once and blitted thereafter. `dynamic` is
 * recomputed, and rationed. `none` is for lights that are already at the thing
 * they are lighting (a window in a wall, a taillight) where an occlusion test
 * would only ever find the surface the light is sitting on.
 */
export type ShadowMode = 'none' | 'static' | 'dynamic';

const LIGHT_COLORS: Record<LightKind, string> = {
  lamp: palette.lampGlow,
  head: palette.headlight,
  red: palette.sirenRed,
  blue: palette.sirenBlue,
  muzzle: palette.muzzle,
  shop: palette.signGlow,
  window: palette.windowGlow,
  fire: palette.fireGlow,
};

const TEX_SIZE = 128;
const CONE_LEN = 128;
const CONE_HALF = 44;
/** Ceiling on a baked light sprite, in device pixels. */
const MAX_SPRITE = 512;

interface PointLight {
  x: number;
  y: number;
  radius: number;
  kind: LightKind;
  alpha: number;
  shadow: ShadowMode;
}

/** Scratch buffers the sky pass works in, one set per sprite size. */
interface ShadowPad {
  mask: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
  pristine: HTMLCanvasElement;
  pristineCtx: CanvasRenderingContext2D;
}

interface ConeLight {
  x: number;
  y: number;
  angle: number;
  length: number;
  kind: LightKind;
  alpha: number;
  shadow: ShadowMode;
}

/**
 * The lighting pass: a dusk grade multiplied over the finished scene, then
 * every light added back on top of it — through the city rather than over it.
 *
 * Three things happen here that a plain additive blit does not do. Lights are
 * accumulated into their own buffer rather than straight onto the frame, which
 * is what lets them be post-processed as a group. Anything solid between a
 * light and a pixel takes the light away from it (`shadows.ts`), so a lamp
 * lights its own street and not the block behind it, and a headlight beam
 * stops at a wall. And the accumulated buffer is downscaled and added back a
 * second time, which is a bloom, and is what stops a bright lamp reading as a
 * sticker of a lamp.
 *
 * The budget: two full-screen composites for the grade, one for the light
 * buffer, two small blits for the bloom, one for the vignette, and per light
 * either a cache hit (one blit) or a bake (one gradient plus a few dozen
 * shadow quads).
 */
export class LightPass {
  private grade: { r: number; g: number; b: number; tint: number; vignette: number } | null = null;
  private night = 0.5;
  private readonly textures = new Map<LightKind, HTMLCanvasElement>();
  private readonly cones = new Map<LightKind, HTMLCanvasElement>();
  private vignette: HTMLCanvasElement;
  private points: PointLight[] = [];
  private coneList: ConeLight[] = [];

  /** The accumulation buffer, and the small canvas the bloom is folded in. */
  private buffer: HTMLCanvasElement;
  private bufferCtx: CanvasRenderingContext2D;
  private bloom: HTMLCanvasElement;
  private bloomCtx: CanvasRenderingContext2D;
  private bloomMid: HTMLCanvasElement;
  private bloomMidCtx: CanvasRenderingContext2D;
  /** Scratch a single light is assembled in before it joins the buffer. */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;
  /**
   * Working buffers for the sky pass, one set per sprite size.
   *
   * Sized to the light rather than shared at the maximum, because two of the
   * composite operations the pass needs — `copy` and `source-in` — are
   * unbounded: they clear everything outside what is being drawn, so on one
   * 512-square canvas a 136-pixel lamp paid for 262,144 pixels of work instead
   * of 18,496. Fourteen times over, for every lamp with somebody standing
   * under it, is the difference between 60 fps and 30. Sizes cluster hard
   * (every street lamp is the same radius), so the map stays tiny.
   */
  private readonly pads = new Map<number, ShadowPad>();
  /** Baked static lights, keyed by kind, radius and world position. */
  private readonly baked = new Map<string, HTMLCanvasElement>();
  /** Reused across every occlusion query in a frame; never escapes. */
  private readonly segs: number[] = [];

  /** Bodies and cars that stand in the light. Replaced every frame. */
  private occluders: readonly Occluder[] = [];

  /** The city, for occlusion, and where world origin sits on screen. */
  private map: CityMap | null = null;
  private originX = 0;
  private originY = 0;
  /** Freshly-cast shadows spent this frame, against MAX_SHADOW_LIGHTS. */
  private castBudget = 0;
  /** Static lights baked this frame, against MAX_LIGHT_BAKES. */
  private bakeBudget = 0;

  /** Off by default in daylight; the renderer decides. */
  enabled = true;
  /** Turns every shadow and the bloom off, for a machine that cannot afford them. */
  cheap = false;

  constructor() {
    for (const kind of Object.keys(LIGHT_COLORS) as LightKind[]) {
      this.textures.set(kind, makePointTexture(LIGHT_COLORS[kind]));
      this.cones.set(kind, makeConeTexture(LIGHT_COLORS[kind]));
    }
    this.vignette = makeVignette(viewport.deviceW, viewport.deviceH);
    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d') as CanvasRenderingContext2D;
    this.bloom = document.createElement('canvas');
    this.bloomCtx = this.bloom.getContext('2d') as CanvasRenderingContext2D;
    this.bloomMid = document.createElement('canvas');
    this.bloomMidCtx = this.bloomMid.getContext('2d') as CanvasRenderingContext2D;
    this.scratch = document.createElement('canvas');
    this.scratch.width = MAX_SPRITE;
    this.scratch.height = MAX_SPRITE;
    this.scratchCtx = this.scratch.getContext('2d') as CanvasRenderingContext2D;
    this.sizeBuffers();
  }

  /** Match the buffers to the frame. Cheap when nothing has changed. */
  private sizeBuffers(): void {
    const w = viewport.deviceW;
    const h = viewport.deviceH;
    if (this.buffer.width === w && this.buffer.height === h) return;
    this.buffer.width = w;
    this.buffer.height = h;
    this.bloom.width = Math.max(1, Math.round(w / BLOOM_DOWNSCALE));
    this.bloom.height = Math.max(1, Math.round(h / BLOOM_DOWNSCALE));
    this.bloomCtx.imageSmoothingEnabled = true;
    this.bloomMid.width = Math.max(1, Math.round(w / 2));
    this.bloomMid.height = Math.max(1, Math.round(h / 2));
    this.bloomMidCtx.imageSmoothingEnabled = true;
    this.vignette = makeVignette(w, h);
  }

  reset(): void {
    this.points.length = 0;
    this.coneList.length = 0;
  }

  /**
   * The city and this frame's snapped origin, so a light given in device
   * pixels can be put back into the world to ask what is standing in front
   * of it. Left unset — an evidence page, a test harness — nothing casts.
   */
  setWorld(map: CityMap | null, originX: number, originY: number): void {
    this.map = map;
    this.originX = originX;
    this.originY = originY;
  }

  /**
   * The people and cars that cast shadows this frame, in world coordinates.
   *
   * Deliberately not the whole street: parked cars, bins and lamp posts are
   * left out because a static light's shadows are baked, and anything
   * permanently standing in one would force it to be recomputed every frame
   * for a shadow that never changes. What moves is what earns the cost.
   */
  setOccluders(list: readonly Occluder[]): void {
    this.occluders = list;
  }

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

  /** Device-pixel position and radius. */
  point(
    x: number,
    y: number,
    radius: number,
    kind: LightKind,
    alpha = 1,
    shadow: ShadowMode = 'none',
  ): void {
    if (x < -radius || y < -radius || x > viewport.deviceW + radius) return;
    if (y > viewport.deviceH + radius) return;
    if (alpha <= 0.004) return;
    this.points.push({ x, y, radius, kind, alpha, shadow });
  }

  /** A headlight-style beam, pointing along `angle`. */
  cone(
    x: number,
    y: number,
    angle: number,
    length: number,
    kind: LightKind,
    alpha = 1,
    shadow: ShadowMode = 'none',
  ): void {
    if (x < -length || y < -length || x > viewport.deviceW + length) return;
    if (y > viewport.deviceH + length) return;
    if (alpha <= 0.004) return;
    this.coneList.push({ x, y, angle, length, kind, alpha, shadow });
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.enabled) {
      this.reset();
      return;
    }
    this.sizeBuffers();
    const w = viewport.deviceW;
    const h = viewport.deviceH;

    // Grade first: darken and cool the whole scene so the lights have somewhere
    // to land. One multiply plus one translucent overlay.
    const g = this.grade;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = g ? `rgb(${g.r}, ${g.g}, ${g.b})` : AMBIENT;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g ? `rgba(24, 34, 58, ${g.tint.toFixed(3)})` : AMBIENT_TINT;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Ration the freshly-cast shadows to the lights that cover the most
    // screen, so the beam you are driving behind never loses them to a siren
    // at the edge of the frame.
    this.castBudget = this.cheap ? 0 : MAX_SHADOW_LIGHTS;
    this.bakeBudget = this.cheap ? 0 : MAX_LIGHT_BAKES;
    if (this.castBudget > 0) {
      this.coneList.sort((a, b) => b.length * b.alpha - a.length * a.alpha);
      this.points.sort((a, b) => b.radius * b.alpha - a.radius * a.alpha);
    }

    const buf = this.bufferCtx;
    buf.setTransform(1, 0, 0, 1, 0, 0);
    buf.globalCompositeOperation = 'source-over';
    buf.globalAlpha = 1;
    buf.clearRect(0, 0, w, h);
    buf.globalCompositeOperation = 'lighter';

    for (const c of this.coneList) this.drawCone(buf, c);
    for (const p of this.points) this.drawPoint(buf, p);

    // The buffer joins the frame as one additive layer, then a downscaled copy
    // of it goes on a second time as the bloom.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.buffer, 0, 0);
    if (!this.cheap) {
      // Two stages on the way back up, and the last one is nearest-neighbour.
      // A single smoothed 6x magnification straight onto the frame measured at
      // 16 ms on a 1280x720 backing store — it is a slow path in the browser's
      // rasteriser, and it alone put a 1440p window under 60. Interpolating up
      // to half size costs a quarter of the pixels, and doubling *that* with no
      // filter is exactly one world pixel per step, which this art is made of.
      const mw = this.bloomMid.width;
      const mh = this.bloomMid.height;
      this.bloomCtx.globalCompositeOperation = 'copy';
      this.bloomCtx.drawImage(this.buffer, 0, 0, this.bloom.width, this.bloom.height);
      this.bloomMidCtx.globalCompositeOperation = 'copy';
      this.bloomMidCtx.drawImage(this.bloom, 0, 0, mw, mh);
      ctx.globalAlpha = BLOOM_ALPHA;
      ctx.drawImage(this.bloomMid, 0, 0, w, h);
    }
    ctx.restore();

    // Vignette last, so it darkens the lights too and the frame reads as one
    // exposure rather than a stack of layers.
    ctx.globalAlpha = g ? g.vignette : VIGNETTE;
    ctx.drawImage(this.vignette, 0, 0);
    ctx.globalAlpha = 1;
    this.reset();
  }

  /** World position of a device-pixel coordinate, for occlusion queries. */
  private worldX(x: number): number {
    return (x - this.originX) / RENDER_SCALE;
  }

  private worldY(y: number): number {
    return (y - this.originY) / RENDER_SCALE;
  }

  private drawPoint(buf: CanvasRenderingContext2D, p: PointLight): void {
    const tex = this.textures.get(p.kind) as HTMLCanvasElement;
    const d = p.radius * 2;
    const wx = this.worldX(p.x);
    const wy = this.worldY(p.y);
    const worldRadius = p.radius / RENDER_SCALE;
    const mode = this.shadowModeFor(p.shadow, d, wx, wy, worldRadius);
    const plain = (): void => {
      buf.globalAlpha = p.alpha;
      buf.drawImage(tex, p.x - p.radius, p.y - p.radius, d, d);
    };
    if (mode === 'none') return plain();

    const size = Math.min(MAX_SPRITE, Math.ceil(d));

    if (mode === 'static') {
      // Quantised to half a world pixel: a lamp is at one place for the life
      // of the city, and the key has to survive the camera moving under it.
      const key = `${p.kind}|${Math.round(p.radius)}|${Math.round(wx * 2)}|${Math.round(wy * 2)}`;
      let sprite = this.baked.get(key);
      if (!sprite) {
        // A street's worth of lamps coming into view at once would otherwise
        // bake in one frame. Draw flat now, bake on a later frame.
        if (this.bakeBudget <= 0) return plain();
        this.bakeBudget--;
        sprite = this.bake(p.kind, size, wx, wy, worldRadius);
        if (this.baked.size >= LIGHT_CACHE_LIMIT) {
          // Insertion order is close enough to least-recently-lit here: the
          // cache only ever fills with lights that have left the screen.
          const oldest = this.baked.keys().next().value;
          if (oldest !== undefined) this.baked.delete(oldest);
        }
        this.baked.set(key, sprite);
      }
      buf.globalAlpha = p.alpha;
      buf.drawImage(sprite, p.x - p.radius, p.y - p.radius, d, d);
      return;
    }

    this.castBudget--;
    const s = this.scratchCtx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, size, size);
    s.drawImage(tex, 0, 0, size, size);
    this.cut(s, size, p.kind, wx, wy, worldRadius, SHADOW_SAMPLES_DYNAMIC);
    buf.globalAlpha = p.alpha;
    buf.drawImage(this.scratch, 0, 0, size, size, p.x - p.radius, p.y - p.radius, d, d);
  }

  private drawCone(buf: CanvasRenderingContext2D, c: ConeLight): void {
    const tex = this.cones.get(c.kind) as HTMLCanvasElement;
    const wx = this.worldX(c.x);
    const wy = this.worldY(c.y);
    const worldLen = c.length / RENDER_SCALE;
    const mode = this.shadowModeFor(c.shadow, c.length * 2, wx, wy, worldLen);
    if (mode === 'none') {
      const scale = c.length / CONE_LEN;
      buf.globalAlpha = c.alpha;
      buf.translate(c.x, c.y);
      buf.rotate(c.angle);
      buf.scale(scale, scale);
      buf.drawImage(tex, 0, -tex.height / 2);
      buf.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }

    // A beam is drawn from its apex, but the shadow maths works in radii about
    // the light, so it is assembled in a square sprite centred on the apex.
    this.castBudget--;
    const want = Math.ceil(c.length * 2);
    const size = Math.min(MAX_SPRITE, want);
    const half = size / 2;
    const s = this.scratchCtx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, size, size);
    s.translate(half, half);
    s.rotate(c.angle);
    s.scale(half / CONE_LEN, half / CONE_LEN);
    s.drawImage(tex, 0, -tex.height / 2);
    s.setTransform(1, 0, 0, 1, 0, 0);
    this.cut(s, size, c.kind, wx, wy, worldLen, SHADOW_SAMPLES_DYNAMIC);
    buf.globalAlpha = c.alpha;
    buf.drawImage(this.scratch, 0, 0, size, size, c.x - want / 2, c.y - want / 2, want, want);
  }

  /**
   * Whether this light gets shadows, given what is left of the frame's budget.
   * Bigger lights are asked first (the caller sorts), so what falls off the end
   * is the small stuff nobody is looking at.
   */
  private shadowModeFor(
    want: ShadowMode,
    diameter: number,
    wx: number,
    wy: number,
    worldRadius: number,
  ): ShadowMode {
    if (want === 'none' || !this.map || this.cheap) return 'none';
    // A light smaller than a tile cannot have anything meaningful in front of
    // it: it is already inside whatever it would be occluded by.
    if (diameter < 12) return 'none';
    // A lamp's shadows are baked — until somebody walks under it. Bodies move,
    // so a light with one inside it has to be recomputed like any other, and
    // the alternative is a pedestrian standing in a pool of light throwing
    // nothing, which is the sort of thing you cannot stop seeing.
    if (want === 'static' && !this.occluderNear(wx, wy, worldRadius)) return 'static';
    return this.castBudget > 0 ? 'dynamic' : want === 'static' ? 'static' : 'none';
  }

  /** Is anything that casts a shadow standing inside this light? */
  private occluderNear(wx: number, wy: number, radius: number): boolean {
    for (const o of this.occluders) {
      const reach = radius + Math.max(o.r, Math.hypot(o.halfLong, o.halfWide));
      const dx = o.x - wx;
      const dy = o.y - wy;
      if (dx * dx + dy * dy <= reach * reach) return true;
    }
    return false;
  }

  /**
   * The working buffers for a sprite of this size, rounded up so that lights
   * of similar radius share one set rather than minting a canvas each.
   */
  private padFor(size: number): ShadowPad {
    const dim = Math.min(MAX_SPRITE, Math.ceil(size / 32) * 32);
    let pad = this.pads.get(dim);
    if (!pad) {
      if (this.pads.size >= 12) {
        const oldest = this.pads.keys().next().value;
        if (oldest !== undefined) this.pads.delete(oldest);
      }
      const mask = document.createElement('canvas');
      mask.width = dim;
      mask.height = dim;
      const pristine = document.createElement('canvas');
      pristine.width = dim;
      pristine.height = dim;
      pad = {
        mask,
        maskCtx: mask.getContext('2d') as CanvasRenderingContext2D,
        pristine,
        pristineCtx: pristine.getContext('2d') as CanvasRenderingContext2D,
      };
      this.pads.set(dim, pad);
    }
    return pad;
  }

  /** Bake a shadowed point light at its own size, for the static cache. */
  private bake(
    kind: LightKind,
    size: number,
    wx: number,
    wy: number,
    worldRadius: number,
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d') as CanvasRenderingContext2D;
    c.drawImage(this.textures.get(kind) as HTMLCanvasElement, 0, 0, size, size);
    this.cut(c, size, kind, wx, wy, worldRadius, SHADOW_SAMPLES_STATIC);
    return canvas;
  }

  /**
   * Take the light away from everything standing in front of it, and put the
   * sky back where it went.
   *
   * Three things happen, in this order, and each is load-bearing:
   *
   *  - The silhouette is cast once per sample point across the lamp's own face,
   *    at an alpha chosen so that the region every sample agrees on lands on
   *    exactly `SHADOW_BOUNCE` of the light. `destination-out` is
   *    multiplicative, so the alphas do not add: assuming they did is what
   *    leaves an umbra 37% too bright.
   *  - Each sample's whole silhouette goes down as one path with one fill, so
   *    two overlapping quads take the light away once rather than twice — the
   *    difference between a wall's shadow and a wall's shadow with a dark seam
   *    down the middle of it.
   *  - Then the sky goes back into the shadow, and only into the shadow: the
   *    coverage field, weighted by the light's own falloff so it cannot spill
   *    past the lamp's reach, recoloured and added at `SKY_BOUNCE`. A shadow
   *    at night is not a dimmer copy of the sodium lamp casting it; it is lit
   *    by the sky, and it is blue.
   *
   * The weighting is why the coverage is built in its own buffer rather than
   * punched straight into the light and subtracted back out afterwards.
   * `destination-out` computes `dst * (1 - srcAlpha)`, not a difference, so
   * subtracting a half-transparent light from itself leaves a quarter of it
   * standing — and the sky lands in that, which rings every lamp in the city
   * with a blue halo it has no business having. Measured before it was
   * noticed: a probe pixel in clear light 8% brighter with a shadow nearby
   * than without one.
   */
  private cut(
    c: CanvasRenderingContext2D,
    size: number,
    kind: LightKind,
    wx: number,
    wy: number,
    worldRadius: number,
    samples: number,
  ): void {
    const map = this.map;
    if (!map) return;
    const height = LIGHT_HEIGHT[kind] ?? 20;
    // Buildings first — the call resets the array — then the bodies on top of
    // them, which returns the new total.
    occluderEdges(map, wx, wy, worldRadius, this.segs);
    const count = entityEdges(this.occluders, wx, wy, worldRadius, height, this.segs);
    if (count === 0) return;
    const half = size / 2;
    // The sprite is `size` device pixels across a light of `worldRadius * 2`
    // world pixels, whatever the scratch was clamped to.
    const scale = half / worldRadius;
    const source = SOURCE_RADIUS[kind] ?? 2;

    const pad = this.padFor(size);
    // The light as it stands, for weighting the sky by its falloff later.
    const pr = pad.pristineCtx;
    pr.setTransform(1, 0, 0, 1, 0, 0);
    pr.globalAlpha = 1;
    pr.globalCompositeOperation = 'copy';
    pr.drawImage(c.canvas, 0, 0, size, size, 0, 0, size, size);

    // How much of the lamp's face each pixel cannot see.
    const m = pad.maskCtx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.globalAlpha = 1;
    m.clearRect(0, 0, size, size);
    m.globalAlpha = sampleAlpha(SHADOW_BOUNCE, samples);
    m.fillStyle = '#000';
    for (let i = 0; i < samples; i++) {
      const [ox, oy] = sampleOffset(i, samples, source);
      punchShadows(m, this.segs, count, wx, wy, ox, oy, half, half, scale, worldRadius);
    }

    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.globalAlpha = 1;
    c.drawImage(pad.mask, 0, 0, size, size, 0, 0, size, size);
    c.restore();

    // Coverage times falloff, in the colour of the sky.
    m.globalAlpha = 1;
    m.globalCompositeOperation = 'source-in';
    m.drawImage(pad.pristine, 0, 0, size, size, 0, 0, size, size);
    m.globalCompositeOperation = 'source-in';
    m.fillStyle = palette.skyBounce;
    m.fillRect(0, 0, size, size);

    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = SKY_BOUNCE;
    c.drawImage(pad.mask, 0, 0, size, size, 0, 0, size, size);
    c.restore();
  }
}

/**
 * Flicker: how a light varies from one frame to the next.
 *
 * The old model was one sine per lamp, out of phase by id, which reads as a
 * gentle collective breathing — nothing in a real street does that. What a
 * street actually has is a majority of steady lamps, a few that hum, one on
 * the way out that stutters, and the odd dead one that flashes once a minute
 * and gives up. Character is drawn from the id, so a given lamp is the same
 * lamp for every player and for the whole session; the value is a function of
 * wall-clock, so it is identical at 30 fps and at 144.
 */
export type FlickerKind = 'steady' | 'buzz' | 'failing' | 'dead' | 'fire' | 'neon';

/** Which sort of lamp a given id is. Stable for the life of the city. */
export function lampCharacter(id: number): FlickerKind {
  const r = hash2(id, 0x1a3b, 0x5f1d);
  if (r < 0.62) return 'steady';
  if (r < 0.82) return 'buzz';
  if (r < 0.94) return 'failing';
  return 'dead';
}

/**
 * The multiplier on a light's alpha at time `ms`. Mostly ≤ 1; `fire` overshoots
 * on purpose, because a flame that only ever dims does not look like a flame.
 */
export function flicker(kind: FlickerKind, id: number, ms: number): number {
  const t = ms / 1000;
  switch (kind) {
    case 'steady':
      // Barely there — enough to stop a still frame looking painted on.
      return 0.96 + 0.04 * Math.sin(t * 1.7 + id);
    case 'buzz': {
      // A tube with a tired ballast: a fast ripple under a slow sag.
      const hum = 0.06 * Math.sin(t * 47 + id * 3.1);
      const sag = 0.05 * Math.sin(t * 0.9 + id);
      return 0.9 + hum + sag;
    }
    case 'failing': {
      // Mostly lit, with dropouts that arrive in bursts rather than evenly.
      const n = noise1(t * 6.5, id);
      if (n < 0.24) return 0.1 + 0.5 * noise1(t * 90, id + 7);
      return 0.82 + 0.18 * noise1(t * 3, id + 3);
    }
    case 'dead': {
      // Out, apart from the occasional attempt at coming back on.
      const n = noise1(t * 0.55, id);
      if (n > 0.86) return 0.35 + 0.65 * noise1(t * 70, id + 11);
      return 0.03;
    }
    case 'fire': {
      // Two beats: the body of the flame, and the tips moving faster.
      const body = 0.78 + 0.3 * noise1(t * 7, id);
      const tips = 0.14 * noise1(t * 21, id + 5);
      return body + tips;
    }
    case 'neon':
      // Steady, until once in a while it is not.
      return noise1(t * 0.4, id) > 0.93 ? 0.25 + 0.5 * noise1(t * 60, id) : 1;
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

function makeVignette(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.32,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  // Baked at full strength and modulated with globalAlpha at draw time: the
  // hour changes it every frame, and rebuilding a full-screen radial gradient
  // per frame would turn a free feature into a performance problem.
  grad.addColorStop(1, 'rgba(3, 6, 12, 1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return canvas;
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
