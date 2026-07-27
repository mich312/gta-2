import { MAX_GANGS } from '../constants.js';
import { getTuning } from '../tuning.js';
import type { GameState, PlayerState } from './state.js';
import type { SimEvent } from './events.js';

/**
 * Respect: where you stand with each gang, and the reason every choice in
 * this city closes a door.
 *
 * This is sim state, not economy state, and that is the whole architectural
 * point of it. Cash can live server-side because nothing in `step()` reads a
 * wallet; respect cannot, because gang AI reads it every tick to decide
 * whether to shoot you. So it is in GameState, in the hash, and on the wire.
 *
 * The web is zero-sum by construction: hurting a gang helps its rivals, and
 * there is no move that pleases everybody. That is the mechanic — not a
 * side effect of it.
 *
 * Three safeguards stop it becoming a one-way trip to an unplayable city,
 * and all three were designed in from the start rather than bolted on:
 *
 *  1. respect decays toward neutral, so a bad hour is not permanent;
 *  2. hostility has a floor, so it cannot compound without limit;
 *  3. hostility is *local* — a gang that hates you is dangerous on their own
 *     ground and merely unfriendly everywhere else.
 */

/** Neutral, and where everybody starts. */
export const RESPECT_NEUTRAL = 0;

export function newRespect(): number[] {
  return new Array<number>(MAX_GANGS).fill(RESPECT_NEUTRAL);
}

export function respectOf(p: PlayerState, gangId: number): number {
  if (gangId <= 0 || gangId > MAX_GANGS) return RESPECT_NEUTRAL;
  return p.respect[gangId - 1] ?? RESPECT_NEUTRAL;
}

function setRespect(p: PlayerState, gangId: number, value: number): void {
  if (gangId <= 0 || gangId > MAX_GANGS) return;
  const t = getTuning().respect;
  p.respect[gangId - 1] = Math.max(t.floor, Math.min(t.ceiling, Math.round(value)));
}

export function addRespect(p: PlayerState, gangId: number, delta: number): void {
  setRespect(p, gangId, respectOf(p, gangId) + delta);
}

/** True when this gang's members will open fire on sight — on their turf. */
export function isHostile(p: PlayerState, gangId: number): boolean {
  return gangId > 0 && respectOf(p, gangId) <= getTuning().respect.hostileAt;
}

/** True when they will take your side against the police. */
export function isFriendly(p: PlayerState, gangId: number): boolean {
  return gangId > 0 && respectOf(p, gangId) >= getTuning().respect.friendlyAt;
}

/**
 * Kill somebody who belonged to a gang. Their people take it badly and their
 * rivals take it well — the zero-sum coupling that makes standing with one
 * gang cost standing with another.
 */
export function creditGangKill(
  state: GameState,
  killerId: number,
  gangId: number,
  events: SimEvent[],
): void {
  if (gangId <= 0) return;
  const killer = state.players.byId[killerId];
  if (!killer) return;
  const t = getTuning().respect;
  const before = respectOf(killer, gangId);
  addRespect(killer, gangId, -t.killPenalty);
  for (const rival of getTuning().gangs.gangs.find((g) => g.id === gangId)?.rivals ?? []) {
    addRespect(killer, rival, t.killPenalty * t.rivalShare);
  }
  const after = respectOf(killer, gangId);
  // Announce only the crossing, not every point: the HUD carries the number,
  // and a message per body would be noise.
  if (before > t.hostileAt && after <= t.hostileAt) {
    events.push({ type: 'gangTurned', tick: state.tick, playerId: killerId, gangId, hostile: true });
  }
}

/** Work for a gang: they warm to you, their rivals cool. */
export function creditGangFavour(p: PlayerState, gangId: number, amount: number): void {
  if (gangId <= 0) return;
  addRespect(p, gangId, amount);
  for (const rival of getTuning().gangs.gangs.find((g) => g.id === gangId)?.rivals ?? []) {
    addRespect(p, rival, -amount * getTuning().respect.rivalShare);
  }
}

/**
 * Drift back toward neutral. Slow — measured in minutes, not seconds — so it
 * is a way out of a hole rather than a reason to ignore the mechanic.
 *
 * Runs at a fixed point in the step order and iterates players and gangs in
 * sorted order, so it is bit-identical everywhere.
 */
export function stepRespectDecay(state: GameState): void {
  const t = getTuning().respect;
  if (t.decayEveryTicks <= 0 || state.tick % t.decayEveryTicks !== 0) return;
  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p) continue;
    for (let g = 1; g <= MAX_GANGS; g++) {
      const value = respectOf(p, g);
      if (value === RESPECT_NEUTRAL) continue;
      setRespect(p, g, value + (value > RESPECT_NEUTRAL ? -1 : 1));
    }
  }
}
