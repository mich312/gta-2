export interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** Beyond this much movement in one tick it is a teleport, not motion. */
const SNAP_DIST = 48;

/**
 * Renders a 30 Hz quantity at display rate.
 *
 * The simulation advances the local player in whole ticks, so drawing its raw
 * position means the avatar and the camera sit still for two, three or four
 * frames and then jump — which is exactly what "the graphics aren't fluid"
 * feels like on a 60–144 Hz display. Keeping the pose from before and after the
 * last tick and sampling between them turns that staircase into continuous
 * motion, without touching the simulation or adding a frame of input lag.
 *
 * Server corrections land through `correct`, which moves the target but leaves
 * the origin alone — so a reconciliation glides in over the rest of the tick
 * instead of snapping.
 */
export class PoseSmoother {
  private prev: Pose = { x: 0, y: 0, angle: 0 };
  private curr: Pose = { x: 0, y: 0, angle: 0 };
  private valid = false;

  /** A tick has been integrated: yesterday's target becomes today's origin. */
  advance(pose: Pose | null): void {
    if (!pose) {
      this.valid = false;
      return;
    }
    if (!this.valid) {
      this.snap(pose);
      return;
    }
    this.prev = this.curr;
    this.curr = { ...pose };
    if (Math.hypot(this.curr.x - this.prev.x, this.curr.y - this.prev.y) > SNAP_DIST) {
      this.prev = { ...pose };
    }
  }

  /** A reconciliation moved the target mid-tick; glide to it. */
  correct(pose: Pose | null): void {
    if (!pose) {
      this.valid = false;
      return;
    }
    if (!this.valid) {
      this.snap(pose);
      return;
    }
    this.curr = { ...pose };
    if (Math.hypot(this.curr.x - this.prev.x, this.curr.y - this.prev.y) > SNAP_DIST) {
      this.prev = { ...pose };
    }
  }

  snap(pose: Pose): void {
    this.prev = { ...pose };
    this.curr = { ...pose };
    this.valid = true;
  }

  /** `alpha` is the fraction of the current tick already elapsed, 0..1. */
  sample(alpha: number): Pose | null {
    if (!this.valid) return null;
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    return {
      x: this.prev.x + (this.curr.x - this.prev.x) * t,
      y: this.prev.y + (this.curr.y - this.prev.y) * t,
      angle: this.prev.angle + shortestTurn(this.prev.angle, this.curr.angle) * t,
    };
  }
}

function shortestTurn(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
