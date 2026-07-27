import type { FullSnapshot, Vec2 } from 'shared';
import { PLAYER_RADIUS } from 'shared';
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
