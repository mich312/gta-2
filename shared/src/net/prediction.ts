import type { PlayerState } from '../sim/state.js';
import { clonePlayer } from '../sim/state.js';
import type { InputIntent } from '../sim/input.js';
import { stepPlayerMovement } from '../sim/player.js';
import type { CityMap } from '../world/types.js';

const MAX_PENDING = 120;

/**
 * Client-side prediction for the local player, with reconciliation.
 *
 * Every sampled input is applied to the predicted state immediately (zero
 * input lag) and kept in a pending buffer. When a snapshot arrives carrying
 * ackSeq, we rewind to the authoritative player state and replay every
 * pending input newer than ackSeq. Because stepPlayerMovement is the same
 * code the server ran (including tile collision), the replayed result
 * matches what the server WILL compute for those inputs — any persistent
 * correction is a real bug.
 *
 * Predicts against the static world only; dynamic entities never block the
 * prediction (the server resolves those, corrections get smoothed).
 */
export class Predictor {
  predicted: PlayerState | null = null;
  /** Magnitude of the last reconciliation correction, px. ~0 when healthy. */
  lastCorrection = 0;
  maxCorrection = 0;

  private pending: InputIntent[] = [];

  /** Call once per local tick with the input just sent to the server. */
  applyLocalInput(intent: InputIntent, map: CityMap): void {
    this.pending.push(intent);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.predicted) {
      stepPlayerMovement(this.predicted, intent, map);
    }
  }

  /**
   * Rewind to the authoritative state and replay unacked inputs.
   * ackSeq = last input seq the server has folded into this snapshot.
   */
  reconcile(authoritative: PlayerState, ackSeq: number, map: CityMap): void {
    this.pending = this.pending.filter((i) => i.seq > ackSeq);
    const before = this.predicted;
    const next = clonePlayer(authoritative);
    for (const intent of this.pending) {
      stepPlayerMovement(next, intent, map);
    }
    if (before) {
      const dx = next.pos.x - before.pos.x;
      const dy = next.pos.y - before.pos.y;
      this.lastCorrection = Math.sqrt(dx * dx + dy * dy);
      if (this.lastCorrection > this.maxCorrection) {
        this.maxCorrection = this.lastCorrection;
      }
    }
    this.predicted = next;
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
