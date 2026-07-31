import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import worldgenJson from '../../shared/data/worldgen.json';
import {
  areaScale,
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
  it('spreads its parked cars across the city, not into one corner', () => {
    // They were taken as the first N of a row-major list, which put every
    // parked car in the map's top-left and left the rest of the city bare —
    // and jammed those few streets solid with ambient traffic.
    const session = new Session(4242, worldgen);
    session.tick(0);
    const cars = session.state.vehicles.ids
      .map((id) => session.state.vehicles.byId[id]!)
      .filter((v) => v.kind === 'car');
    expect(cars.length).toBeGreaterThan(20);
    const xs = cars.map((v) => v.pos.x);
    const ys = cars.map((v) => v.pos.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // Spread over most of the map in both axes, rather than one neighbourhood.
    expect(spanX).toBeGreaterThan(session.map.widthPx * 0.5);
    expect(spanY).toBeGreaterThan(session.map.heightPx * 0.5);
  });

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

  it('the input buffer drains back down after a jitter storm', () => {
    // A client produces one intent per tick and the server consumes at most
    // one per tick, so the rates match — but they are not synchronised. A tick
    // on which the queue is empty consumes nothing (the last keys are held
    // instead) while the intent it was waiting for turns up and queues behind
    // the next one, and there is no path back: the buffer settles at the worst
    // excursion the link has EVER shown and stays there once the line is calm.
    // At that depth the server is simulating the player a fifth of a second in
    // the past, and at the cap it starts dropping intents the client has
    // already predicted — the "server lags behind the client physics" bug.
    const session = new Session(99, worldgen);
    const slot = session.addPlayer('jittery', 'tok');
    // Delivery is in order (a WebSocket never reorders), so a delay that grows
    // opens gaps and a delay that shrinks delivers a burst.
    const STORM = 150;
    const TICKS = 1200;
    const delayAt = (t: number): number =>
      t < STORM ? [0, 1, 2, 3, 4, 5, 6, 4, 2, 0][t % 10] as number : 1;
    const arrivals = new Map<number, InputIntent[]>();
    let due = 0;
    for (let t = 0; t < TICKS; t++) {
      due = Math.max(due, t + 1 + delayAt(t));
      const at = arrivals.get(due) ?? [];
      at.push(intent(t + 1, t, slot.playerId));
      arrivals.set(due, at);
    }
    const depths: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      const batch = arrivals.get(t);
      if (batch) session.queueInput(slot.playerId, session.state.tick, batch);
      session.tick();
      depths.push(slot.queue.length);
    }
    // The storm is allowed to fill the buffer. What matters is that a calm
    // line empties it again, back to a single spare intent of headroom.
    expect(Math.max(...depths.slice(0, STORM))).toBeGreaterThan(2);
    expect(Math.max(...depths.slice(-300))).toBeLessThanOrEqual(2);
    // And not by throwing the player's inputs away: the server must still have
    // folded in essentially everything they sent.
    expect(slot.lastInputSeq).toBeGreaterThan(TICKS * 0.97);
  });
});

describe('the crowd replenishes', () => {
  it('tops pedestrians back up to target after a massacre', () => {
    const session = new Session(4242, worldgen, null, { pedCount: 40 });
    // Drain the constructor's spawn commands into the sim.
    for (let i = 0; i < 5; i++) session.tick();
    // `pedCount` is per nominal city; the session scales it by area.
    const want = Math.round(40 * areaScale(session.map));
    const target = Math.min(want, session.map.pedSpawns.length);
    // Give or take: the initial seeding walks a rolling cursor over the
    // spawn list and skips any spot that is occupied or blocked when it
    // comes round, so a big crowd settles a couple short of the target
    // rather than landing exactly on it. That is the behaviour wanted —
    // nobody materialises on top of anybody — not a shortfall.
    expect(session.state.peds.ids.length).toBeGreaterThanOrEqual(Math.floor(target * 0.85));
    expect(session.state.peds.ids.length).toBeLessThanOrEqual(target);

    // Wipe out half the city's population directly (server-side surgery).
    const doomed = session.state.peds.ids.slice(0, Math.floor(target / 2));
    for (const id of doomed) {
      delete session.state.peds.byId[id];
      session.state.peds.ids.splice(session.state.peds.ids.indexOf(id), 1);
    }
    const after = session.state.peds.ids.length;
    expect(after).toBeLessThan(target);

    // No players are connected, so nothing is close enough to watch: the
    // crowd should refill within a reasonable window at the tuned rate. The
    // window scales with the crowd — arrivals are rate-limited per second,
    // so a city four times the size takes four times as long to refill.
    for (let i = 0; i < 30 * 60 * Math.ceil(areaScale(session.map)); i++) session.tick();
    // Back to the target, give or take. The top-up walks a rolling cursor
    // over the spawn list and skips any spot that is occupied or blocked
    // when it comes round, so on a big crowd it settles a couple short
    // rather than landing exactly — which is the behaviour wanted (nobody
    // materialises on top of anybody) rather than a shortfall.
    expect(session.state.peds.ids.length).toBeGreaterThanOrEqual(Math.floor(target * 0.85));
    expect(session.state.peds.ids.length).toBeLessThanOrEqual(target);
  });

  it('does not overshoot the target once full', () => {
    const session = new Session(4243, worldgen, null, { pedCount: 25 });
    for (let i = 0; i < 30 * 10; i++) session.tick();
    const want = Math.round(25 * areaScale(session.map));
    // At the target, or a hair under it — never over. The overshoot is what
    // this test is about; the seeder skipping an occupied spot is the sibling
    // test's business.
    const target = Math.min(want, session.map.pedSpawns.length);
    expect(session.state.peds.ids.length).toBeLessThanOrEqual(target);
    expect(session.state.peds.ids.length).toBeGreaterThanOrEqual(Math.floor(target * 0.9));
  });

});
