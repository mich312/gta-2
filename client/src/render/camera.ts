import {
  type CityMap,
  type PlayerState,
  type Vec2,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  clamp,
} from 'shared';
import {
  CAMERA_LOOKAHEAD_MAX,
  CAMERA_LOOKAHEAD_S,
  CAMERA_SHAKE_MAX,
  CAMERA_SMOOTH_HALF_LIFE_MS,
  prefersReducedMotion,
} from './style.js';

/**
 * Smooth-follow camera with velocity look-ahead and trauma-based shake.
 *
 * - Follow: exponential approach with a fixed half-life, framerate
 *   independent (the classic `1 - 0.5^(dt/halfLife)` form).
 * - Look-ahead: leads the local player's velocity so driving reads ahead of
 *   the car instead of centred on it.
 * - Shake: impacts add "trauma"; displacement is trauma², sampled from
 *   smooth sine noise so it never teleports. Honours prefers-reduced-motion.
 *
 * `pos` is the snapped top-left used by every render pass; keeping the
 * float centre separate means smoothing never fights pixel snapping.
 */
export class SmoothCamera {
  /** Snapped top-left in world px — the value all draw passes consume. */
  readonly pos: Vec2 = { x: 0, y: 0 };

  private cx = 0;
  private cy = 0;
  private lookX = 0;
  private lookY = 0;
  private trauma = 0;
  private shakeT = 0;
  private snapped = false;
  private readonly allowShake = !prefersReducedMotion();

  /** Add shake energy in [0, 1]; decays on its own. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Hard-centre on the target (spawn, respawn, first snapshot). */
  snapTo(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
    this.lookX = 0;
    this.lookY = 0;
    this.snapped = true;
  }

  update(map: CityMap | null, local: PlayerState | null, dtMs: number): void {
    const w = map?.widthPx ?? INTERNAL_WIDTH;
    const h = map?.heightPx ?? INTERNAL_HEIGHT;
    const tx = local ? local.pos.x : w / 2;
    const ty = local ? local.pos.y : h / 2;

    if (!this.snapped) this.snapTo(tx, ty);

    // Velocity look-ahead, itself smoothed so lane changes don't whip.
    let wantLX = 0;
    let wantLY = 0;
    if (local) {
      wantLX = clamp(local.vel.x * CAMERA_LOOKAHEAD_S, -CAMERA_LOOKAHEAD_MAX, CAMERA_LOOKAHEAD_MAX);
      wantLY = clamp(local.vel.y * CAMERA_LOOKAHEAD_S, -CAMERA_LOOKAHEAD_MAX, CAMERA_LOOKAHEAD_MAX);
    }
    const followK = 1 - Math.pow(0.5, dtMs / CAMERA_SMOOTH_HALF_LIFE_MS);
    const lookK = 1 - Math.pow(0.5, dtMs / (CAMERA_SMOOTH_HALF_LIFE_MS * 4));
    this.lookX += (wantLX - this.lookX) * lookK;
    this.lookY += (wantLY - this.lookY) * lookK;

    this.cx += (tx + this.lookX - this.cx) * followK;
    this.cy += (ty + this.lookY - this.cy) * followK;

    // A dead player's camera drifts gently — no look-ahead jerk on respawn
    // because respawn calls snapTo() from main.
    this.trauma = Math.max(0, this.trauma - dtMs / 700);
    this.shakeT += dtMs / 1000;
    let sx = 0;
    let sy = 0;
    if (this.allowShake && this.trauma > 0) {
      const amp = this.trauma * this.trauma * CAMERA_SHAKE_MAX;
      // Two incommensurate sines ≈ cheap smooth noise.
      sx = amp * Math.sin(this.shakeT * 91.7) * Math.sin(this.shakeT * 47.3 + 1.7);
      sy = amp * Math.sin(this.shakeT * 83.1 + 0.9) * Math.sin(this.shakeT * 59.9);
    }

    this.pos.x = Math.floor(
      clamp(this.cx + sx - INTERNAL_WIDTH / 2, 0, Math.max(0, w - INTERNAL_WIDTH)),
    );
    this.pos.y = Math.floor(
      clamp(this.cy + sy - INTERNAL_HEIGHT / 2, 0, Math.max(0, h - INTERNAL_HEIGHT)),
    );
  }
}
