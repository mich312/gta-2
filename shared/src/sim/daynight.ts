import { TICK_RATE } from '../constants.js';
import { TWO_PI, dCos } from '../math/trig.js';

/**
 * The clock.
 *
 * The city had one fixed dusk grade with lamps and headlights over it. It
 * looked good, which is why this is about a clock rather than a repaint.
 *
 * Time of day is a **pure function of `state.tick`**, on exactly the same
 * grounds as the traffic signals in `signals.ts`: the tick is already shared,
 * already hashed and already in every snapshot, so two players standing on
 * the same corner see the same sky because they compute the same number. A
 * server-pushed clock would cost a message and could skew; a wall-clock
 * client clock would drift the moment a tab slept.
 */

/** 0 at midnight, 0.5 at midday, wrapping. */
export function timeOfDay(tick: number, dayLengthSec: number): number {
  const ticksPerDay = Math.max(1, Math.round(dayLengthSec * TICK_RATE));
  // Offset by half a day so tick 0 is midday. A fresh server starting at 3am
  // is a miserable first impression, and it made every early screenshot black.
  const at = (tick + ticksPerDay * 0.5) % ticksPerDay;
  return at / ticksPerDay;
}

/**
 * How dark it is, 0 (full day) to 1 (deep night).
 *
 * A smooth curve rather than four discrete phases: dawn and dusk are the
 * interesting parts and a step between keyframes would show as a seam across
 * the whole screen.
 */
export function nightAmount(tod: number): number {
  // 1 at midnight (tod 0), 0 at midday (tod 0.5), smooth through both.
  //
  // `dCos`, not `Math.cos`. ECMA-262 leaves the library trig approximated, so
  // two hosts may disagree in the last bit — and this is not renderer-only:
  // `crowdScale` below feeds `topUpPeds`, which ROUNDS it into a spawn target,
  // so a sub-ulp difference can be one pedestrian more on one host and the
  // whole ambient stream then diverges. `ci/hostParity.mjs` exists to prove it
  // does not. See `math/trig.ts`.
  return 0.5 + 0.5 * dCos(tod * TWO_PI);
}

/**
 * How wet the streets are, 0 (bone dry) to 1 (just stopped raining).
 *
 * A pure function of the tick, for exactly the reason `timeOfDay` is: the
 * weather is a thing two players standing on the same corner have to agree
 * about, and the tick is already in every snapshot. A server-pushed forecast
 * would cost a message and could skew.
 *
 * There is no rainfall — no particles, no sound, nothing in the sim. This is
 * only the state the street is left in afterwards, which is the half of rain
 * that a top-down camera can actually see: the road goes dark, the puddles
 * hold the lamps, and it dries out again over the next few minutes.
 *
 * **Shape.** Two fronts of different lengths, overlaid, so the pattern does
 * not repeat on any interval short enough to notice. Each one soaks the city
 * quickly and dries slowly, because that is the asymmetry water has. The
 * periods are fractions of a day rather than seconds so that a server running
 * a long day gets long weather: the sky and the street stay on one clock.
 *
 * On the stock 24-minute day that works out at a wet street about two fifths
 * of the time, in spells of four to seven minutes. Deliberately generous — a
 * weather state nobody ever sees is not worth the shader — but the majority
 * of the time the city is still dry, so arriving in the rain still registers
 * as something having changed.
 */
export function wetness(tick: number, dayLengthSec: number): number {
  const days = tick / Math.max(1, dayLengthSec * TICK_RATE);
  return Math.min(1, Math.max(front(days, 0.62, 0, 1), front(days, 0.94, 0.63, 0.55)));
}

/** How much of a front's cycle it spends soaking the city. */
const RISE = 0.04;
/** And how much of it drying out again. Rain arrives faster than it leaves. */
const FALL = 0.26;

/** One weather front, peaking once per `period` days. */
function front(days: number, period: number, phase: number, peak: number): number {
  const p = (((days / period + phase) % 1) + 1) % 1;
  if (p < RISE) {
    const x = p / RISE;
    return peak * x * x * (3 - 2 * x);
  }
  if (p < RISE + FALL) {
    // Squared rather than linear: the last of the water goes off a road far
    // more slowly than the first of it, and a linear ramp reads as a fade.
    const x = 1 - (p - RISE) / FALL;
    return peak * x * x;
  }
  return 0;
}

/**
 * Population multiplier for the hour.
 *
 * This is the one part of the clock the SIM reads, and it is deliberately
 * small: a target, consulted where the population is already topped up, and
 * drawing no new random numbers. The streets thin out overnight and fill
 * again, which is most of what "the city has a clock" means in play.
 */
export function crowdScale(tod: number, nightScale: number): number {
  return 1 - nightAmount(tod) * (1 - nightScale);
}
