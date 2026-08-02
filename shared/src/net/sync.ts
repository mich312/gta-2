import type { FullSnapshot } from './snapshot.js';
import { applyDelta } from './snapshot.js';
import { hashSnapshot } from './hash.js';
import type { ServerMessage } from './messages.js';
import { SNAPSHOT_RING_TICKS } from '../constants.js';

/**
 * How much history to keep, in ticks. The history exists so the server can
 * delta against any tick we have acked — and the server itself only deltas
 * within `SNAPSHOT_RING_TICKS`, so anything older than its ring can never be
 * asked for. This was 120 against a ring of 90: thirty ticks of full world
 * copies kept resident for nobody.
 */
const KEEP_TICKS = SNAPSHOT_RING_TICKS;

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

  /**
   * Whether to verify a server hash when one arrives.
   *
   * `hashSnapshot` walks every field of every entity through a DataView —
   * tens of thousands of calls in one synchronous burst, every
   * `SNAPSHOT_HASH_INTERVAL` ticks. On the render thread that is a
   * metronomic twice-a-second spike, for a number only the debug overlay
   * ever shows, so the browser client gates it on the overlay being open.
   * The bot harness keeps the default and verifies always: bots are the
   * desync canary, and they have no frame budget to protect.
   */
  constructor(private readonly verify: () => boolean = () => true) {}

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
        if (msg.hash !== undefined && this.verify() && hashSnapshot(snap) !== msg.hash) {
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
    // Stored as given, not cloned — and since `applyDelta` went
    // copy-on-write, entities are shared between every snapshot in this
    // history that they did not change across. Everything that reads a
    // snapshot treats it as read-only or clones before writing (the
    // predictor's `setWorld`/`reconcile` clone; renderers only read); that
    // discipline is load-bearing here.
    this.latest = snap;
    this.byTick.set(snap.tick, snap);
    for (const t of this.byTick.keys()) {
      if (t < snap.tick - KEEP_TICKS) this.byTick.delete(t);
    }
  }
}
