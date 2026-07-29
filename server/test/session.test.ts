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
    const target = Math.min(40, session.map.pedSpawns.length);
    expect(session.state.peds.ids.length).toBe(target);

    // Wipe out half the city's population directly (server-side surgery).
    const doomed = session.state.peds.ids.slice(0, Math.floor(target / 2));
    for (const id of doomed) {
      delete session.state.peds.byId[id];
      session.state.peds.ids.splice(session.state.peds.ids.indexOf(id), 1);
    }
    const after = session.state.peds.ids.length;
    expect(after).toBeLessThan(target);

    // No players are connected, so nothing is close enough to watch: the
    // crowd should refill within a reasonable window at the tuned rate.
    for (let i = 0; i < 30 * 30; i++) session.tick();
    expect(session.state.peds.ids.length).toBe(target);
  });

  it('does not overshoot the target once full', () => {
    const session = new Session(4243, worldgen, null, { pedCount: 25 });
    for (let i = 0; i < 30 * 10; i++) session.tick();
    expect(session.state.peds.ids.length).toBe(Math.min(25, session.map.pedSpawns.length));
  });

  /**
   * Crossing a region boundary, which the player experiences as the world
   * lurching.
   *
   * Two things used to happen on the one tick the window moved. The map was
   * regenerated — a hundred milliseconds of arithmetic on both hosts — and the
   * whole ambient world was torn down and rebuilt in a single batch of about
   * nine hundred spawn commands, applied inside one `step` and then encoded
   * into one snapshot delta carrying nine hundred new entities. It was the
   * most reliable hitch in the game, and it happened exactly when the player
   * was moving fastest, because that is the only way to reach the edge.
   */
  describe('walking into the next region', () => {
    /** A roaming session driven until its window moves. Returns the tick. */
    function rebased(seed: number): { session: Session; at: number; commands: number[] } {
      const session = new Session(seed, worldgen, null, { roam: true, pedCount: 40 });
      const slot = session.addPlayer('walker', 'tok');
      session.tick();
      // Straight at the western edge until the session gives up ground.
      const commands: number[] = [];
      let at = -1;
      for (let t = 1; t <= 900; t++) {
        session.queueInput(slot.playerId, t - 1, [{ ...NULL_INPUT, seq: t, tick: t, left: true }]);
        const before = session.state.vehicles.ids.length + session.state.props.ids.length;
        session.tick();
        commands.push(session.state.vehicles.ids.length + session.state.props.ids.length - before);
        if (session.lastRebase && at < 0) at = t;
        // Teleport onward: walking the whole way would take minutes of ticks.
        const p = session.state.players.byId[slot.playerId];
        if (p && at < 0) p.pos.x = Math.max(4, p.pos.x - 40);
      }
      return { session, at, commands };
    }

    it('refills the new region without spawning it all on one tick', () => {
      const { at, commands } = rebased(9001);
      expect(at).toBeGreaterThan(0);
      // Metered. Nothing like the ~900 entities one tick used to carry; a few
      // dozen at a time, over the following second.
      const busiest = Math.max(...commands);
      expect(busiest).toBeGreaterThan(0);
      expect(busiest).toBeLessThanOrEqual(70);
      // ...and it does finish: the region really is repopulated, in about a
      // second of wall clock rather than in one frame.
      const arrivals = commands
        .slice(at, at + 40)
        .reduce((a, b) => a + Math.max(0, b), 0);
      expect(arrivals).toBeGreaterThan(200);
    });

    it('records a replay that re-simulates exactly across the boundary', () => {
      // A small window, so the edge is a walk rather than a hike: the margin
      // that trips a rebase is 24 tiles, and on the shipped 240-tile window a
      // player has 96 tiles of city to cross before reaching it.
      const small = { ...worldgen, widthTiles: 96, heightTiles: 96 };
      // The reseed is metered now — the same commands, issued over several
      // ticks instead of one. Replay is what proves that changed the timing
      // and nothing else: every command still lands on the tick it was
      // recorded on, so the run reproduces hash-identical.
      const sink = new MemorySink();
      const recorder = new ReplayRecorder(sink, {
        version: 1,
        seed: 9003,
        tickRate: 30,
        startedAt: 'test',
        tuning: getTuning(),
        worldgen: small,
      });
      const session = new Session(9003, small, recorder, { roam: true, pedCount: 40 });
      const slot = session.addPlayer('walker', 'tok');
      session.tick();
      let rebased = false;
      // Walked, not teleported. The other two tests in this block shove the
      // player at the edge because they are about what the rebase DOES; this
      // one is about the replay reproducing it, and a state mutation outside
      // the command path is precisely the thing a replay cannot reproduce.
      for (let t = 1; t <= 1800; t++) {
        session.queueInput(slot.playerId, t - 1, [
          { ...NULL_INPUT, seq: t, tick: t, left: true, up: t % 4 === 0 },
        ]);
        session.tick();
        if (session.lastRebase) rebased = true;
      }
      expect(rebased).toBe(true);
      const live = hashState(session.state);
      expect(runReplay(sink.lines).finalHash).toBe(live);
      expect(runReplay(sink.lines).finalHash).toBe(live);
    });

    it('parks the same cars at the same kerbs from either window', () => {
      // The visible half. Which kerbs are occupied, what is parked at them and
      // what colour it is were all decided by position in a row-major scan of
      // the WINDOW, so moving the window rewrote every one of them: the street
      // you were standing in rebuilt itself in front of you.
      //
      // Two sessions opened at two origins rather than one session driven
      // across a boundary, because a parked car is only parked until somebody
      // gets into it — by the time a session has walked to the edge of its
      // window, ambient life has moved half the stock, and what is being
      // measured stops being the seeding rule.
      const shiftTiles = 24;
      const other = { ...worldgen, windowX: worldgen.windowX + shiftTiles };

      const parkedAt = (params: typeof worldgen, wx: number): Map<string, string> => {
        const session = new Session(9002, params, null, { pedCount: 0 });
        session.tick();
        const out = new Map<string, string>();
        for (const id of session.state.vehicles.ids) {
          const v = session.state.vehicles.byId[id]!;
          // Turf is window-scoped by construction, so a gang's cars may
          // legitimately change hands with the viewport; see windows.test.ts.
          if (v.kind === 'gangcar') continue;
          // Kerbside stock only. A vehicle HOME carries no paint — its colour
          // still comes off the id — because `placeVehicleHomes` falls back to
          // an index into the window's own spawn list when a kind has no
          // landmark to live at. That backstop is window-scoped like the turf,
          // and it covers a dozen speciality vehicles rather than the parked
          // traffic this is about.
          if (v.paint < 0) continue;
          out.set(`${Math.round(v.pos.x) + wx * 16},${Math.round(v.pos.y)}`, `${v.kind}/${v.paint}`);
        }
        return out;
      };

      const a = parkedAt(worldgen, 0);
      const b = parkedAt(other, shiftTiles);
      let shared = 0;
      for (const [where, car] of a) {
        const also = b.get(where);
        if (also === undefined) continue;
        shared++;
        expect(`${where}: ${car}`).toBe(`${where}: ${also}`);
      }
      // Two windows 24 tiles apart overlap almost entirely, so most of one
      // window's parked stock has to appear in the other's.
      expect(shared).toBeGreaterThan(a.size * 0.5);
    });
  });
});
