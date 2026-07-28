import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import trafficJson from 'shared/data/traffic.json';
import pedsJson from 'shared/data/peds.json';
import policeJson from 'shared/data/police.json';
import propsJson from 'shared/data/props.json';
import weaponsJson from 'shared/data/weapons.json';
import {
  type CityMap,
  type FullSnapshot,
  type InputIntent,
  NULL_INPUT,
  Predictor,
  T_FIELD,
  TILE_SIZE,
  createGameState,
  initTuning,
  step,
  takeSnapshot,
} from 'shared';
import { Interpolator } from '../src/net/interpolation.js';

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    traffic: trafficJson,
    peds: pedsJson,
    police: policeJson,
    props: propsJson,
    weapons: weaponsJson,
  });
});

/** Open field: nothing in here ever meets a wall. */
function arena(): CityMap {
  const W = 120;
  const H = 40;
  return {
    seed: 0,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles: new Uint8Array(W * H).fill(T_FIELD),
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    playerSpawns: [{ x: 200, y: 320 }],
  };
}

/** Ticks of one-way latency to simulate: half a 66 ms round trip. */
const WIRE_LAG_TICKS = 1;

/**
 * Drive up behind a moving car with a real client on one end and a real
 * server on the other, and report the worst reconciliation correction.
 *
 * This is the game loop in miniature, and it has to be, because the bug it
 * measures lives entirely in the gap between the two loops: the client
 * predicts against an interpolated world ~100 ms in the past, the server
 * simulates the present, and a snapshot takes another half-trip to arrive.
 */
function tailgate(useLagComp: boolean): { maxCorrection: number; contacted: boolean } {
  const map = arena();
  let state = createGameState(11);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'chaser' }], map);
  const me = state.players.byId[1]!;
  me.pos.x = 200;
  me.pos.y = 320;
  state = step(
    state,
    {},
    [
      { type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: 200, y: 320, heading: 0 },
      // The lead car, rolling east under its own momentum. A car that never
      // moves is where the old code looked fine — the two timelines agree
      // about anything parked, which is why this took so long to find.
      { type: 'spawnVehicle', vehicleId: 3, kind: 'car', x: 300, y: 320, heading: 0 },
    ],
    map,
  );
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, action: true } }, [], map);
  state.vehicles.byId[3]!.speed = 130;
  state.vehicles.byId[2]!.speed = 190;

  const interp = new Interpolator();
  const predictor = new Predictor();
  const inFlight: Array<{ dueTick: number; snap: FullSnapshot }> = [];
  let maxCorrection = 0;
  let contacted = false;
  let seq = 2;

  for (let t = 0; t < 45; t++) {
    // --- client frame: deliver anything that has arrived, then predict -----
    while (inFlight.length > 0 && (inFlight[0] as { dueTick: number }).dueTick <= t) {
      const { snap } = inFlight.shift() as { dueTick: number; snap: FullSnapshot };
      interp.push(snap);
      interp.advance(1000 / 30);
      predictor.setWorld(interp.vehiclesAsDrawn());
      const authoritative = snap.players.find((p) => p.id === 1);
      if (authoritative) {
        const car = snap.vehicles.find((v) => v.id === authoritative.vehicleId) ?? null;
        predictor.reconcile(authoritative, car, authoritative.lastInputSeq, map);
        maxCorrection = Math.max(maxCorrection, predictor.lastCorrection);
      }
    }
    const intent: InputIntent = {
      ...NULL_INPUT,
      seq: seq++,
      tick: t,
      up: true,
      // The one difference between the two runs.
      viewTick: useLagComp ? interp.viewTick() : 0,
    };
    predictor.applyLocalInput(intent, map);

    // --- server tick, and the snapshot starts its journey back ------------
    state = step(state, { 1: intent }, [], map);
    if (state.vehicles.byId[2]!.speed < 150) contacted = true;
    inFlight.push({ dueTick: t + WIRE_LAG_TICKS + 1, snap: takeSnapshot(state) });
  }
  return { maxCorrection, contacted };
}

describe('tailgating a moving car', () => {
  it('costs a fraction of the correction it used to', () => {
    const without = tailgate(false);
    const withComp = tailgate(true);

    // The scenario has to actually run into something, or it measures nothing.
    expect(without.contacted).toBe(true);
    expect(withComp.contacted).toBe(true);

    // Uncompensated, client and server judge the same contact against a car
    // that is several ticks apart on their two clocks. The client stops
    // against a bumper the server still has down the road; the server pushes
    // it forward; next tick it predicts the same contact again. That
    // disagreement is what a correction IS.
    // Measured: 8.125 px, two thirds of a car length, on a single shunt at
    // city speed and one tick of wire latency.
    expect(without.maxCorrection).toBeGreaterThan(4);
    // Compensated: the server resolves the contact where the driver saw it,
    // and the two hosts stop disagreeing at all. Measured 0.
    expect(withComp.maxCorrection).toBeLessThan(1);
  });
});

describe('the tank agrees with itself across the wire', () => {
  it('predicts driving over a car, so the crush costs no correction', () => {
    // Whether the tank STOPS is decided by `crushes`, a pure function of the
    // two kinds' tuning — so the client can and must predict it. If it could
    // not, the tank would stop dead on the client and drive on for the
    // server, and every crushed car would cost a full car-length correction:
    // the exact disagreement this whole change exists to remove,
    // reintroduced by a feature.
    //
    // What stays server-side is the car's fate, which is why the tank must
    // not be BLOCKED by the wreck it leaves behind either.
    const map = arena();
    let state = createGameState(21);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'tanker' }], map);
    state.players.byId[1]!.pos = { x: 200, y: 320 };
    state = step(
      state,
      {},
      [
        { type: 'spawnVehicle', vehicleId: 2, kind: 'tank', x: 200, y: 320, heading: 0 },
        { type: 'spawnVehicle', vehicleId: 3, kind: 'car', x: 340, y: 320, heading: 0 },
        { type: 'spawnVehicle', vehicleId: 4, kind: 'car', x: 460, y: 320, heading: 0 },
      ],
      map,
    );
    state = step(state, { 1: { ...NULL_INPUT, seq: 1, action: true } }, [], map);

    const interp = new Interpolator();
    const predictor = new Predictor();
    const inFlight: Array<{ dueTick: number; snap: FullSnapshot }> = [];
    let maxCorrection = 0;
    let seq = 2;
    for (let t = 0; t < 200; t++) {
      while (inFlight.length > 0 && (inFlight[0] as { dueTick: number }).dueTick <= t) {
        const { snap } = inFlight.shift() as { dueTick: number; snap: FullSnapshot };
        interp.push(snap);
        interp.advance(1000 / 30);
        predictor.setWorld(interp.vehiclesAsDrawn());
        const authoritative = snap.players.find((p) => p.id === 1);
        if (authoritative) {
          const car = snap.vehicles.find((v) => v.id === authoritative.vehicleId) ?? null;
          predictor.reconcile(authoritative, car, authoritative.lastInputSeq, map);
          maxCorrection = Math.max(maxCorrection, predictor.lastCorrection);
        }
      }
      const intent: InputIntent = {
        ...NULL_INPUT,
        seq: seq++,
        tick: t,
        up: true,
        viewTick: interp.viewTick(),
      };
      predictor.applyLocalInput(intent, map);
      state = step(state, { 1: intent }, [], map);
      inFlight.push({ dueTick: t + WIRE_LAG_TICKS + 1, snap: takeSnapshot(state) });
    }

    // Both cars flattened, and the tank drove clean past where they stood.
    expect(state.vehicles.byId[3]?.condition).toBe('wreck');
    expect(state.vehicles.byId[4]?.condition).toBe('wreck');
    expect(state.vehicles.byId[2]!.pos.x).toBeGreaterThan(460);
    // ...with the two hosts never disagreeing about where the tank is.
    //
    // Weak on its own, and worth saying so: reconciliation re-anchors the
    // client to the server every snapshot and replays only the unacked
    // inputs, so a client that got the crush wrong can still show a small
    // correction here. The claim that the CLIENT predicts driving over a car
    // is pinned directly instead, by running the shared step in client mode
    // — see "predicts it in client mode too" in shared/test/colliders.test.ts.
    expect(maxCorrection).toBeLessThan(1);
  });
});
