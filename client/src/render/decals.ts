import type { Vec2 } from 'shared';
import { DECAL_RING_SIZE } from './style.js';

/**
 * Persistent ground marks — skids, blood pools, scorch, litter — in a fixed
 * ring buffer. New marks overwrite the oldest once the ring is full, so
 * memory is bounded no matter how long a session runs. Each mark fades out
 * over the last quarter of its life.
 */

type DecalKind = 'skid' | 'blood' | 'scorch' | 'stain';

interface Decal {
  alive: boolean;
  kind: DecalKind;
  x: number;
  y: number;
  angle: number;
  size: number;
  bornMs: number;
  ttlMs: number;
}

export class DecalLayer {
  private readonly ring: Decal[] = [];
  private head = 0;

  constructor() {
    for (let i = 0; i < DECAL_RING_SIZE; i++) {
      this.ring.push({ alive: false, kind: 'skid', x: 0, y: 0, angle: 0, size: 0, bornMs: 0, ttlMs: 1 });
    }
  }

  private push(kind: DecalKind, x: number, y: number, angle: number, size: number, ttlMs: number, now: number): void {
    const d = this.ring[this.head] as Decal;
    this.head = (this.head + 1) % this.ring.length;
    d.alive = true;
    d.kind = kind;
    d.x = x;
    d.y = y;
    d.angle = angle;
    d.size = size;
    d.bornMs = now;
    d.ttlMs = ttlMs;
  }

  /** Twin tyre marks; call per frame while a car slides. */
  skid(x: number, y: number, heading: number, now: number): void {
    const px = -Math.sin(heading);
    const py = Math.cos(heading);
    this.push('skid', x + px * 4, y + py * 4, heading, 3, 24_000, now);
    this.push('skid', x - px * 4, y - py * 4, heading, 3, 24_000, now);
  }

  blood(x: number, y: number, now: number, size = 5): void {
    this.push('blood', x, y, Math.random() * Math.PI * 2, size, 45_000, now);
  }

  scorch(x: number, y: number, now: number, size = 6): void {
    this.push('scorch', x, y, Math.random() * Math.PI * 2, size, 40_000, now);
  }

  stain(x: number, y: number, now: number, size = 4): void {
    this.push('stain', x, y, Math.random() * Math.PI * 2, size, 30_000, now);
  }

  draw(ctx: CanvasRenderingContext2D, cam: Vec2, now: number, viewW: number, viewH: number): void {
    for (const d of this.ring) {
      if (!d.alive) continue;
      const age = now - d.bornMs;
      if (age >= d.ttlMs) {
        d.alive = false;
        continue;
      }
      const x = d.x - cam.x;
      const y = d.y - cam.y;
      if (x < -16 || y < -16 || x > viewW + 16 || y > viewH + 16) continue;
      const fade = Math.min(1, (1 - age / d.ttlMs) * 4); // last 25% fades
      switch (d.kind) {
        case 'skid': {
          ctx.strokeStyle = `rgba(20, 20, 24, ${(0.32 * fade).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          const dx = Math.cos(d.angle) * d.size;
          const dy = Math.sin(d.angle) * d.size;
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x + dx, y + dy);
          ctx.stroke();
          ctx.lineWidth = 1;
          break;
        }
        case 'blood': {
          ctx.fillStyle = `rgba(96, 14, 14, ${(0.5 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(x, y, d.size, d.size * 0.7, d.angle, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(70, 8, 8, ${(0.5 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(x + d.size * 0.4, y - d.size * 0.2, d.size * 0.4, d.size * 0.3, d.angle, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'scorch': {
          ctx.fillStyle = `rgba(18, 16, 14, ${(0.45 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(x, y, d.size, d.size * 0.8, d.angle, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'stain': {
          ctx.fillStyle = `rgba(40, 38, 30, ${(0.35 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(x, y, d.size, d.size * 0.6, d.angle, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
  }
}
