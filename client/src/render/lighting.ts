import { INTERNAL_HEIGHT, INTERNAL_WIDTH, type Vec2 } from 'shared';
import { DAY_TICKS, NIGHT_RGB } from './style.js';

/**
 * Day/night cycle + 2D lightmap.
 *
 * Time of day derives from the server tick, so every client shares one sky
 * with zero extra protocol. The lightmap is an offscreen canvas painted with
 * the ambient darkness, then light sources are punched out of it with
 * radial 'destination-out' gradients; the result multiplies over the scene
 * with plain source-over (it's darkness, not light). Warm glows are drawn
 * additively straight onto the scene afterwards so lamps and headlights
 * bloom instead of just erasing shade.
 */

export interface PointLight {
  x: number;
  y: number;
  radius: number;
  /** 0..1 hole strength in the darkness layer. */
  intensity: number;
  /** Optional additive glow colour (CSS); omit for pure darkness cutting. */
  glow?: string;
  glowAlpha?: number;
}

export interface ConeLight {
  x: number;
  y: number;
  angle: number;
  length: number;
  halfWidth: number;
  intensity: number;
}

/** Daylight in [0,1] for a server tick; 1 = noon, 0 = deepest night. */
export function daylightAt(tick: number): number {
  const t = ((tick % DAY_TICKS) + DAY_TICKS) / DAY_TICKS % 1;
  // Cosine day curve with plateaus: long noon, long midnight, fast dusk.
  const raw = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  return Math.min(1, Math.max(0, (raw - 0.15) / 0.7));
}

export class LightingPass {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  readonly points: PointLight[] = [];
  readonly cones: ConeLight[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = INTERNAL_WIDTH;
    this.canvas.height = INTERNAL_HEIGHT;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context for lightmap');
    this.ctx = ctx;
  }

  /** Reset per-frame light lists. */
  begin(): void {
    this.points.length = 0;
    this.cones.length = 0;
  }

  /**
   * Composite the darkness layer onto the scene. `darkness` in [0,1];
   * anything below a whisper skips the whole pass.
   */
  compose(scene: CanvasRenderingContext2D, cam: Vec2, darkness: number): void {
    if (darkness < 0.02) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    ctx.fillStyle = `rgba(${NIGHT_RGB}, ${darkness.toFixed(3)})`;
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

    ctx.globalCompositeOperation = 'destination-out';
    for (const l of this.points) {
      const sx = l.x - cam.x;
      const sy = l.y - cam.y;
      if (sx < -l.radius || sy < -l.radius || sx > INTERNAL_WIDTH + l.radius || sy > INTERNAL_HEIGHT + l.radius) {
        continue;
      }
      const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, l.radius);
      g.addColorStop(0, `rgba(0,0,0,${Math.min(1, l.intensity).toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, l.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of this.cones) {
      this.cutCone(c, cam);
    }

    scene.drawImage(this.canvas, 0, 0);

    // Additive glows on top of the darkened scene.
    scene.save();
    scene.globalCompositeOperation = 'lighter';
    for (const l of this.points) {
      if (!l.glow) continue;
      const sx = l.x - cam.x;
      const sy = l.y - cam.y;
      const r = l.radius * 0.7;
      if (sx < -r || sy < -r || sx > INTERNAL_WIDTH + r || sy > INTERNAL_HEIGHT + r) continue;
      const g = scene.createRadialGradient(sx, sy, 0, sx, sy, r);
      const a = (l.glowAlpha ?? 0.10) * darkness;
      g.addColorStop(0, colorWithAlpha(l.glow, a));
      g.addColorStop(1, colorWithAlpha(l.glow, 0));
      scene.fillStyle = g;
      scene.beginPath();
      scene.arc(sx, sy, r, 0, Math.PI * 2);
      scene.fill();
    }
    for (const c of this.cones) {
      const sx = c.x - cam.x;
      const sy = c.y - cam.y;
      scene.fillStyle = `rgba(255, 240, 190, ${(0.05 * darkness * c.intensity).toFixed(3)})`;
      scene.beginPath();
      this.conePath(scene, sx, sy, c);
      scene.fill();
    }
    scene.restore();
  }

  private cutCone(c: ConeLight, cam: Vec2): void {
    const ctx = this.ctx;
    const sx = c.x - cam.x;
    const sy = c.y - cam.y;
    if (
      sx < -c.length || sy < -c.length ||
      sx > INTERNAL_WIDTH + c.length || sy > INTERNAL_HEIGHT + c.length
    ) {
      return;
    }
    const ex = sx + Math.cos(c.angle) * c.length;
    const ey = sy + Math.sin(c.angle) * c.length;
    const g = ctx.createLinearGradient(sx, sy, ex, ey);
    g.addColorStop(0, `rgba(0,0,0,${Math.min(1, c.intensity).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    this.conePath(ctx, sx, sy, c);
    ctx.fill();
  }

  private conePath(ctx: CanvasRenderingContext2D, sx: number, sy: number, c: ConeLight): void {
    const px = -Math.sin(c.angle);
    const py = Math.cos(c.angle);
    const ex = sx + Math.cos(c.angle) * c.length;
    const ey = sy + Math.sin(c.angle) * c.length;
    ctx.moveTo(sx + px * 2, sy + py * 2);
    ctx.lineTo(ex + px * c.halfWidth, ey + py * c.halfWidth);
    ctx.lineTo(ex - px * c.halfWidth, ey - py * c.halfWidth);
    ctx.lineTo(sx - px * 2, sy - py * 2);
    ctx.closePath();
  }
}

function colorWithAlpha(hexOrCss: string, alpha: number): string {
  if (hexOrCss.startsWith('#') && hexOrCss.length === 7) {
    const v = Number.parseInt(hexOrCss.slice(1), 16);
    return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha.toFixed(3)})`;
  }
  return hexOrCss;
}
