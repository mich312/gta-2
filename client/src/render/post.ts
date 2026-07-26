import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';

/**
 * Screen-space post effects: a baked vignette, red damage flashes keyed off
 * local health drops, and a slow heartbeat pulse when nearly dead. Cheap on
 * purpose — one cached gradient canvas and a couple of fills.
 */
export class PostFx {
  private readonly vignette: HTMLCanvasElement;
  private lastHealth = 100;
  private flashUntil = 0;
  private tGlobal = 0;

  constructor() {
    this.vignette = document.createElement('canvas');
    this.vignette.width = INTERNAL_WIDTH;
    this.vignette.height = INTERNAL_HEIGHT;
    const ctx = this.vignette.getContext('2d');
    if (!ctx) throw new Error('no 2d context for vignette');
    const g = ctx.createRadialGradient(
      INTERNAL_WIDTH / 2,
      INTERNAL_HEIGHT / 2,
      INTERNAL_HEIGHT * 0.55,
      INTERNAL_WIDTH / 2,
      INTERNAL_HEIGHT / 2,
      INTERNAL_WIDTH * 0.72,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(4,6,10,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
  }

  /** Track the local player's health to trigger hit feedback. */
  observeHealth(health: number | null, now: number): void {
    if (health === null) {
      this.lastHealth = 100;
      return;
    }
    if (health < this.lastHealth - 0.01) {
      this.flashUntil = now + 260;
    }
    this.lastHealth = health;
  }

  draw(ctx: CanvasRenderingContext2D, now: number, dtMs: number, health: number | null): void {
    this.tGlobal += dtMs / 1000;
    ctx.drawImage(this.vignette, 0, 0);

    if (now < this.flashUntil) {
      const t = (this.flashUntil - now) / 260;
      ctx.fillStyle = `rgba(160, 20, 20, ${(0.22 * t).toFixed(3)})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    }

    if (health !== null && health > 0 && health <= 30) {
      const pulse = 0.5 + 0.5 * Math.sin(this.tGlobal * 4.6);
      const strength = (1 - health / 30) * 0.16 * pulse;
      ctx.fillStyle = `rgba(120, 10, 10, ${strength.toFixed(3)})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    }
  }
}
