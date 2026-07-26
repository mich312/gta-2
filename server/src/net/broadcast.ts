import {
  type FullSnapshot,
  type ServerMessage,
  type Vec2,
  SNAPSHOT_RING_TICKS,
  diffSnapshots,
  hashSnapshot,
} from 'shared';
import type { PlayerSlot } from '../session.js';

/** Pedestrians are pure ambience, invisible past ~300 px — tighter radius. */
export const PED_RADIUS_FRAC = 0.75;

/**
 * Interest management: each client receives only entities near their
 * player. Players are always included (there are at most 8 and the kill
 * feed needs them); driven vehicles ride along with their drivers; parked
 * cars and cops are filtered by radius; pedestrians by a tighter one (they
 * would otherwise dominate bandwidth and are invisible well before 600 px).
 * Props are NOT filtered: they are static, so sending them all once costs a
 * single burst while radius-filtering them would churn full add rows every
 * time a driving client's AOI sweeps a new street — the dearer of the two.
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
      props: snap.props,
    };
  }
  const near = (x: number, y: number, r: number): boolean => {
    const dx = x - center.x;
    const dy = y - center.y;
    return dx * dx + dy * dy <= r * r;
  };
  const pedRadius = radius * PED_RADIUS_FRAC;
  return {
    tick: snap.tick,
    players: snap.players,
    vehicles: snap.vehicles.filter((v) => v.driverId !== null || near(v.pos.x, v.pos.y, radius)),
    cops: snap.cops.filter((c) => near(c.pos.x, c.pos.y, radius)),
    peds: snap.peds.filter((p) => near(p.pos.x, p.pos.y, pedRadius)),
    props: snap.props,
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
