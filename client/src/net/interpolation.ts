import type { FullSnapshot, PlayerState } from 'shared';
import { TICK_MS, TICK_RATE } from 'shared';

/** ~100 ms interpolation delay, in ticks (3 ticks @ 30 Hz). */
export const INTERP_DELAY_TICKS = 3;
const BUFFER_TICKS = TICK_RATE * 2;

export interface RenderEntity {
  player: PlayerState;
  x: number;
  y: number;
  aimAngle: number;
}

/**
 * Remote entities render on a delayed, interpolated timeline: we hold a
 * short history of snapshots and sample ~100 ms in the past, lerping between
 * the two bracketing ticks. Never snap, never extrapolate.
 */
export class Interpolator {
  private snapshots: FullSnapshot[] = [];
  private renderTick = 0; // fractional server tick we're rendering
  private synced = false;

  push(snap: FullSnapshot): void {
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snap.tick <= last.tick) return;
    this.snapshots.push(snap);
    while (this.snapshots.length > BUFFER_TICKS) this.snapshots.shift();

    const target = snap.tick - INTERP_DELAY_TICKS;
    if (!this.synced) {
      this.renderTick = target;
      this.synced = true;
    } else {
      // Gently servo toward the ideal delay so clock drift never snaps.
      this.renderTick += (target - this.renderTick) * 0.05;
    }
  }

  /** Advance the render clock by a real-time frame delta. */
  advance(frameMs: number): void {
    if (!this.synced) return;
    this.renderTick += frameMs / TICK_MS;
    const latest = this.snapshots[this.snapshots.length - 1];
    if (latest) {
      // Never render ahead of what we actually have.
      this.renderTick = Math.min(this.renderTick, latest.tick);
      this.renderTick = Math.max(this.renderTick, latest.tick - BUFFER_TICKS);
    }
  }

  /** Interpolated remote entities at the current render time. */
  sample(excludePlayerId: number): RenderEntity[] {
    if (this.snapshots.length === 0) return [];
    let a = this.snapshots[0] as FullSnapshot;
    let b = a;
    for (const s of this.snapshots) {
      if (s.tick <= this.renderTick) a = s;
      if (s.tick >= this.renderTick) {
        b = s;
        break;
      }
      b = s;
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (this.renderTick - a.tick) / span)) : 1;

    const out: RenderEntity[] = [];
    const aById = new Map(a.players.map((p) => [p.id, p]));
    for (const pb of b.players) {
      if (pb.id === excludePlayerId) continue;
      const pa = aById.get(pb.id);
      if (!pa) {
        out.push({ player: pb, x: pb.pos.x, y: pb.pos.y, aimAngle: pb.aimAngle });
        continue;
      }
      out.push({
        player: pb,
        x: pa.pos.x + (pb.pos.x - pa.pos.x) * t,
        y: pa.pos.y + (pb.pos.y - pa.pos.y) * t,
        aimAngle: lerpAngle(pa.aimAngle, pb.aimAngle, t),
      });
    }
    return out;
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
