import {
  type FullSnapshot,
  type ServerMessage,
  type Vec2,
  SNAPSHOT_RING_TICKS,
  diffSnapshots,
  hashSnapshot,
} from 'shared';
import type { PlayerSlot } from '../session.js';

/**
 * Interest management: each client receives only entities near their
 * player. Players are always included (there are at most 8 and the kill
 * feed needs them); driven vehicles ride along with their drivers; parked
 * cars, cops, and above all pedestrians are filtered by radius — peds would
 * otherwise dominate bandwidth.
 *
 * Deltas are computed against the FILTERED snapshot this client acked, kept
 * in a per-client ring. Entities entering/leaving the radius fall out as
 * ordinary added/removed rows, so the client needs no special handling.
 */
export function filterSnapshot(
  snap: FullSnapshot,
  center: Vec2 | null,
  radius: number,
): FullSnapshot {
  if (!center) {
    return {
      tick: snap.tick,
      players: snap.players,
      vehicles: snap.vehicles.filter((v) => v.driverId !== null),
      cops: [],
      peds: [],
    };
  }
  const r2 = radius * radius;
  const near = (x: number, y: number): boolean => {
    const dx = x - center.x;
    const dy = y - center.y;
    return dx * dx + dy * dy <= r2;
  };
  return {
    tick: snap.tick,
    players: snap.players,
    vehicles: snap.vehicles.filter((v) => v.driverId !== null || near(v.pos.x, v.pos.y)),
    cops: snap.cops.filter((c) => near(c.pos.x, c.pos.y)),
    peds: snap.peds.filter((p) => near(p.pos.x, p.pos.y)),
  };
}

/** Build the per-client state message and remember what we sent. */
export function buildStateMessage(
  slot: PlayerSlot,
  snap: FullSnapshot,
  interestRadius: number,
  withHash: boolean,
): ServerMessage {
  const me = snap.players.find((p) => p.id === slot.playerId);
  const filtered = filterSnapshot(snap, me ? me.pos : null, interestRadius);

  slot.sentRing.set(filtered.tick, filtered);
  for (const t of slot.sentRing.keys()) {
    if (t < filtered.tick - SNAPSHOT_RING_TICKS) slot.sentRing.delete(t);
  }

  const base = slot.lastAckTick >= 0 ? slot.sentRing.get(slot.lastAckTick) : undefined;
  if (!base || base.tick >= filtered.tick) {
    return { type: 'full', tick: filtered.tick, snapshot: filtered };
  }
  const msg: Extract<ServerMessage, { type: 'snapshot' }> = {
    type: 'snapshot',
    tick: filtered.tick,
    baseTick: base.tick,
    ackSeq: slot.lastInputSeq,
    delta: diffSnapshots(base, filtered),
  };
  if (withHash) msg.hash = hashSnapshot(filtered);
  return msg;
}
