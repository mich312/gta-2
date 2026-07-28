import { TICK_RATE } from '../constants.js';

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
  return 0.5 + 0.5 * Math.cos(tod * 2 * Math.PI);
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
