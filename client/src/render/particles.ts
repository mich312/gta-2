import type { Vec2 } from 'shared';
import { PARTICLE_POOL_SIZE } from './style.js';

/**
 * Fixed-pool particle system. The pool is allocated once and recycled —
 * a firefight never allocates. When the pool is exhausted the oldest
 * particle is stolen, so bursts degrade by shortening old effects instead
 * of dropping new ones.
 *
 * Two layers: 'ground' draws under entities (debris, blood droplets,
 * casings), 'air' draws over them (smoke, sparks, muzzle cores).
 */

type ParticleKind = 'spark' | 'smoke' | 'blood' | 'debris' | 'exhaust' | 'muzzle';

interface Particle {
  alive: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ageMs: number;
  lifeMs: number;
  size: number;
  /** Per-particle colour; kind decides how it's applied. */
  color: string;
  /** Angular spin for debris chips. */
  spin: number;
  rot: number;
}

const AIR: ReadonlySet<ParticleKind> = new Set(['spark', 'smoke', 'exhaust', 'muzzle']);

export class ParticleSystem {
  private readonly pool: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.pool.push({
        alive: false,
        kind: 'spark',
        x: 0, y: 0, vx: 0, vy: 0,
        ageMs: 0, lifeMs: 1,
        size: 1, color: '#fff', spin: 0, rot: 0,
      });
    }
  }

  private take(): Particle {
    // Prefer a dead slot; otherwise steal the slot after the cursor (oldest-ish).
    for (let i = 0; i < this.pool.length; i++) {
      this.cursor = (this.cursor + 1) % this.pool.length;
      const p = this.pool[this.cursor] as Particle;
      if (!p.alive) return p;
    }
    this.cursor = (this.cursor + 1) % this.pool.length;
    return this.pool[this.cursor] as Particle;
  }

  private spawn(
    kind: ParticleKind,
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifeMs: number,
    size: number,
    color: string,
    spin = 0,
  ): void {
    const p = this.take();
    p.alive = true;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.ageMs = 0;
    p.lifeMs = lifeMs;
    p.size = size;
    p.color = color;
    p.spin = spin;
    p.rot = Math.random() * Math.PI * 2;
  }

  // ------------------------------------------------------------- emitters

  /** Impact sparks + a stone-dust puff where a shot lands. */
  impact(x: number, y: number, angle: number): void {
    for (let i = 0; i < 5; i++) {
      const a = angle + Math.PI + (Math.random() - 0.5) * 1.6;
      const sp = 40 + Math.random() * 120;
      this.spawn('spark', x, y, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 120, 1, '#ffd98a');
    }
    this.spawn('smoke', x, y, 0, -4, 320, 2.5, 'rgba(160,160,160,0.5)');
  }

  /** Muzzle flash core + smoke wisp at a gun's mouth. */
  muzzle(x: number, y: number, angle: number): void {
    this.spawn('muzzle', x, y, Math.cos(angle) * 30, Math.sin(angle) * 30, 70, 3, '#ffe9b0');
    this.spawn(
      'smoke',
      x + Math.cos(angle) * 4,
      y + Math.sin(angle) * 4,
      Math.cos(angle) * 12,
      Math.sin(angle) * 12 - 3,
      420,
      1.8,
      'rgba(190,190,190,0.45)',
    );
  }

  /** Blood spray from a wounded human. */
  blood(x: number, y: number, angle: number): void {
    for (let i = 0; i < 7; i++) {
      const a = angle + (Math.random() - 0.5) * 1.2;
      const sp = 20 + Math.random() * 70;
      this.spawn('blood', x, y, Math.cos(a) * sp, Math.sin(a) * sp, 260 + Math.random() * 240, 1 + (Math.random() < 0.3 ? 1 : 0), '#7e1414');
    }
  }

  /** Wood/metal chips when a prop breaks. */
  debris(x: number, y: number, tint: string): void {
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 90;
      this.spawn('debris', x, y, Math.cos(a) * sp, Math.sin(a) * sp, 340 + Math.random() * 300, 1 + Math.random() * 1.6, tint, (Math.random() - 0.5) * 12);
    }
    this.spawn('smoke', x, y, 0, -6, 500, 4, 'rgba(150,148,140,0.5)');
  }

  /** Exhaust puff behind a moving car. */
  exhaust(x: number, y: number): void {
    this.spawn('exhaust', x, y, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6 - 3, 600, 2.0, 'rgba(140,140,146,0.5)');
  }

  /** Tyre smoke while drifting. */
  tyreSmoke(x: number, y: number): void {
    this.spawn('smoke', x, y, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 380, 2.2, 'rgba(200,200,200,0.30)');
  }

  // -------------------------------------------------------------- update

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifeMs) {
        p.alive = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      // Kind-specific drag/expansion.
      const drag = p.kind === 'spark' ? 0.9 : p.kind === 'debris' ? 3.0 : 1.6;
      const f = Math.max(0, 1 - drag * dt);
      p.vx *= f;
      p.vy *= f;
      if (p.kind === 'smoke' || p.kind === 'exhaust') p.size += 5 * dt;
    }
  }

  drawGround(ctx: CanvasRenderingContext2D, cam: Vec2): void {
    this.drawLayer(ctx, cam, false);
  }

  drawAir(ctx: CanvasRenderingContext2D, cam: Vec2): void {
    this.drawLayer(ctx, cam, true);
  }

  private drawLayer(ctx: CanvasRenderingContext2D, cam: Vec2, air: boolean): void {
    for (const p of this.pool) {
      if (!p.alive || AIR.has(p.kind) !== air) continue;
      const t = p.ageMs / p.lifeMs;
      const x = p.x - cam.x;
      const y = p.y - cam.y;
      switch (p.kind) {
        case 'spark': {
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = 1 - t;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - p.vx * 0.02, y - p.vy * 0.02);
          ctx.stroke();
          break;
        }
        case 'muzzle': {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = (1 - t) * 0.9;
          ctx.beginPath();
          ctx.arc(x, y, p.size * (1 - t * 0.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'smoke':
        case 'exhaust': {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = (1 - t) * 0.8;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'blood': {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 1 - t * t;
          ctx.fillRect(Math.floor(x), Math.floor(y), p.size, p.size);
          break;
        }
        case 'debris': {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 1 - t;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
