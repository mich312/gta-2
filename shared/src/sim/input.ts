import { wrapAngle } from '../math/trig.js';
import { q256 } from '../math/vec.js';

/**
 * The only thing a client may tell the server about gameplay.
 * Exactly the shape fixed in the brief — intents, never state.
 */
export interface InputIntent {
  /** Monotonic per client; the server echoes the last applied seq back. */
  seq: number;
  /** The client's estimate of the sim tick this input targets. */
  tick: number;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  aimAngle: number;
  action: boolean;
  /**
   * Use whatever is fitted to the car: fire the guns, drop a mine or a slick,
   * arm the bomb. Separate from `fire` because a driver can do both — lean
   * out of the window with a pistol and work the guns at the same time.
   */
  fitting: boolean;
  /**
   * Leaning on the horn. Free on the wire: the input byte had a spare bit.
   */
  horn: boolean;
  /** Requested weapon slot; -1 = keep current. Still an intent, never state. */
  slot: number;
}

export const NULL_INPUT: InputIntent = {
  seq: 0,
  tick: 0,
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
  aimAngle: 0,
  action: false,
  fitting: false,
  horn: false,
  slot: -1,
};

/**
 * Trust boundary: everything off the wire goes through here before it can
 * touch the sim. Returns null for garbage rather than guessing.
 */
export function sanitizeIntent(raw: unknown): InputIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const seq = r['seq'];
  const tick = r['tick'];
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return null;
  if (typeof tick !== 'number' || !Number.isFinite(tick) || tick < 0) return null;
  const rawAim = r['aimAngle'];
  const aimAngle =
    typeof rawAim === 'number' && Number.isFinite(rawAim) ? q256(wrapAngle(rawAim)) : 0;
  return {
    seq: Math.floor(seq),
    tick: Math.floor(tick),
    up: r['up'] === true,
    down: r['down'] === true,
    left: r['left'] === true,
    right: r['right'] === true,
    fire: r['fire'] === true,
    aimAngle,
    action: r['action'] === true,
    fitting: r['fitting'] === true,
    horn: r['horn'] === true,
    slot:
      typeof r['slot'] === 'number' && Number.isInteger(r['slot']) && r['slot'] >= 0 && r['slot'] < 8
        ? r['slot']
        : -1,
  };
}
