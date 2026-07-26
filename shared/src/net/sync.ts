import type { FullSnapshot } from './snapshot.js';
import { applyDelta } from './snapshot.js';
import { hashSnapshot } from './hash.js';
import type { ServerMessage } from './messages.js';

const KEEP_TICKS = 120;

/**
 * Client-side snapshot reassembly, shared by the browser client and the bot
 * harness. Applies welcome/full/delta messages, keeps a short history so the
 * server can delta against any tick we've acked, and verifies server hashes.
 * Not sim code — determinism rules don't apply here.
 */
export class SnapshotSync {
  latest: FullSnapshot | null = null;
  desyncs = 0;
  fullResyncs = 0;
  staleDeltas = 0;

  private byTick = new Map<number, FullSnapshot>();

  /** The tick to ack in outgoing input messages. */
  get ackTick(): number {
    return this.latest ? this.latest.tick : -1;
  }

  get entityCount(): number {
    return this.latest ? this.latest.players.length : 0;
  }

  /** Returns true if the message advanced our state. */
  applyServerMessage(msg: ServerMessage): boolean {
    switch (msg.type) {
      case 'welcome':
        this.store(msg.snapshot);
        return true;
      case 'full':
        this.fullResyncs++;
        this.store(msg.snapshot);
        return true;
      case 'snapshot': {
        if (this.latest && msg.tick <= this.latest.tick) return false;
        const base =
          msg.baseTick === this.latest?.tick ? this.latest : this.byTick.get(msg.baseTick);
        if (!base) {
          // Can't apply; keep the stale ack — the server will fall back to a
          // full snapshot once our ack leaves its ring.
          this.staleDeltas++;
          return false;
        }
        const snap = applyDelta(base, msg.delta, msg.tick);
        if (msg.hash !== undefined && hashSnapshot(snap) !== msg.hash) {
          this.desyncs++;
        }
        this.store(snap);
        return true;
      }
      default:
        return false;
    }
  }

  private store(snap: FullSnapshot): void {
    this.latest = snap;
    this.byTick.set(snap.tick, snap);
    for (const t of this.byTick.keys()) {
      if (t < snap.tick - KEEP_TICKS) this.byTick.delete(t);
    }
  }
}
