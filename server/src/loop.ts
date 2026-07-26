import { TICK_MS } from 'shared';

const MAX_CATCH_UP = 5;

/**
 * Drift-corrected fixed-rate driver. Each tick is scheduled against the
 * loop's start time, not the previous callback, so timer jitter never
 * accumulates. If we fall more than MAX_CATCH_UP ticks behind (debugger
 * pause, hitch), we re-anchor instead of fast-forwarding a burst.
 */
export class TickLoop {
  ticks = 0;

  private timer: NodeJS.Timeout | null = null;
  private anchor = 0;
  private anchorTick = 0;

  constructor(
    private readonly onTick: () => void,
    private readonly tickMs: number = TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.anchor = performance.now();
    this.anchorTick = this.ticks;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const target = this.anchor + (this.ticks - this.anchorTick + 1) * this.tickMs;
    const delay = Math.max(0, target - performance.now());
    this.timer = setTimeout(() => this.run(), delay);
  }

  private run(): void {
    let steps = 0;
    while (
      performance.now() >= this.anchor + (this.ticks - this.anchorTick + 1) * this.tickMs
    ) {
      this.ticks++;
      this.onTick();
      steps++;
      if (steps >= MAX_CATCH_UP) {
        // Too far behind: drop the lost time rather than spiral.
        this.anchor = performance.now();
        this.anchorTick = this.ticks;
        break;
      }
    }
    this.schedule();
  }
}
