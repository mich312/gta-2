import { type FullSnapshot, type ServerMessage, diffSnapshots, hashSnapshot } from 'shared';
import type { PlayerSlot, Session } from '../session.js';

/**
 * Build the per-client state message for this tick: a delta against the last
 * tick that client acked, or a full snapshot when the ack has fallen out of
 * the ring (slow client, long GC pause, fresh join).
 */
export function buildStateMessage(
  session: Session,
  slot: PlayerSlot,
  snap: FullSnapshot,
  withHash: boolean,
): ServerMessage {
  const base = slot.lastAckTick >= 0 ? session.getSnapshotAt(slot.lastAckTick) : null;
  if (!base || base.tick >= snap.tick) {
    return { type: 'full', tick: snap.tick, snapshot: snap };
  }
  const msg: Extract<ServerMessage, { type: 'snapshot' }> = {
    type: 'snapshot',
    tick: snap.tick,
    baseTick: base.tick,
    ackSeq: slot.lastInputSeq,
    delta: diffSnapshots(base, snap),
  };
  if (withHash) msg.hash = hashSnapshot(snap);
  return msg;
}
