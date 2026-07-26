import type { PlayerState, VehicleState } from '../sim/state.js';
import { clonePlayer, cloneVehicle } from '../sim/state.js';
import type { InputIntent } from '../sim/input.js';
import { stepPlayerMovement } from '../sim/player.js';
import { stepVehicleDriving } from '../sim/vehicle.js';
import type { CityMap } from '../world/types.js';

const MAX_PENDING = 120;

/**
 * Client-side prediction for the local player (on foot or driving), with
 * reconciliation. Inputs apply to the predicted state immediately (zero
 * input lag) and are kept pending; on each snapshot we rewind to the
 * authoritative player/vehicle and replay everything newer than ackSeq.
 *
 * Deliberately NOT predicted (server-granted, per plan): entering/exiting
 * vehicles, and collision against other dynamic entities. Those resolve on
 * the server and arrive as corrections, which stay small because everything
 * else is bit-exact shared code.
 */
export class Predictor {
  predicted: PlayerState | null = null;
  predictedVehicle: VehicleState | null = null;
  /** Magnitude of the last reconciliation correction, px. ~0 when healthy. */
  lastCorrection = 0;
  maxCorrection = 0;

  private pending: InputIntent[] = [];

  /** Call once per local tick with the input just sent to the server. */
  applyLocalInput(intent: InputIntent, map: CityMap): void {
    this.pending.push(intent);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.predicted) {
      this.advance(this.predicted, this.predictedVehicle, intent, map);
    }
  }

  /**
   * Rewind to the authoritative state and replay unacked inputs.
   * authoritativeVehicle: the vehicle the player is driving per the same
   * snapshot (null when on foot).
   */
  reconcile(
    authoritative: PlayerState,
    authoritativeVehicle: VehicleState | null,
    ackSeq: number,
    map: CityMap,
  ): void {
    this.pending = this.pending.filter((i) => i.seq > ackSeq);
    const before = this.predicted;
    const nextPlayer = clonePlayer(authoritative);
    const nextVehicle = authoritativeVehicle ? cloneVehicle(authoritativeVehicle) : null;
    for (const intent of this.pending) {
      this.advance(nextPlayer, nextVehicle, intent, map);
    }
    // Corrections are only meaningful within a mode: death->respawn is a
    // legitimate teleport, and enter/exit are server-granted transitions the
    // client deliberately does not predict.
    if (before && before.mode === nextPlayer.mode) {
      const dx = nextPlayer.pos.x - before.pos.x;
      const dy = nextPlayer.pos.y - before.pos.y;
      this.lastCorrection = Math.sqrt(dx * dx + dy * dy);
      if (this.lastCorrection > this.maxCorrection) {
        this.maxCorrection = this.lastCorrection;
      }
    } else {
      this.lastCorrection = 0;
    }
    this.predicted = nextPlayer;
    this.predictedVehicle = nextVehicle;
  }

  private advance(
    p: PlayerState,
    v: VehicleState | null,
    intent: InputIntent,
    map: CityMap,
  ): void {
    if (p.mode === 'driving' && v) {
      // Prediction ignores other dynamic entities: state=null.
      stepVehicleDriving(v, intent, map, null);
      p.pos.x = v.pos.x;
      p.pos.y = v.pos.y;
      p.lastInputSeq = intent.seq;
      p.aimAngle = intent.aimAngle;
    } else {
      stepPlayerMovement(p, intent, map);
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
