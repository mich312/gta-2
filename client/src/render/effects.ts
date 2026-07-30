import palette from 'shared/data/palette.json';
import { RENDER_SCALE } from './config.js';
import type { LightKind, LightPass } from './lighting.js';

const MAX_PARTICLES = 600;
/**
 * Transient lights alive at once. Small on purpose: these are the loudest
 * things on screen, and a dozen of them overlapping is a white frame.
 */
const MAX_FLASHES = 24;
/**
 * Blood now lands as a dozen-odd separate droplet marks per casualty instead
 * of three stamped stains, which is the whole point of it — but it also means
 * one firefight used to churn through the entire decal pool and evict every
 * tyre mark and scorch in the neighbourhood. A decal is one small ellipse;
 * the extra headroom is cheaper than the thing it protects.
 */
const MAX_DECALS = 460;

export interface Particle {
  alive: boolean;
  /** World position and velocity, px and px/s. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds remaining, and the value it started at. */
  life: number;
  maxLife: number;
  size: number;
  drag: number;
  color: string;
  /** Additively composited (sparks, muzzle smoke lit from inside). */
  additive: boolean;
  /** Spawns a small light while alive. */
  glow: number;
  /**
   * Width of the mark this particle leaves where it comes to rest, or 0 for
   * one that simply fades.
   *
   * Blood used to spray ten droplets that vanished in mid-air while three
   * stains appeared instantly on the ground beneath, unrelated to any of
   * them. Landing the droplets is the difference between a spray and a
   * decoration: where the blood goes is where the blood ends up.
   */
  settle: number;
}

/**
 * How a decal is painted.
 *
 * Every decal used to be a `fillRect`, which is fine for a tyre mark — that IS
 * a rectangle — and wrong for everything else. It was most wrong for the
 * explosion scorch, a 111-pixel axis-aligned square of flat grey that made the
 * blast radius look rectangular even though the damage falloff has always been
 * a circle. `scorch` is a cached radial gradient so the mark fades out at its
 * edge the way burnt asphalt does, and is drawn at exactly the blast radius, so
 * what you see is the area that actually hurt.
 */
/** A light with a lifetime: a fireball, a muzzle flash, a blown transformer. */
export interface Flash {
  x: number;
  y: number;
  radius: number;
  kind: LightKind;
  life: number;
  maxLife: number;
  /** Alpha at the instant it is born. */
  peak: number;
}

type DecalShape = 'rect' | 'ellipse' | 'scorch';

export interface Decal {
  x: number;
  y: number;
  angle: number;
  w: number;
  h: number;
  color: string;
  shape: DecalShape;
  /** Seconds remaining; skid marks outlive blood. */
  life: number;
  maxLife: number;
  /**
   * Seconds this mark takes to reach full size, or 0 to appear whole.
   *
   * Blood spreads. A stain that snaps to its final size the instant somebody
   * is hit reads as a texture that was always there; one that creeps outwards
   * over a second and a half reads as something that is happening.
   */
  spreadSec: number;
}

/**
 * The blood palette, dark to light.
 *
 * Three tones rather than one flat maroon: a pool is darkest where it is
 * deepest, the spray that carries furthest is the thinnest and brightest, and
 * a single colour for all of it was the main reason the old stains read as
 * printed texture rather than liquid.
 */
export const BLOOD_DEEP = 'rgba(74, 9, 16, 0.72)';
export const BLOOD_POOL = 'rgba(104, 15, 22, 0.60)';
export const BLOOD_DROP = 'rgba(122, 20, 26, 0.55)';
/** How long a stain stays on the tarmac. */
export const BLOOD_LIFE_SEC = 26;

/**
 * Spreading, eased out: fastest at the moment it lands, then creeping.
 * Liquid running out across asphalt does not spread linearly.
 */
export function spreadEase(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - c) * (1 - c);
}


/**
 * How a decal and a particle look right now, as pure functions of their state.
 *
 * Exported, and used by `drawDecals`/`drawParticles` themselves, because there
 * is now more than one renderer presenting this simulation: the Canvas one here
 * and the instanced-quad one in `three/effects3d.ts`. The *simulation* is
 * shared by construction — both read the same `Effects` — and these keep the
 * *presentation* shared too, so blood cannot fade at one rate in 2D and another
 * in 3D. Sizes come back in world px; each renderer applies its own scale.
 */

/** Alpha of a decal: it holds full strength, then fades over its last third. */
export function decalAlpha(d: Decal): number {
  return Math.min(1, d.life / (d.maxLife * 0.35));
}

/** How far a decal has spread towards its final size, 0..1. */
export function decalSpread(d: Decal): number {
  if (d.spreadSec <= 0) return 1;
  return spreadEase(1 - Math.max(0, d.life - (d.maxLife - d.spreadSec)) / d.spreadSec);
}

/** Alpha of a particle. Additive ones carry their own brightness. */
export function particleAlpha(p: Particle): number {
  const t = p.life / p.maxLife;
  return p.additive ? t : t * 0.85;
}

/**
 * Size of a particle in WORLD px.
 *
 * Sparks shrink as they die; smoke grows as it thins. Same curve in both
 * renderers, which is the whole point of it living out here.
 */
export function particleSize(p: Particle): number {
  const t = p.life / p.maxLife;
  return p.size * (p.additive ? t : 1 + (1 - t));
}

let scorchTexture: HTMLCanvasElement | null = null;

/** Soft round burn mark, rasterised once and tinted by alpha at draw time. */
function getScorchTexture(): HTMLCanvasElement {
  if (scorchTexture) return scorchTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(10, 8, 8, 0.72)');
  g.addColorStop(0.45, 'rgba(14, 11, 11, 0.55)');
  g.addColorStop(0.8, 'rgba(20, 16, 16, 0.22)');
  g.addColorStop(1, 'rgba(20, 16, 16, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  scorchTexture = canvas;
  return canvas;
}

/**
 * Particles and ground decals.
 *
 * Both are fixed-size pools drawn in world space: nothing allocates during
 * play, and the oldest entry is simply overwritten when a pool wraps. Decals
 * live below the entities and particles above them, which is what sells a
 * gunfight — scorch and blood stay on the tarmac while sparks and smoke pass
 * over the top of whoever is standing there.
 */
export class Effects {
  private particles: Particle[] = [];
  private decals: Decal[] = [];
  private flashes: Flash[] = [];
  private nextParticle = 0;
  private nextDecal = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        drag: 0,
        color: '#fff',
        additive: false,
        glow: 0,
        settle: 0,
      });
    }
  }

  /** Advance every live particle and age the decals. `dt` in seconds. */
  /**
   * The live pools, for a renderer other than the Canvas one below.
   *
   * Read-only views rather than a copy: the 3D layer presents the *same*
   * simulation, so a skid mark is one skid mark that two renderers can draw
   * rather than two that have to be kept in step. Dead particles are included
   * — the pool is a ring buffer and `alive` is the filter — so a caller must
   * skip them exactly as `drawParticles` does.
   */
  get decalPool(): readonly Decal[] {
    return this.decals;
  }

  get particlePool(): readonly Particle[] {
    return this.particles;
  }

  /**
   * The live flashes: a fireball, a muzzle flash, a blown transformer.
   *
   * These are lights with a lifetime and nothing else — they draw no pixels of
   * their own. The 2D pass feeds them into its Canvas compositor as it draws
   * the particles; the 3D one hands them to real lights.
   */
  get flashPool(): readonly Flash[] {
    return this.flashes;
  }

  /**
   * How much is live right now: decals, and particles that have not expired.
   *
   * For the debug overlay and for tests. "Is the blood there?" is otherwise a
   * question you can only answer by staring at pixels, and it is the first
   * question to ask when one renderer shows an effect and the other does not.
   */
  counts(): { decals: number; particles: number } {
    let particles = 0;
    for (const p of this.particles) if (p.alive) particles++;
    return { decals: this.decals.length, particles };
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.1);
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= step;
      if (p.life <= 0) {
        p.alive = false;
        // Where it landed is where the stain is.
        if (p.settle > 0) {
          this.addDecal(
            p.x,
            p.y,
            Math.random() * Math.PI,
            p.settle,
            p.settle * (0.6 + Math.random() * 0.5),
            BLOOD_DROP,
            BLOOD_LIFE_SEC,
            'ellipse',
            0.25,
          );
        }
        continue;
      }
      const damping = Math.max(0, 1 - p.drag * step);
      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx * step;
      p.y += p.vy * step;
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i] as Decal;
      d.life -= step;
      if (d.life <= 0) this.decals.splice(i, 1);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i] as Flash;
      f.life -= step;
      if (f.life <= 0) this.flashes.splice(i, 1);
    }
  }

  /**
   * A light that exists for a moment and then does not: the fireball of a car
   * going up, the flash off a barrel.
   *
   * Kept here rather than in the light pass because it is a world-space thing
   * with a lifetime, and this is where world-space things with lifetimes live.
   * Without it the only illumination an explosion threw was the glow on its
   * own sparks — the street it happened in stayed exactly as dark as it was.
   */
  flash(x: number, y: number, radius: number, kind: LightKind, life: number, peak = 1): void {
    if (this.flashes.length >= MAX_FLASHES) this.flashes.shift();
    this.flashes.push({ x, y, radius, kind, life, maxLife: life, peak });
  }

  // ── emitters ───────────────────────────────────────────────────────────────

  /** Muzzle flash: a short cone of sparks plus a puff of lit smoke. */
  muzzleFlash(x: number, y: number, angle: number): void {
    // One frame of light off the barrel. Short enough that it reads as a
    // flash rather than a lamp, bright enough to find you in an alley.
    this.flash(x, y, 34, 'muzzle', 0.09, 0.85);
    for (let i = 0; i < 7; i++) {
      const spread = (Math.random() - 0.5) * 0.55;
      const speed = 130 + Math.random() * 190;
      this.spawn(
        x,
        y,
        Math.cos(angle + spread) * speed,
        Math.sin(angle + spread) * speed,
        0.06 + Math.random() * 0.07,
        1.6,
        palette.spark,
        true,
        6,
      );
    }
    for (let i = 0; i < 3; i++) {
      const spread = (Math.random() - 0.5) * 0.9;
      this.spawn(
        x + Math.cos(angle) * 5,
        y + Math.sin(angle) * 5,
        Math.cos(angle + spread) * 45,
        Math.sin(angle + spread) * 45,
        0.28,
        2.4,
        palette.smoke,
        false,
        4,
        0,
      );
    }
  }

  /** Bullet striking a surface: sparks bouncing back along the normal. */
  impact(x: number, y: number, angle: number): void {
    for (let i = 0; i < 8; i++) {
      const back = angle + Math.PI + (Math.random() - 0.5) * 1.7;
      const speed = 60 + Math.random() * 200;
      this.spawn(
        x,
        y,
        Math.cos(back) * speed,
        Math.sin(back) * speed,
        0.12 + Math.random() * 0.18,
        1.4,
        palette.spark,
        true,
        7,
      );
    }
    this.addDecal(x, y, Math.random() * Math.PI, 3, 3, 'rgba(10, 12, 16, 0.55)', 14, 'ellipse');
  }

  /**
   * A fist swung, and a fist that lands. No sparks, no muzzle flash and no
   * bullet hole: a punch used to be drawn exactly like a gunshot, because the
   * sim reports both as a `shot`.
   */
  punch(x: number, y: number, angle: number, connected: boolean): void {
    const count = connected ? 6 : 3;
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 1.6;
      const speed = (connected ? 55 : 25) + Math.random() * 60;
      this.spawn(
        x,
        y,
        Math.cos(angle + spread) * speed,
        Math.sin(angle + spread) * speed,
        0.1 + Math.random() * 0.1,
        connected ? 2 : 1.4,
        palette.smoke,
        false,
        8,
        0,
      );
    }
    if (!connected) return;
    // One bright pop on the knuckles, so a landed hit reads at a glance.
    this.spawn(x, y, 0, 0, 0.07, 3, '#ffffff', true, 0, 5);
  }

  /** A hit on something living: a spray plus a lasting stain. */
  blood(x: number, y: number, angle: number, force = 1): void {
    // The spray. Every droplet lands and leaves what it was carrying, so the
    // arc of stains on the ground is the arc the blood actually took — the
    // faster ones travel further and make the finer marks at the far end.
    const drops = Math.round(9 + 7 * force);
    for (let i = 0; i < drops; i++) {
      const spread = (Math.random() - 0.5) * 1.5;
      const fast = Math.random();
      const speed = (40 + fast * 190) * force;
      this.spawn(
        x,
        y,
        Math.cos(angle + spread) * speed,
        Math.sin(angle + spread) * speed,
        0.16 + Math.random() * 0.26,
        1.4 + fast * 1.4,
        palette.blood,
        false,
        7,
        0,
        // Thrown hardest, spread thinnest: the far marks are the small ones.
        1.4 + (1 - fast) * 2.6,
      );
    }
    // A fine mist that never lands, to give the spray some volume in the air.
    for (let i = 0; i < 4; i++) {
      const spread = (Math.random() - 0.5) * 2.2;
      this.spawn(
        x,
        y,
        Math.cos(angle + spread) * 30 * force,
        Math.sin(angle + spread) * 30 * force,
        0.22,
        2.6,
        palette.blood,
        false,
        5,
      );
    }
    // ...and the wound itself, spreading where they were hit.
    this.addDecal(
      x,
      y,
      angle,
      7 + 4 * force,
      5 + 3 * force,
      BLOOD_POOL,
      BLOOD_LIFE_SEC,
      'ellipse',
      1.1,
    );
  }

  /**
   * Blood running out of something that has stopped moving.
   *
   * Emitted by the body renderer rather than by an event, on a slow cadence,
   * so the pool under a corpse keeps creeping outward for a few seconds after
   * they go down instead of being stamped on the ground complete. The mark is
   * laid down the body's own axis: what runs out of somebody lying in the
   * road runs along them, not in a neat circle around them.
   */
  bleed(x: number, y: number, angle: number, reach: number): void {
    const off = (Math.random() - 0.5) * reach;
    this.addDecal(
      x + Math.cos(angle) * off,
      y + Math.sin(angle) * off,
      angle,
      5 + Math.random() * reach,
      4 + Math.random() * reach * 0.6,
      Math.random() < 0.4 ? BLOOD_DEEP : BLOOD_POOL,
      BLOOD_LIFE_SEC,
      'ellipse',
      1.4,
    );
  }

  /** Prop destroyed: chunks of debris thrown outwards. */
  debris(x: number, y: number, color = palette.smoke): void {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 150;
      this.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.3 + Math.random() * 0.4,
        2,
        color,
        false,
        7,
      );
    }
  }

  /** Exhaust puff behind a moving car. */
  exhaust(x: number, y: number, angle: number): void {
    this.spawn(
      x - Math.cos(angle) * 13,
      y - Math.sin(angle) * 13,
      -Math.cos(angle) * 22 + (Math.random() - 0.5) * 16,
      -Math.sin(angle) * 22 + (Math.random() - 0.5) * 16,
      0.45,
      2.2,
      palette.smoke,
      false,
      2.5,
      0,
    );
  }

  /** A car going up: fireball, smoke column, and a scorch on the tarmac. */
  explosion(x: number, y: number, radius: number): void {
    // Drawn at the true blast diameter: the mark left behind is the area the
    // falloff actually reached, not a square 1.5x guess at it.
    this.addDecal(x, y, 0, radius * 2, radius * 2, 'rgba(12, 10, 10, 0.5)', 40, 'scorch');
    // The blast lights the street it happens in, and it reaches a good deal
    // further than the fireball does. Two flashes: a hard white one that is
    // gone in a fifth of a second, and the fire under it burning down.
    this.flash(x, y, radius * 2.4, 'muzzle', 0.22, 1);
    this.flash(x, y, radius * 1.6, 'fire', 0.85, 0.8);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 60 + Math.random() * radius * 2.2;
      this.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.3 + Math.random() * 0.45,
        2 + Math.random() * 3,
        i % 3 === 0 ? palette.spark : palette.muzzle,
        true,
        1.6,
        i % 4 === 0 ? 1 : 0,
      );
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 10 + Math.random() * 40;
      this.spawn(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        0.9 + Math.random() * 0.8,
        3 + Math.random() * 4,
        palette.smoke,
        false,
        1.1,
        0,
      );
    }
  }

  /**
   * Smoke off a bent bonnet, before there is any fire.
   *
   * The gap the model had: a car went from looking fine to being on a
   * seven-second fuse with nothing in between. Grey when the bonnet is
   * buckled, black and much heavier once the radiator has gone.
   */
  engineSmoke(x: number, y: number, black: boolean): void {
    const a = Math.random() * Math.PI * 2;
    this.spawn(
      x + Math.cos(a) * 2,
      y + Math.sin(a) * 2,
      Math.cos(a) * 5,
      Math.sin(a) * 5 - (black ? 20 : 13),
      black ? 1.5 + Math.random() * 0.9 : 0.9 + Math.random() * 0.6,
      black ? 2.4 + Math.random() * 2 : 1.6 + Math.random() * 1.4,
      black ? '#1b1b20' : palette.smoke,
      false,
      black ? 1.5 : 1.25,
      0,
    );
  }

  /** Lazy flame licking off a burning wreck-to-be. */
  fire(x: number, y: number): void {
    const a = Math.random() * Math.PI * 2;
    this.spawn(
      x + Math.cos(a) * 4,
      y + Math.sin(a) * 4,
      Math.cos(a) * 8,
      Math.sin(a) * 8 - 14,
      0.35 + Math.random() * 0.3,
      1.6 + Math.random() * 1.6,
      Math.random() < 0.5 ? palette.spark : palette.muzzle,
      true,
      1.4,
      Math.random() < 0.4 ? 1 : 0,
    );
  }

  /** Rubber laid down under a hard-cornering car. */
  skid(x: number, y: number, angle: number): void {
    this.addDecal(x, y, angle, 7, 2, 'rgba(16, 18, 22, 0.4)', 30);
  }

  private addDecal(
    x: number,
    y: number,
    angle: number,
    w: number,
    h: number,
    color: string,
    life: number,
    shape: DecalShape = 'rect',
    spreadSec = 0,
  ): void {
    const decal: Decal = { x, y, angle, w, h, color, shape, life, maxLife: life, spreadSec };
    if (this.decals.length < MAX_DECALS) {
      this.decals.push(decal);
      return;
    }
    this.decals[this.nextDecal % MAX_DECALS] = decal;
    this.nextDecal++;
  }

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    color: string,
    additive: boolean,
    drag: number,
    glow = 0,
    settle = 0,
  ): void {
    const p = this.particles[this.nextParticle % MAX_PARTICLES] as Particle;
    this.nextParticle++;
    p.alive = true;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.maxLife = life;
    p.size = size;
    p.color = color;
    p.additive = additive;
    p.drag = drag;
    p.glow = glow;
    p.settle = settle;
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  /** Ground marks, below everything that moves. */
  drawDecals(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
    if (this.decals.length === 0) return;
    ctx.save();
    for (const d of this.decals) {
      ctx.globalAlpha = decalAlpha(d);
      ctx.fillStyle = d.color;
      ctx.translate(originX + d.x * RENDER_SCALE, originY + d.y * RENDER_SCALE);
      ctx.rotate(d.angle);
      // Still spreading? Ease out, so it runs fastest at the moment it lands.
      const spread = decalSpread(d);
      const w = d.w * spread * RENDER_SCALE;
      const h = d.h * spread * RENDER_SCALE;
      if (d.shape === 'scorch') {
        ctx.drawImage(getScorchTexture(), -w / 2, -h / 2, w, h);
      } else if (d.shape === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
  }

  /** Sparks, smoke and spray, above the entities. Lights are fed as we go. */
  drawParticles(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number,
    lights: LightPass,
  ): void {
    ctx.save();
    let additive = false;
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.particles) {
      if (!p.alive) continue;
      const t = p.life / p.maxLife;
      if (p.additive !== additive) {
        additive = p.additive;
        ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
      }
      ctx.globalAlpha = particleAlpha(p);
      ctx.fillStyle = p.color;
      const size = Math.max(1, Math.round(particleSize(p) * RENDER_SCALE));
      ctx.fillRect(
        Math.floor(originX + p.x * RENDER_SCALE - size / 2),
        Math.floor(originY + p.y * RENDER_SCALE - size / 2),
        size,
        size,
      );
      if (p.glow > 0) {
        lights.point(
          originX + p.x * RENDER_SCALE,
          originY + p.y * RENDER_SCALE,
          p.glow * RENDER_SCALE * 4,
          'muzzle',
          t * 0.6,
        );
      }
    }
    ctx.restore();

    for (const f of this.flashes) {
      const t = f.life / f.maxLife;
      // Fades on a curve, not a ramp: the first third of a flash is most of
      // what the eye gets, and a linear fade reads as a dimmer being turned.
      lights.point(
        originX + f.x * RENDER_SCALE,
        originY + f.y * RENDER_SCALE,
        f.radius * RENDER_SCALE * (1.25 - 0.25 * t),
        f.kind,
        f.peak * t * t,
        'dynamic',
      );
    }
  }
}
