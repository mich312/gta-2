import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import worldgenJson from '../../shared/data/worldgen.json';
import {
  type InputIntent,
  NULL_INPUT,
  SnapshotSync,
  getTuning,
  hashSnapshot,
  hashState,
  initTuning,
  parseWorldgenParams,
} from 'shared';
import { Session } from '../src/session.js';
import { MemorySink, ReplayRecorder } from '../src/replay/record.js';
import { runReplay } from '../src/replay/run.js';
import { buildStateMessage } from '../src/net/broadcast.js';

const worldgen = parseWorldgenParams(worldgenJson);

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

function intent(seq: number, tick: number, pid: number): InputIntent {
  const phase = (Math.floor(tick / 15) + pid) % 4;
  return {
    ...NULL_INPUT,
    seq,
    tick,
    up: phase === 0,
    right: phase === 1,
    down: phase === 2,
    left: phase === 3,
  };
}

describe('session', () => {
  it('records a replay that reproduces the exact final state, twice', () => {
    const sink = new MemorySink();
    const recorder = new ReplayRecorder(sink, {
      version: 1,
      seed: 1234,
      tickRate: 30,
      startedAt: 'test',
      tuning: getTuning(),
      worldgen,
    });
    const session = new Session(1234, worldgen, recorder);
    const a = session.addPlayer('a', 'tok-a');
    const b = session.addPlayer('b', 'tok-b');
    for (let t = 1; t <= 200; t++) {
      session.queueInput(a.playerId, t - 1, [intent(t, t, a.playerId)]);
      session.queueInput(b.playerId, t - 1, [intent(t, t, b.playerId)]);
      session.tick();
    }
    const live = hashState(session.state);
    const r1 = runReplay(sink.lines);
    const r2 = runReplay(sink.lines);
    expect(r1.finalTick).toBe(session.state.tick);
    expect(r1.finalHash).toBe(live);
    expect(r2.finalHash).toBe(live);
  });

  it('delta snapshots against the acked tick rebuild the server state', () => {
    const session = new Session(55, worldgen);
    const slot = session.addPlayer('p', 'tok');
    const sync = new SnapshotSync();

    // First message bootstraps as a full (filtered) snapshot.
    let snap = session.tick();
    const first = buildStateMessage(slot, snap, 600, true);
    expect(first.type).toBe('full');
    sync.applyServerMessage(first);
    slot.lastAckTick = sync.ackTick;

    for (let t = 0; t < 50; t++) {
      session.queueInput(slot.playerId, sync.ackTick, [intent(t + 1, t, slot.playerId)]);
      snap = session.tick();
      const msg = buildStateMessage(slot, snap, 600, true);
      expect(msg.type).toBe('snapshot');
      expect(sync.applyServerMessage(msg)).toBe(true);
      // ack like a real client would on its next input message
      slot.lastAckTick = sync.ackTick;
    }
    // Hash verification happened inside applyServerMessage on every tick.
    expect(sync.desyncs).toBe(0);
    expect(hashSnapshot(sync.latest!)).toBeGreaterThanOrEqual(0);
  });

  it('falls back to a full snapshot when the ack is too stale', () => {
    const session = new Session(66, worldgen);
    const slot = session.addPlayer('p', 'tok');
    let snap = session.tick();
    slot.lastAckTick = snap.tick;
    for (let t = 0; t < 150; t++) snap = session.tick(); // ack ages out of the ring
    const msg = buildStateMessage(slot, snap, 600, false);
    expect(msg.type).toBe('full');
  });

  it('resume rebinds by token; expiry despawns', () => {
    const session = new Session(77, worldgen);
    const slot = session.addPlayer('p', 'tok-resume');
    session.tick();
    expect(session.state.players.ids).toEqual([slot.playerId]);

    session.markDisconnected(slot.playerId, 1000);
    expect(session.resumeByToken('wrong')).toBeNull();
    const resumed = session.resumeByToken('tok-resume');
    expect(resumed?.playerId).toBe(slot.playerId);

    session.markDisconnected(slot.playerId, 1000);
    session.expireDisconnected(1000 + 120_000, 120_000);
    session.tick();
    expect(session.state.players.ids).toEqual([]);
  });

  it('drops duplicate and replayed input seqs', () => {
    const session = new Session(88, worldgen);
    const slot = session.addPlayer('p', 'tok');
    const i1 = intent(5, 1, slot.playerId);
    session.queueInput(slot.playerId, 0, [i1]);
    session.queueInput(slot.playerId, 0, [i1]); // exact replay
    session.queueInput(slot.playerId, 0, [intent(3, 1, slot.playerId)]); // stale seq
    expect(slot.queue.length).toBe(1);
  });
});
