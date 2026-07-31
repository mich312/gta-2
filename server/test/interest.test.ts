import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import worldgenJson from '../../shared/data/worldgen.json';
import {
  areaScale,
  SnapshotSync,
  hashSnapshot,
  initTuning,
  parseWorldgenParams,
  type InputIntent,
  NULL_INPUT,
} from 'shared';
import { Session } from '../src/session.js';
import { buildStateMessage, filterSnapshot } from '../src/net/broadcast.js';

const worldgen = parseWorldgenParams(worldgenJson);
const RADIUS = 600;

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
  });
});

function intent(seq: number, keys: Partial<InputIntent>): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, ...keys };
}

describe('interest management', () => {
  it('filters far entities but always keeps players and driven cars', () => {
    const session = new Session(99, worldgen, null, { pedCount: 200 });
    session.addPlayer('p', 'tok');
    const snap = session.tick();
    // The crowd is a DENSITY now, not a count: `pedCount` is per nominal
    // 384-tile city and the session scales it by the map's area, so a city
    // four times the size is four times as busy rather than four times as
    // empty. See session.ts PEDS_PER_CITY.
    expect(snap.peds.length).toBe(Math.round(200 * areaScale(session.map)));

    const me = snap.players[0]!;
    const filtered = filterSnapshot(snap, me.pos, RADIUS);
    expect(filtered.players.length).toBe(snap.players.length);
    expect(filtered.peds.length).toBeLessThan(snap.peds.length);
    for (const ped of filtered.peds) {
      expect(Math.hypot(ped.pos.x - me.pos.x, ped.pos.y - me.pos.y)).toBeLessThanOrEqual(RADIUS);
    }
    // Everything excluded really is far away.
    const includedIds = new Set(filtered.peds.map((p) => p.id));
    for (const ped of snap.peds) {
      if (!includedIds.has(ped.id)) {
        expect(Math.hypot(ped.pos.x - me.pos.x, ped.pos.y - me.pos.y)).toBeGreaterThan(RADIUS);
      }
    }
  });

  it('a moving client stays hash-consistent across AOI enter/leave churn', () => {
    const session = new Session(123, worldgen, null, { pedCount: 200 });
    const slot = session.addPlayer('walker', 'tok');
    const sync = new SnapshotSync();

    // Initial full (like the welcome path).
    let snap = session.tick();
    const first = buildStateMessage(slot, snap, RADIUS, true);
    expect(first.type).toBe('full');
    sync.applyServerMessage(first);
    slot.lastAckTick = sync.ackTick;

    // Walk hard in one direction for 20 seconds; peds churn in and out of
    // the radius the whole way. Every hashed delta must reconstruct exactly.
    let hashedChecks = 0;
    for (let t = 0; t < 600; t++) {
      session.queueInput(slot.playerId, sync.ackTick, [
        intent(t + 1, { right: t % 200 < 100, down: t % 200 >= 100 }),
      ]);
      snap = session.tick();
      const msg = buildStateMessage(slot, snap, RADIUS, true);
      const applied = sync.applyServerMessage(msg);
      expect(applied).toBe(true);
      slot.lastAckTick = sync.ackTick;
      if (msg.type === 'snapshot' && msg.hash !== undefined) hashedChecks++;
    }
    expect(sync.desyncs).toBe(0);
    expect(hashedChecks).toBeGreaterThan(500);
    expect(hashSnapshot(sync.latest!)).toBe(
      hashSnapshot(filterSnapshot(session.latestSnapshot,
        session.latestSnapshot.players[0]!.pos, RADIUS)),
    );
  });

  it('an ack gap falls back to a full filtered snapshot', () => {
    const session = new Session(321, worldgen, null, { pedCount: 50 });
    const slot = session.addPlayer('p', 'tok');
    let snap = session.tick();
    slot.lastAckTick = snap.tick;
    buildStateMessage(slot, snap, RADIUS, false);
    for (let t = 0; t < 150; t++) {
      snap = session.tick();
      buildStateMessage(slot, snap, RADIUS, false); // client never acks
    }
    const msg = buildStateMessage(slot, snap, RADIUS, false);
    expect(msg.type).toBe('full');
  });
});
