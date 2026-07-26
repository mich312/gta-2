import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';
import { DAY_TICKS } from './style.js';
import { hash01 } from './visualRng.js';

/**
 * Deterministic weather. Each in-game "day" hashes (seed, day index) into a
 * forecast — clear, drizzle or downpour — and intensity ramps smoothly at
 * the segment edges so rain rolls in rather than switching on. Purely
 * visual: rendered as screen-space streaks plus ground splash rings, and it
 * feeds a darkness bonus into the lighting pass. Every client computes the
 * identical forecast from the shared tick.
 */

const SEGMENTS_PER_DAY = 4;
const RAMP = 0.12; // fraction of a segment spent fading in/out

interface Streak {
  x: number;
  y: number;
  speed: number;
  len: number;
}

interface Splash {
  x: number;
  y: number;
  ageMs: number;
}

export class WeatherSystem {
  private readonly streaks: Streak[] = [];
  private readonly splashes: Splash[] = [];

  constructor(private readonly seed: number) {
    for (let i = 0; i < 90; i++) {
      this.streaks.push({
        x: Math.random() * INTERNAL_WIDTH,
        y: Math.random() * INTERNAL_HEIGHT,
        speed: 260 + Math.random() * 160,
        len: 6 + Math.random() * 6,
      });
    }
  }

  /** Rain intensity in [0,1] for a server tick. */
  intensityAt(tick: number): number {
    const dayF = tick / DAY_TICKS;
    const day = Math.floor(dayF);
    const segF = (dayF - day) * SEGMENTS_PER_DAY;
    const seg = Math.floor(segF);
    const within = segF - seg;
    const target = this.segmentIntensity(day, seg);
    // Ramp against the neighbouring segments so transitions glide.
    const prev = this.segmentIntensity(day, seg - 1);
    const next = this.segmentIntensity(day, seg + 1);
    if (within < RAMP) {
      const t = within / RAMP;
      return prev + (target - prev) * t;
    }
    if (within > 1 - RAMP) {
      const t = (within - (1 - RAMP)) / RAMP;
      return target + (next - target) * t;
    }
    return target;
  }

  private segmentIntensity(day: number, seg: number): number {
    // Normalise segment underflow/overflow into neighbouring days.
    let d = day;
    let s = seg;
    if (s < 0) {
      d -= 1;
      s += SEGMENTS_PER_DAY;
    } else if (s >= SEGMENTS_PER_DAY) {
      d += 1;
      s -= SEGMENTS_PER_DAY;
    }
    const roll = hash01(this.seed ^ 0x5a1, d, s);
    if (roll < 0.62) return 0; // clear
    if (roll < 0.85) return 0.45; // drizzle
    return 1; // downpour
  }

  /** Extra ambient darkness contributed by cloud cover. */
  darknessBonus(intensity: number): number {
    return intensity * 0.16;
  }

  update(dtMs: number, intensity: number): void {
    if (intensity <= 0) {
      this.splashes.length = 0;
      return;
    }
    const dt = dtMs / 1000;
    for (const s of this.streaks) {
      s.y += s.speed * dt;
      s.x -= s.speed * 0.18 * dt; // wind
      if (s.y > INTERNAL_HEIGHT + 8) {
        s.y = -8;
        s.x = Math.random() * (INTERNAL_WIDTH + 40);
      }
    }
    // Ground splashes pop wherever drops land.
    const want = Math.floor(intensity * 5);
    for (let i = 0; i < want; i++) {
      if (this.splashes.length < 40 && Math.random() < 0.6) {
        this.splashes.push({
          x: Math.random() * INTERNAL_WIDTH,
          y: Math.random() * INTERNAL_HEIGHT,
          ageMs: 0,
        });
      }
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const sp = this.splashes[i] as Splash;
      sp.ageMs += dtMs;
      if (sp.ageMs > 260) this.splashes.splice(i, 1);
    }
  }

  /** Screen-space rain overlay; call after lighting, before the HUD. */
  draw(ctx: CanvasRenderingContext2D, intensity: number): void {
    if (intensity <= 0) return;

    // Splash rings first (they read as "on the ground").
    for (const sp of this.splashes) {
      const t = sp.ageMs / 260;
      ctx.strokeStyle = `rgba(190, 210, 230, ${(0.28 * (1 - t) * intensity).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 1 + t * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    const count = Math.floor(this.streaks.length * intensity);
    ctx.strokeStyle = `rgba(180, 200, 225, ${(0.30 * Math.max(0.5, intensity)).toFixed(3)})`;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const s = this.streaks[i] as Streak;
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.len * 0.18, s.y - s.len);
    }
    ctx.stroke();
  }
}
