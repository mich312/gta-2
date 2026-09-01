import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import { Predictor } from '../src/net/prediction.js';
import { roadLane } from './helpers.js';

const map = generateCity(910, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

function intentAt(seq: number): InputIntent {
  const phase = Math.floor(seq / 10) % 4;
  return {
    ...NULL_INPUT,
    seq,
    tick: seq,
    up: phase === 0,
    right: phase === 1 || phase === 0,
    down: phase === 2,
    left: phase === 3,
    aimAngle: (seq % 60) / 10 - 3,
  };
}

describe('prediction + reconciliation', () => {
  it('predicts exactly (zero correction) when the server applies every input once, in order', () => {
    // In-process "server": authoritative state stepping one input per tick.
    let server = createGameState(101);
    server = step(server, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p' }], map);

    const predictor = new Predictor();
    predictor.reconcile(server.players.byId[1]!, null, 0, map);

    const LATENCY = 3; // ticks of delay before the client "sees" a snapshot
    const history: Array<{ state: typeof server; ackSeq: number }> = [];

    for (let seq = 1; seq <= 120; seq++) {
      const intent = intentAt(seq);
      predictor.applyLocalInput(intent, map); // client predicts instantly
      server = step(server, { 1: intent }, [], map); // server applies same input
      history.push({ state: server, ackSeq: seq });

      // Delayed snapshot arrives: reconcile against 3-tick-old authority.
      const delayed = history[history.length - 1 - LATENCY];
      if (delayed) {
        predictor.reconcile(delayed.state.players.byId[1]!, null, delayed.ackSeq, map);
        expect(predictor.lastCorrection).toBe(0);
      }
    }
    expect(predictor.maxCorrection).toBe(0);
    // And the predicted position leads the last acked authoritative one.
    expect(predictor.pendingCount).toBe(LATENCY);
  });

  it('converges after a server-side hiccup (dropped input) instead of drifting forever', () => {
    let server = createGameState(202);
    server = step(server, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'p' }], map);
    const predictor = new Predictor();
    predictor.reconcile(server.players.byId[1]!, null, 0, map);

    for (let seq = 1; seq <= 60; seq++) {
      const intent = intentAt(seq);
      predictor.applyLocalInput(intent, map);
      // Server "loses" input 30 and holds the previous one instead.
      const applied = seq === 30 ? intentAt(29) : intent;
      server = step(server, { 1: applied }, [], map);
      predictor.reconcile(server.players.byId[1]!, null, applied.seq, map);
    }
    // After the burst of corrections the predictor must agree with authority
    // for all acked input — i.e. corrections return to zero.
    const before = predictor.maxCorrection;
    for (let seq = 61; seq <= 90; seq++) {
      const intent = intentAt(seq);
      predictor.applyLocalInput(intent, map);
      server = step(server, { 1: intent }, [], map);
      predictor.reconcile(server.players.byId[1]!, null, seq, map);
      if (seq > 65) expect(predictor.lastCorrection).toBe(0);
    }
    expect(predictor.maxCorrection).toBe(before); // no new drift accumulated
  });
});

describe('collision prediction', () => {
  /**
   * The lag this fixes: without a world view the predicted car drove clean
   * through a parked one and was snapped back when the correction arrived,
   * a whole round trip later. The server has always stopped it; the point
   * here is that the client stops it too, at the same place.
   */
  function parkedCarAhead(): {
    map: ReturnType<typeof generateCity>;
    state: ReturnType<typeof createGameState>;
    lane: { x: number; y: number; heading: number };
  } {
    const map = generateCity(6006, parseWorldgenParams(worldgenJson));
    const lane = drivableLane(map);
    let state = createGameState(4242);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
    state = step(
      state,
      {},
      [
        // The one you are in...
        { type: 'spawnVehicle', vehicleId: 10, kind: 'car', x: lane.x, y: lane.y, heading: lane.heading },
        // ...and one parked 120 px down the lane.
        {
          type: 'spawnVehicle',
          vehicleId: 11,
          kind: 'car',
          x: lane.x + Math.cos(lane.heading) * 120,
          y: lane.y + Math.sin(lane.heading) * 120,
          heading: lane.heading,
        },
      ],
      map,
    );
    const p = state.players.byId[1]!;
    p.pos = { x: lane.x, y: lane.y };
    p.mode = 'driving';
    p.vehicleId = 10;
    state.vehicles.byId[10]!.driverId = 1;
    return { map, state, lane };
  }

  it('the predicted car stops against a parked one instead of driving through it', () => {
    const { map, state } = parkedCarAhead();
    const predictor = new Predictor();
    predictor.reconcile(state.players.byId[1]!, state.vehicles.byId[10]!, 0, map);
    predictor.setWorld(state.vehicles.ids.map((id) => state.vehicles.byId[id]!));

    for (let i = 0; i < 60; i++) {
      predictor.applyLocalInput({ ...NULL_INPUT, seq: i + 1, tick: i, up: true }, map);
    }
    const v = predictor.predictedVehicle!;
    const parked = state.vehicles.byId[11]!;
    const gap = Math.hypot(v.pos.x - parked.pos.x, v.pos.y - parked.pos.y);
    // Stopped short of it, not past it.
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(60);
  });

  it('without a world view it drives straight through — the old behaviour', () => {
    const { map, state } = parkedCarAhead();
    const predictor = new Predictor();
    predictor.reconcile(state.players.byId[1]!, state.vehicles.byId[10]!, 0, map);
    // Deliberately NOT calling setWorld.
    for (let i = 0; i < 60; i++) {
      predictor.applyLocalInput({ ...NULL_INPUT, seq: i + 1, tick: i, up: true }, map);
    }
    const v = predictor.predictedVehicle!;
    const parked = state.vehicles.byId[11]!;
    const travelled = Math.hypot(v.pos.x - state.vehicles.byId[10]!.pos.x, v.pos.y - state.vehicles.byId[10]!.pos.y);
    // Well past the parked car, not merely off the mark: `> 0` is satisfied
    // by one pixel, which is what let a lane the car could not drive at all
    // pass this while failing its sibling.
    expect(travelled).toBeGreaterThan(180);
    expect(parked.health).toBe(getVehicleTuning('car').health); // never touched
  });

  it('prediction agrees with the server about where the car ends up', () => {
    // The real gate: predicted position and simulated position must stay
    // together, because that is what "no correction" means.
    //
    // The world view is refreshed every tick, as the client refreshes it on
    // every snapshot. Refreshing once and then replaying two seconds of
    // input diverges by about a car length — which is a fair description of
    // a client that has stopped receiving snapshots, and not of this one.
    const { map, state } = parkedCarAhead();
    const predictor = new Predictor();
    predictor.reconcile(state.players.byId[1]!, state.vehicles.byId[10]!, 0, map);

    let sim = state;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      predictor.setWorld(sim.vehicles.ids.map((id) => sim.vehicles.byId[id]!));
      const intent: InputIntent = { ...NULL_INPUT, seq: i + 1, tick: i, up: true };
      predictor.applyLocalInput(intent, map);
      sim = step(sim, { 1: intent }, [], map);
      const predicted = predictor.predictedVehicle!;
      const actual = sim.vehicles.byId[10]!;
      worst = Math.max(worst, Math.hypot(predicted.pos.x - actual.pos.x, predicted.pos.y - actual.pos.y));
    }
    // One tick of travel at most. Before the world view this was the whole
    // length of the car and kept growing until the correction landed.
    expect(worst).toBeLessThan(8);
  });

  it('the client never invents damage', () => {
    const { map, state } = parkedCarAhead();
    const predictor = new Predictor();
    predictor.reconcile(state.players.byId[1]!, state.vehicles.byId[10]!, 0, map);
    predictor.setWorld(state.vehicles.ids.map((id) => state.vehicles.byId[id]!));
    for (let i = 0; i < 60; i++) {
      predictor.applyLocalInput({ ...NULL_INPUT, seq: i + 1, tick: i, up: true }, map);
    }
    // Health and wrecks are the server's business; a client that guessed at
    // them would be predicting somebody else's car.
    expect(predictor.predictedVehicle!.health).toBe(getVehicleTuning('car').health);
    expect(state.vehicles.byId[11]!.health).toBe(getVehicleTuning('car').health);
    expect(state.vehicles.byId[11]!.speed).toBe(0);
  });
});

/**
 * A kerbside spawn a car can DEMONSTRABLY drive away from.
 *
 * `roadLane` asks the tile plane for a clear run, which is a ray from a point
 * — and a car is a box. On a diagonal lane the two disagree: the ray threads a
 * gap the vehicle cannot, so the staging looked fine and the predicted car
 * never moved, and this file then reported a collision bug that was really a
 * lane-picking one. It survived only because the sibling test asserted
 * `travelled > 0`, which one pixel satisfies.
 *
 * So the question is asked of the physics instead of the tiles: run the
 * predictor with no world view and keep the first lane the car actually gets
 * going on. Slower, and immune to every future change in the map — which this
 * test has now been broken by twice.
 *
 * ...and by a third, iteration 6, because the probe was still not asking the
 * question it says it asks. Two faults, both measured
 * (`evidence/iter6/probe-lane-picker.txt`):
 *
 *  * The probe measured travel from `cand`, but `spawnVehicle` may refuse the
 *    requested spot and put the car somewhere else entirely. On the iteration 6
 *    bake the winning candidate's car spawned **1,561 px away**, so the probe
 *    read 1,497 px of "driving" for a car that had not moved off `cand` — it
 *    had never been on it. Every candidate the car really did drive read
 *    d40 ≈ 140, under the 180 gate, so a lane could ONLY ever be selected by
 *    this displacement: the helper had not once picked on its own criterion,
 *    before the change or after. Now the car has to actually be where the
 *    candidate says before its travel counts.
 *  * The probe drove 40 ticks; both callers drive 60. A lane vetted over 40 is
 *    not a lane vetted over 60 — the car is still accelerating at tick 40 and
 *    has another 130 px to run into whatever is there. Probed over the same 60
 *    the tests drive, against the same 180 px they assert.
 *
 * Both make the gate STRICTER. The assertions in the tests are untouched.
 */
function drivableLane(map: ReturnType<typeof generateCity>): {
  x: number;
  y: number;
  heading: number;
} {
  const home = map.playerSpawns[0] ?? { x: 0, y: 0 };
  const near = [...map.vehicleSpawns].sort(
    (a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y),
  );
  let probeState = createGameState(1);
  probeState = step(probeState, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'probe' }], map);
  let id = 100;
  for (const cand of near.slice(0, 60)) {
    const vid = id++;
    probeState = step(
      probeState,
      {},
      [{ type: 'spawnVehicle', vehicleId: vid, kind: 'car', x: cand.x, y: cand.y, heading: cand.heading }],
      map,
    );
    const veh = probeState.vehicles.byId[vid];
    if (!veh) continue;
    // The car has to be ON the candidate for its travel to be about the
    // candidate. A spawn the sim relocated is a lane this probe never drove.
    if (Math.hypot(veh.pos.x - cand.x, veh.pos.y - cand.y) > 1) continue;
    const p = probeState.players.byId[1]!;
    p.pos = { x: cand.x, y: cand.y };
    p.mode = 'driving';
    p.vehicleId = vid;
    const probe = new Predictor();
    probe.reconcile(p, veh, 0, map);
    for (let i = 0; i < 60; i++) {
      probe.applyLocalInput({ ...NULL_INPUT, seq: i + 1, tick: i, up: true }, map);
    }
    const v = probe.predictedVehicle;
    if (v && Math.hypot(v.pos.x - cand.x, v.pos.y - cand.y) > 180) return cand;
  }
  throw new Error('no drivable lane among the 60 kerbside spawns nearest the player spawn');
}
