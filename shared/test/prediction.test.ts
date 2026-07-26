import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import { Predictor } from '../src/net/prediction.js';

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
