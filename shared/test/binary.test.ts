import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { createGameState } from '../src/sim/state.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import type { SimCommand } from '../src/sim/commands.js';
import { diffSnapshots, takeSnapshot, applyDelta, type FullSnapshot } from '../src/net/snapshot.js';
import { hashSnapshot } from '../src/net/hash.js';
import { binaryCodec } from '../src/net/binary.js';
import { jsonCodec } from '../src/net/codec.js';
import { parseClientMessage, parseServerMessage } from '../src/net/messages.js';
import { seedRng, nextFloat01, nextIntRange } from '../src/rng/prng.js';

const worldgen = parseWorldgenParams(worldgenJson);
const map = generateCity(31337, worldgen);

// Module scope, not beforeAll: the fixture below is built while the describe
// body evaluates, which happens before any hook runs.
initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  police: policeJson,
  peds: pedsJson,
  props: propsJson,
  pickups: pickupsJson,
});

/**
 * A busy world: players shooting and driving, cops chasing, peds fleeing,
 * props breaking, pickups cycling. Returns a snapshot per tick so the tests
 * can diff consecutive ones the way the server does.
 */
function busySnapshots(count: number): FullSnapshot[] {
  let state = createGameState(31337);
  const boot: SimCommand[] = [
    { type: 'spawnPlayer', playerId: 1, name: 'alice', loadout: [{ weaponId: 'pistol', ammo: 900 }] },
    { type: 'spawnPlayer', playerId: 2, name: 'bob', loadout: [{ weaponId: 'shotgun', ammo: 900 }] },
  ];
  for (let i = 0; i < 12; i++) {
    const s = map.propSpawns[i * 3];
    if (s) boot.push({ type: 'spawnProp', propId: 100 + i, kind: s.kind, x: s.x, y: s.y, orient: s.orient });
  }
  for (let i = 0; i < 20; i++) {
    const s = map.pedSpawns[i * 7];
    if (s) boot.push({ type: 'spawnPed', pedId: 200 + i, x: s.x, y: s.y });
  }
  for (let i = 0; i < 6; i++) {
    const s = map.vehicleSpawns[i * 5];
    if (s) boot.push({ type: 'spawnVehicle', vehicleId: 300 + i, kind: 'car', x: s.x, y: s.y, heading: s.heading });
  }
  for (let i = 0; i < 4; i++) {
    const s = map.pickupSpawns[i];
    if (s) boot.push({ type: 'spawnPickup', pickupId: 400 + i, kind: s.kind, x: s.x, y: s.y });
  }
  state = step(state, {}, boot, map);

  const out: FullSnapshot[] = [takeSnapshot(state)];
  let rng = seedRng(4242);
  for (let t = 0; t < count; t++) {
    const inputs: Record<number, InputIntent> = {};
    for (const pid of [1, 2]) {
      let r: number;
      [r, rng] = nextFloat01(rng);
      let aim: number;
      [aim, rng] = nextFloat01(rng);
      inputs[pid] = {
        ...NULL_INPUT,
        seq: t + 1,
        tick: t + 1,
        up: r < 0.4,
        down: r > 0.8,
        left: r > 0.3 && r < 0.5,
        right: r > 0.6,
        fire: r < 0.5,
        action: r > 0.94,
        aimAngle: (aim - 0.5) * 6.2,
      };
    }
    // Keep the two close enough to actually trade fire and generate heat.
    const a = state.players.byId[1];
    const b = state.players.byId[2];
    if (a && b && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > 150) {
      b.pos = { x: a.pos.x + 70, y: a.pos.y + 20 };
    }
    // Seed heat directly so the police table is genuinely exercised; random
    // aim alone connects too rarely to be a dependable fixture.
    const crook = state.players.byId[1];
    if (crook && t > 20) crook.heat = Math.max(crook.heat, 260);
    let jolt: number;
    [jolt, rng] = nextIntRange(rng, 0, 6);
    const v = state.vehicles.byId[300 + jolt];
    if (v) v.speed = 240;
    state = step(state, inputs, [], map);
    out.push(takeSnapshot(state));
  }
  return out;
}

/** Everything a delta can actually restore — see the note in the delta test. */
function stripSeq(s: FullSnapshot): FullSnapshot {
  return { ...s, players: s.players.map((p) => ({ ...p, lastInputSeq: 0 })) };
}

describe('binary codec', () => {
  const snaps = busySnapshots(240);

  it('the fixture actually exercises every table', () => {
    const last = snaps[snaps.length - 1]!;
    expect(last.players.length).toBe(2);
    expect(last.vehicles.length).toBeGreaterThan(0);
    expect(last.peds.length).toBeGreaterThan(0);
    expect(last.props.length).toBeGreaterThan(0);
    expect(last.pickups.length).toBeGreaterThan(0);
    // Violence happened: somebody has heat, somebody took damage.
    const hurt = snaps.some((s) => s.players.some((p) => p.health < 100 || p.heat > 0));
    expect(hurt).toBe(true);
    // And cops turned out for it at some point.
    expect(snaps.some((s) => s.cops.length > 0)).toBe(true);
  });

  it('full snapshots round-trip to an IDENTICAL hash', () => {
    for (const snap of snaps) {
      const wire = binaryCodec.encode({ type: 'full', tick: snap.tick, snapshot: snap });
      const back = parseServerMessage(binaryCodec.decode(wire));
      expect(back?.type).toBe('full');
      const decoded = (back as { snapshot: FullSnapshot }).snapshot;
      // Hash equality is the real contract: one ULP of drift here is a desync.
      expect(hashSnapshot(decoded)).toBe(hashSnapshot(snap));
      expect(decoded).toEqual(snap);
    }
  });

  it('deltas round-trip and reapply to the identical snapshot', () => {
    for (let i = 1; i < snaps.length; i++) {
      const base = snaps[i - 1]!;
      const cur = snaps[i]!;
      const delta = diffSnapshots(base, cur);
      const wire = binaryCodec.encode({
        type: 'snapshot',
        tick: cur.tick,
        baseTick: base.tick,
        ackSeq: i,
        delta,
        hash: hashSnapshot(cur),
      });
      const back = binaryCodec.decode(wire) as {
        type: string;
        tick: number;
        baseTick: number;
        ackSeq: number;
        hash?: number;
        delta: typeof delta;
      };
      expect(back.type).toBe('snapshot');
      expect(back.tick).toBe(cur.tick);
      expect(back.baseTick).toBe(base.tick);
      expect(back.ackSeq).toBe(i);
      expect(back.hash).toBe(hashSnapshot(cur));
      const rebuilt = applyDelta(base, back.delta, cur.tick);
      expect(hashSnapshot(rebuilt)).toBe(hashSnapshot(cur));
      // lastInputSeq is deliberately not diffed (snapshot.ts), so applyDelta
      // cannot restore it under ANY codec — a reapplied delta keeps the base
      // value. Compare everything else exactly.
      expect(stripSeq(rebuilt)).toEqual(stripSeq(cur));
    }
  });

  it('omits a hash when the server did not send one', () => {
    const base = snaps[0]!;
    const cur = snaps[1]!;
    const wire = binaryCodec.encode({
      type: 'snapshot',
      tick: cur.tick,
      baseTick: base.tick,
      ackSeq: 1,
      delta: diffSnapshots(base, cur),
    });
    const back = binaryCodec.decode(wire) as Record<string, unknown>;
    expect('hash' in back).toBe(false);
  });

  it('round-trips client input, quantised exactly as the sim would', () => {
    const intents: InputIntent[] = [
      { ...NULL_INPUT, seq: 1, tick: 2, up: true, fire: true, aimAngle: 1.25, slot: 3 },
      { ...NULL_INPUT, seq: 2, tick: 3, down: true, left: true, action: true, aimAngle: -2.5 },
      { ...NULL_INPUT, seq: 900000, tick: 900001, right: true, aimAngle: 3.140625, slot: 7 },
    ];
    const wire = binaryCodec.encode({ type: 'input', ackTick: 12345, intents });
    const back = parseClientMessage(binaryCodec.decode(wire));
    expect(back?.type).toBe('input');
    const got = back as { ackTick: number; intents: InputIntent[] };
    expect(got.ackTick).toBe(12345);
    expect(got.intents).toEqual(intents);
  });

  it('carries the structurally complex messages through as JSON', () => {
    const msgs = [
      { type: 'pong' as const, t: 1.5, serverTick: 99 },
      { type: 'wallet' as const, cash: 12345 },
      { type: 'error' as const, code: 'nope', message: 'bad' },
      { type: 'account' as const, ok: true, username: 'zoe', message: 'hi' },
      {
        type: 'event' as const,
        tick: 5,
        event: { type: 'kill' as const, tick: 5, killerId: 1, victimId: 2, weaponId: 'pistol' },
      },
    ];
    for (const m of msgs) {
      expect(parseServerMessage(binaryCodec.decode(binaryCodec.encode(m)))).toEqual(m);
    }
  });

  it('still understands a JSON-speaking peer', () => {
    const m = { type: 'ping' as const, t: 7 };
    expect(parseClientMessage(binaryCodec.decode(jsonCodec.encode(m) as string))).toEqual(m);
  });

  it('handles non-ASCII player names', () => {
    const snap = snaps[0]!;
    const renamed: FullSnapshot = {
      ...snap,
      players: snap.players.map((p, i) => ({ ...p, name: i === 0 ? 'zoë-日本語-🎮' : p.name })),
    };
    const back = binaryCodec.decode(
      binaryCodec.encode({ type: 'full', tick: renamed.tick, snapshot: renamed }),
    ) as { snapshot: FullSnapshot };
    expect(back.snapshot.players[0]!.name).toBe('zoë-日本語-🎮');
    expect(hashSnapshot(back.snapshot)).toBe(hashSnapshot(renamed));
  });

  it('is dramatically smaller than JSON on real delta traffic', () => {
    let jsonBytes = 0;
    let binBytes = 0;
    for (let i = 1; i < snaps.length; i++) {
      const msg = {
        type: 'snapshot' as const,
        tick: snaps[i]!.tick,
        baseTick: snaps[i - 1]!.tick,
        ackSeq: i,
        delta: diffSnapshots(snaps[i - 1]!, snaps[i]!),
      };
      jsonBytes += (jsonCodec.encode(msg) as string).length;
      binBytes += (binaryCodec.encode(msg) as Uint8Array).byteLength;
    }
    // Guard against a regression that quietly reinflates the wire.
    expect(binBytes).toBeLessThan(jsonBytes * 0.5);
  });
});
