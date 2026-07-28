import type { BodyBox, FullSnapshot, Vec2 } from 'shared';
import { PLAYER_RADIUS, vehicleBoxAt } from 'shared';
import type { NetStats } from './stats.js';

export interface OverlayFrame {
  stats: NetStats;
  snapshot: FullSnapshot | null;
  cam: Vec2;
  localPlayerId: number;
  /**
   * Predicted vs authoritative local-player positions. Identical until
   * prediction lands in phase 1; the ghost between them is THE desync
   * diagnostic from then on.
   */
  predictedPos: Vec2 | null;
  authoritativePos: Vec2 | null;
  desyncs: number;
  fullResyncs: number;
  /**
   * Vehicle bodies where THIS FRAME draws them, which is also where the
   * predictor collides against them. Drawn from the interpolated world rather
   * than the snapshot on purpose: the snapshot is three ticks further down
   * the road, and a collider box drawn there would sit next to its own car
   * and look like the bug it is not.
   */
  vehicleBodies: Array<{ x: number; y: number; heading: number; kind: string }>;
}

/** Trace an oriented box, corner to corner. */
function strokeBox(ctx: CanvasRenderingContext2D, b: BodyBox): void {
  const fx = b.cos * b.halfLength;
  const fy = b.sin * b.halfLength;
  const rx = -b.sin * b.halfWidth;
  const ry = b.cos * b.halfWidth;
  ctx.beginPath();
  ctx.moveTo(b.x + fx + rx, b.y + fy + ry);
  ctx.lineTo(b.x + fx - rx, b.y + fy - ry);
  ctx.lineTo(b.x - fx - rx, b.y - fy - ry);
  ctx.lineTo(b.x - fx + rx, b.y - fy + ry);
  ctx.closePath();
  ctx.stroke();
}

/** Debug overlay, toggled with `~`. */
export class DebugOverlay {
  visible = false;
  showHitboxes = true;

  toggle(): void {
    this.visible = !this.visible;
  }

  draw(ctx: CanvasRenderingContext2D, f: OverlayFrame): void {
    if (!this.visible) return;

    if (this.showHitboxes && f.snapshot) {
      ctx.strokeStyle = '#00ff88';
      for (const p of f.snapshot.players) {
        ctx.strokeRect(
          Math.floor(p.pos.x - f.cam.x) - PLAYER_RADIUS + 0.5,
          Math.floor(p.pos.y - f.cam.y) - PLAYER_RADIUS + 0.5,
          PLAYER_RADIUS * 2 - 1,
          PLAYER_RADIUS * 2 - 1,
        );
      }
      // The real thing a car collides with, and the whole reason this
      // overlay is worth having: an oriented box you can hold up against the
      // sprite. Everything that asks how big a car is — the contact, the
      // run-over, the traffic AI's obstacle model — asks `vehicleBoxAt`, so
      // this IS the collider and not a drawing of one.
      ctx.strokeStyle = '#ffaa00';
      for (const v of f.vehicleBodies) {
        strokeBox(ctx, vehicleBoxAt(v.kind, v.x - f.cam.x, v.y - f.cam.y, v.heading));
      }
    }

    // Ghost: authoritative (outline) vs predicted (cross).
    if (f.authoritativePos) {
      ctx.strokeStyle = '#ff4444';
      ctx.strokeRect(
        Math.floor(f.authoritativePos.x - f.cam.x) - PLAYER_RADIUS - 1.5,
        Math.floor(f.authoritativePos.y - f.cam.y) - PLAYER_RADIUS - 1.5,
        PLAYER_RADIUS * 2 + 3,
        PLAYER_RADIUS * 2 + 3,
      );
    }
    if (f.predictedPos) {
      const x = Math.floor(f.predictedPos.x - f.cam.x);
      const y = Math.floor(f.predictedPos.y - f.cam.y);
      ctx.strokeStyle = '#ffff00';
      ctx.beginPath();
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + 3);
      ctx.stroke();
    }

    const drift =
      f.predictedPos && f.authoritativePos
        ? Math.hypot(
            f.predictedPos.x - f.authoritativePos.x,
            f.predictedPos.y - f.authoritativePos.y,
          )
        : 0;

    const lines = [
      `fps ${f.stats.fps.toFixed(0)}  frame ${f.stats.frameMs.toFixed(1)}ms`,
      `peak frame ${f.stats.frameMsPeak.toFixed(1)}ms`,
      `tick ${f.snapshot?.tick ?? '-'} @ ${f.stats.snapshotRate.toFixed(1)}/s`,
      `rtt ${f.stats.rttMs.toFixed(0)}ms`,
      `entities ${f.snapshot?.players.length ?? 0}`,
      `net ↓${f.stats.kbpsIn.toFixed(1)} ↑${f.stats.kbpsOut.toFixed(1)} KB/s`,
      `ghost drift ${drift.toFixed(2)}px`,
      `desyncs ${f.desyncs}  resyncs ${f.fullResyncs}`,
    ];
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(2, 2, 150, lines.length * 10 + 6);
    ctx.fillStyle = '#c8f5c8';
    ctx.font = '8px monospace';
    lines.forEach((l, i) => ctx.fillText(l, 6, 12 + i * 10));
  }
}
