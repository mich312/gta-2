import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import gangsJson from '../data/gangs.json';
import respectJson from '../data/respect.json';
import worldgenJson from '../data/worldgen.json';
import { getTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { gangAt, rivalsOf } from '../src/world/turf.js';
import { createCop, createGameState, createPed, type GameState } from '../src/sim/state.js';
import { creditGangFavour, isFriendly, isHostile, respectOf } from '../src/sim/respect.js';
import { damagePed } from '../src/sim/peds.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';

const worldgen = parseWorldgenParams(worldgenJson);
const map = generateCity(777, worldgen);

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
    gangs: gangsJson,
    respect: respectJson,
  });
});

/** A pedestrian spawn point on the ground `gangId` holds. */
function turfOf(gangId: number): { x: number; y: number } {
  const at = map.pedSpawns.find((s) => gangAt(map, s.x, s.y) === gangId);
  if (!at) throw new Error(`no turf for gang ${gangId}`);
  return at;
}

/** A player plus one member of `gangId`, both on that gang's ground. */
function withGangMember(gangId: number, pedId = 40): GameState {
  const at = turfOf(gangId);
  let state = createGameState(777);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
  state.players.byId[1]!.pos = { x: at.x + 40, y: at.y };
  state = step(state, {}, [{ type: 'spawnPed', pedId, x: at.x, y: at.y }], map);
  expect(state.peds.byId[pedId]!.gangId, 'that ped id should be a member').toBe(gangId);
  return state;
}

describe('respect (H2)', () => {
  it('killing a gang member costs their respect and buys their rivals', () => {
    const state = withGangMember(1);
    const me = state.players.byId[1]!;
    const before = respectOf(me, 1);
    damagePed(state, state.peds.byId[40]!, 500, 1, []);

    const t = getTuning().respect;
    expect(respectOf(me, 1)).toBe(before - t.killPenalty);
    for (const rival of rivalsOf(1)) {
      expect(respectOf(me, rival), `rival ${rival}`).toBe(Math.round(t.killPenalty * t.rivalShare));
    }
  });

  it('killing a civilian moves nobody', () => {
    const at = turfOf(1);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
    // An id that is not a multiple of memberEvery is an ordinary person.
    state = step(state, {}, [{ type: 'spawnPed', pedId: 41, x: at.x, y: at.y }], map);
    expect(state.peds.byId[41]!.gangId).toBe(0);
    damagePed(state, state.peds.byId[41]!, 500, 1, []);
    const me = state.players.byId[1]!;
    for (let g = 1; g <= 4; g++) expect(respectOf(me, g)).toBe(0);
  });

  it('doing a gang a favour costs you with their rivals — nothing is free', () => {
    const state = withGangMember(1);
    const me = state.players.byId[1]!;
    creditGangFavour(me, 1, getTuning().respect.missionFavour);
    expect(respectOf(me, 1)).toBeGreaterThan(0);
    for (const rival of rivalsOf(1)) expect(respectOf(me, rival)).toBeLessThan(0);
  });

  it('respect is bounded at both ends', () => {
    const state = withGangMember(1);
    const me = state.players.byId[1]!;
    const t = getTuning().respect;
    for (let i = 0; i < 200; i++) creditGangFavour(me, 1, 50);
    expect(respectOf(me, 1)).toBe(t.ceiling);
    for (let i = 0; i < 400; i++) creditGangFavour(me, 1, -50);
    expect(respectOf(me, 1)).toBe(t.floor);
  });

  it('a gang you have wronged turns hostile and opens fire on their own ground', () => {
    let state = withGangMember(1);
    const hostileAt = getTuning().respect.hostileAt;
    expect(isHostile(state.players.byId[1]!, 1)).toBe(false);

    const events: SimEvent[] = [];
    for (let i = 0; i < 120; i++) {
      const p = state.players.byId[1]!;
      p.respect[0] = hostileAt - 5; // held there against the decay
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick } }, [], map, events);
    }
    expect(state.peds.byId[40]!.mode).toBe('hostile');
    expect(events.some((e) => e.type === 'shot')).toBe(true);
    expect(state.players.byId[1]!.health).toBeLessThan(100);
  });

  it('hostility is local: the same grudge, a different postcode', () => {
    // The safeguard that stops a bad hour turning the whole map into a
    // shooting gallery, and the reason this is designed in rather than
    // patched on.
    let state = withGangMember(1);
    const elsewhere = turfOf(2);
    state.peds.byId[40]!.pos = { x: elsewhere.x, y: elsewhere.y };
    state.players.byId[1]!.pos = { x: elsewhere.x + 40, y: elsewhere.y };

    for (let i = 0; i < 120; i++) {
      const p = state.players.byId[1]!;
      p.respect[0] = getTuning().respect.hostileAt - 5;
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick } }, [], map);
    }
    expect(state.peds.byId[40]!.mode).not.toBe('hostile');
    expect(state.players.byId[1]!.health).toBe(100);
  });

  it('respect drifts back toward neutral, from both directions', () => {
    let state = withGangMember(1);
    const me = state.players.byId[1]!;
    me.respect[0] = -40;
    me.respect[1] = 40;
    const decay = getTuning().respect.decayEveryTicks;
    for (let i = 0; i < decay * 3 + 2; i++) state = step(state, { 1: NULL_INPUT }, [], map);
    const after = state.players.byId[1]!;
    expect(after.respect[0]!).toBeGreaterThan(-40);
    expect(after.respect[1]!).toBeLessThan(40);
  });

  it('a gang that owes you shoots at the police chasing you on their ground', () => {
    const at = turfOf(1);
    let state = createGameState(777);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'friend' }], map);
    state.players.byId[1]!.pos = { x: at.x + 30, y: at.y };
    state = step(state, {}, [{ type: 'spawnPed', pedId: 40, x: at.x, y: at.y }], map);
    insertEntity(state.cops, createCop(500, { x: at.x + 12, y: at.y }, 50));
    const healthBefore = state.cops.byId[500]!.health;

    for (let i = 0; i < 120; i++) {
      const p = state.players.byId[1]!;
      p.heat = 250;
      p.respect[0] = getTuning().respect.friendlyAt + 10;
      // A fugitive is a moving target. Standing still next to an officer is
      // an arrest (F2), which ends the chase this test is about.
      p.vel = { x: getTuning().player.walkSpeed, y: 0 };
      expect(isFriendly(p, 1)).toBe(true);
      state = step(state, { 1: NULL_INPUT }, [], map);
      if (!state.cops.byId[500]) break; // shot to bits, which is the point
    }
    const after = state.cops.byId[500];
    expect(after === undefined || after.health < healthBefore).toBe(true);
  });

  it('all of it is deterministic', () => {
    const run = (): number => {
      let s = withGangMember(1);
      for (let i = 0; i < 90; i++) {
        s.players.byId[1]!.respect[0] = getTuning().respect.hostileAt - 5;
        s = step(s, { 1: { ...NULL_INPUT, seq: i + 1, tick: s.tick } }, [], map);
      }
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

describe('gang war (J4)', () => {
  /** Two rivals face to face on ground neither of them holds. */
  function standoff(): { state: GameState; aId: number; bId: number; gangA: number } {
    let state = createGameState(1212);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'onlooker' }], map);
    // Ground held by gang 4, so gangs 1 and 2 are both away from home.
    const at = turfOf(4);
    const gangA = 1;
    const gangB = rivalsOf(gangA)[0] as number;
    const a = createPed(5001, { x: at.x, y: at.y }, 30, gangA);
    const b = createPed(5002, { x: at.x + 40, y: at.y }, 30, gangB);
    insertEntity(state.peds, a);
    insertEntity(state.peds, b);
    return { state, aId: 5001, bId: 5002, gangA };
  }

  it('a gang member killed by a rival earns the player nothing at all', () => {
    // THE test for this feature. Without it, standing in the right postcode
    // and watching is an earning strategy: every body dropped by somebody
    // else would move your standing with two gangs.
    let { state } = standoff();
    const me = state.players.byId[1]!;
    const before = [...me.respect];
    const events: SimEvent[] = [];
    for (let i = 0; i < 600; i++) {
      state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: state.tick } }, [], map, events);
    }
    expect(events.some((e) => e.type === 'gangFight')).toBe(true);
    // Somebody died out there...
    const died = !state.peds.byId[5001] || !state.peds.byId[5002];
    expect(died).toBe(true);
    // ...and it changed nothing about how anybody feels about the player.
    expect([...state.players.byId[1]!.respect]).toEqual(before);
  });

  it('rivals engage on contested ground', () => {
    let { state } = standoff();
    let sawFight = false;
    for (let i = 0; i < 200 && !sawFight; i++) {
      state = step(state, {}, [], map);
      for (const id of [5001, 5002]) {
        if (state.peds.byId[id]?.mode === 'fighting') sawFight = true;
      }
    }
    expect(sawFight).toBe(true);
  });

  it('two members of the SAME gang never square up', () => {
    let state = createGameState(1313);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'onlooker' }], map);
    const at = turfOf(4);
    insertEntity(state.peds, createPed(5101, { x: at.x, y: at.y }, 30, 1));
    insertEntity(state.peds, createPed(5102, { x: at.x + 40, y: at.y }, 30, 1));
    const events: SimEvent[] = [];
    for (let i = 0; i < 300; i++) state = step(state, {}, [], map, events);
    expect(events.some((e) => e.type === 'gangFight')).toBe(false);
    expect(state.peds.byId[5101]?.mode).not.toBe('fighting');
    expect(state.peds.byId[5102]?.mode).not.toBe('fighting');
  });

  it('nobody starts a fight on their own doorstep', () => {
    // contestedOnly: a city where everybody brawls at home is at war with
    // itself rather than having a border dispute.
    let state = createGameState(1414);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'onlooker' }], map);
    const at = turfOf(1);
    expect(gangAt(map, at.x, at.y)).toBe(1);
    const rival = rivalsOf(1)[0] as number;
    insertEntity(state.peds, createPed(5201, { x: at.x, y: at.y }, 30, 1));
    insertEntity(state.peds, createPed(5202, { x: at.x + 40, y: at.y }, 30, rival));
    const events: SimEvent[] = [];
    for (let i = 0; i < 200; i++) state = step(state, {}, [], map, events);
    // The visitor may start something; the gang standing at home may not.
    for (const e of events) {
      if (e.type === 'gangFight') expect(e.gangId).toBe(rival);
    }
    expect(state.peds.byId[5201]?.mode).not.toBe('fighting');
  });

  it('the city does not fight itself to death', () => {
    // A gang war with no ceiling empties the streets in minutes. Peds are
    // spawned by the server rather than by step(), so a bare state has none:
    // populate one the way session.ts does before measuring survival.
    let state = createGameState(1515);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'onlooker' }], map);
    const cmds = map.pedSpawns.slice(0, 200).map((spot, i) => ({
      type: 'spawnPed' as const,
      pedId: 1000 + i,
      x: spot.x,
      y: spot.y,
    }));
    state = step(state, {}, cmds, map);
    const countGang = (s: GameState): number => {
      let n = 0;
      for (const id of s.peds.ids) if ((s.peds.byId[id]?.gangId ?? 0) !== 0) n++;
      return n;
    };
    const before = countGang(state);
    expect(before).toBeGreaterThan(10);
    for (let i = 0; i < 1800; i++) state = step(state, {}, [], map);
    // Most of them are still standing after a minute of city.
    expect(countGang(state) / before).toBeGreaterThan(0.7);
  });

  it('never runs more fights at once than the ceiling allows', () => {
    let state = createGameState(1616);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'onlooker' }], map);
    const cap = getTuning().gangs.maxConcurrentFights;
    for (let i = 0; i < 900; i++) {
      state = step(state, {}, [], map);
      let n = 0;
      for (const id of state.peds.ids) if (state.peds.byId[id]?.mode === 'fighting') n++;
      expect(n).toBeLessThanOrEqual(cap);
    }
  });

  it('a fight is deterministic like everything else', () => {
    const run = (): number => {
      let { state } = standoff();
      for (let i = 0; i < 400; i++) state = step(state, {}, [], map);
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
