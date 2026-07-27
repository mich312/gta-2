import palette from 'shared/data/palette.json';
import { RENDER_SCALE } from './config.js';
import type { LightPass } from './lighting.js';

const MAX_PARTICLES = 600;
const MAX_DECALS = 220;

interface Particle {
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
type DecalShape = 'rect' | 'ellipse' | 'scorch';

interface Decal {
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
      });
    }
  }

  /** Advance every live particle and age the decals. `dt` in seconds. */
  update(dt: number): void {
    const step = Math.min(dt, 0.1);
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= step;
      if (p.life <= 0) {
        p.alive = false;
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
  }

  // ── emitters ───────────────────────────────────────────────────────────────

  /** Muzzle flash: a short cone of sparks plus a puff of lit smoke. */
  muzzleFlash(x: number, y: number, angle: number): void {
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
  blood(x: number, y: number, angle: number): void {
    for (let i = 0; i < 10; i++) {
      const spread = (Math.random() - 0.5) * 1.5;
      const speed = 45 + Math.random() * 170;
      this.spawn(
        x,
        y,
        Math.cos(angle + spread) * speed,
        Math.sin(angle + spread) * speed,
        0.2 + Math.random() * 0.25,
        1.6,
        palette.blood,
        false,
        6,
      );
    }
    for (let i = 0; i < 3; i++) {
      this.addDecal(
        x + (Math.random() - 0.5) * 9,
        y + (Math.random() - 0.5) * 9,
        Math.random() * Math.PI,
        4 + Math.random() * 6,
        3 + Math.random() * 5,
        'rgba(96, 16, 26, 0.62)',
        24,
        'ellipse',
      );
    }
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
  ): void {
    const decal: Decal = { x, y, angle, w, h, color, shape, life, maxLife: life };
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
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  /** Ground marks, below everything that moves. */
  drawDecals(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
    if (this.decals.length === 0) return;
    ctx.save();
    for (const d of this.decals) {
      const fade = Math.min(1, d.life / (d.maxLife * 0.35));
      ctx.globalAlpha = fade;
      ctx.fillStyle = d.color;
      ctx.translate(originX + d.x * RENDER_SCALE, originY + d.y * RENDER_SCALE);
      ctx.rotate(d.angle);
      const w = d.w * RENDER_SCALE;
      const h = d.h * RENDER_SCALE;
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
      ctx.globalAlpha = additive ? t : t * 0.85;
      ctx.fillStyle = p.color;
      const size = Math.max(1, Math.round(p.size * RENDER_SCALE * (additive ? t : 1 + (1 - t))));
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
  }
}
