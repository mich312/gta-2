import type { PlayerState, VehicleState } from '../sim/state.js';
import { clonePlayer, cloneVehicle } from '../sim/state.js';
import type { InputIntent } from '../sim/input.js';
import { stepPlayerMovement } from '../sim/player.js';
import { stepVehicleDriving, type VehicleWorld } from '../sim/vehicle.js';
import type { CityMap } from '../world/types.js';

const MAX_PENDING = 120;

/**
 * Client-side prediction for the local player (on foot or driving), with
 * reconciliation. Inputs apply to the predicted state immediately (zero
 * input lag) and are kept pending; on each snapshot we rewind to the
 * authoritative player/vehicle and replay everything newer than ackSeq.
 *
 * Collision against other vehicles IS predicted, from the newest snapshot.
 * It used to be excluded on the theory that dynamic entities are the
 * server's business, and the cost of that was the one thing you could feel:
 * you drove through a parked car for a whole round trip and were then yanked
 * back to where you actually stopped. Most of what you hit is stationary, so
 * the snapshot's position for it is exact and the prediction is right.
 *
 * What stays server-granted: entering and exiting vehicles, damage, wrecks,
 * and the shove given to the car you hit. Guessing at those would be
 * predicting somebody else's health.
 */
export class Predictor {
  predicted: PlayerState | null = null;
  predictedVehicle: VehicleState | null = null;
  /** Magnitude of the last reconciliation correction, px. ~0 when healthy. */
  lastCorrection = 0;
  maxCorrection = 0;

  private pending: InputIntent[] = [];
  /** Newest authoritative view of other vehicles, for collision prediction. */
  private world: VehicleWorld | null = null;

  /**
   * Hand the predictor the newest snapshot's vehicles.
   *
   * CLONED, not borrowed: predicting a collision shoves the car you hit, and
   * the caller's array is the live snapshot that the renderer and the
   * interpolator are reading. Rebuilt once per snapshot, not once per
   * replayed input, so the cost is a few dozen small objects at 30 Hz.
   */
  setWorld(vehicles: readonly VehicleState[]): void {
    const ids: number[] = [];
    const byId: Record<number, VehicleState> = {};
    for (const v of vehicles) {
      ids.push(v.id);
      byId[v.id] = cloneVehicle(v);
    }
    ids.sort((a, b) => a - b);
    this.world = { vehicles: { ids, byId } };
  }

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
      // Sees the world, may not change it: the second argument stays null,
      // so damage and the other car's shove remain the server's to decide.
      stepVehicleDriving(v, intent, map, this.world, null);
      p.pos.x = v.pos.x;
      p.pos.y = v.pos.y;
      p.lastInputSeq = intent.seq;
      p.aimAngle = intent.aimAngle;
    } else {
      // On foot against the same delayed view. Predicting this is what stops
      // a walk up to a parked car ending in a correction: the server now
      // resolves it against exactly this world (`rewoundWorld`), so the two
      // agree instead of merely being close.
      stepPlayerMovement(p, intent, map, 0, this.world);
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
