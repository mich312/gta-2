import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import propsJson from '../../shared/data/props.json';
import pickupsJson from '../../shared/data/pickups.json';
import gangsJson from '../../shared/data/gangs.json';
import respectJson from '../../shared/data/respect.json';
import worldgenJson from '../../shared/data/worldgen.json';
import {
  type GameState,
  type SimEvent,
  TICK_RATE,
  createGameState,
  gangAt,
  generateCity,
  getTuning,
  initTuning,
  parseWorldgenParams,
  respectOf,
  step,
} from 'shared';
import { Missions } from '../src/missions/missions.js';

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

/** A phone that somebody's gang holds, and a player standing at it. */
function atPhone(): { state: GameState; phone: { x: number; y: number }; gang: number } {
  const phone = map.payphones.find((q) => gangAt(map, q.x, q.y) !== 0);
  if (!phone) throw new Error('no payphone on anybody��s turf');
  let state = createGameState(777);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'hood' }], map);
  state.players.byId[1]!.pos = { x: phone.x, y: phone.y };
  return { state, phone, gang: gangAt(map, phone.x, phone.y) };
}

describe('payphone missions (H3)', () => {
  it('worldgen puts phones on street corners, spread out', () => {
    expect(map.payphones.length).toBeGreaterThan(3);
    for (let i = 0; i < map.payphones.length; i++) {
      for (let j = i + 1; j < map.payphones.length; j++) {
        const a = map.payphones[i]!;
        const b = map.payphones[j]!;
        expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(420);
      }
    }
  });

  it('you have to be at a phone, on foot, to answer it', () => {
    const { state, phone } = atPhone();
    const m = new Missions();
    state.players.byId[1]!.pos = { x: phone.x + 5000, y: phone.y };
    expect(m.take(1, state, map)).toMatch(/payphone/);

    state.players.byId[1]!.pos = { x: phone.x, y: phone.y };
    state.players.byId[1]!.mode = 'driving';
    expect(m.take(1, state, map)).toMatch(/out of the car/);

    state.players.byId[1]!.mode = 'foot';
    expect(m.take(1, state, map)).toBeNull();
    expect(m.activeFor(1)).toBeDefined();
  });

  it('a gang that hates you will not put work your way', () => {
    const { state, gang } = atPhone();
    state.players.byId[1]!.respect[gang - 1] = getTuning().respect.hostileAt - 1;
    const m = new Missions();
    expect(m.take(1, state, map)).toMatch(/time of day/);
    expect(m.activeFor(1)).toBeUndefined();
  });

  it('standing gates the tier: the good jobs need respect first', () => {
    const { state, gang } = atPhone();
    const green = new Missions();
    expect(green.take(1, state, map)).toBeNull();
    expect(green.activeFor(1)!.spec.tier).toBe('green');

    // With standing, the board opens up. Take repeatedly and a better tier
    // must eventually be offered.
    const rich = new Missions();
    state.players.byId[1]!.respect[gang - 1] = 40;
    const tiers = new Set<string>();
    for (let i = 0; i < 7; i++) {
      rich.take(1, state, map);
      const active = rich.activeFor(1);
      if (active) tiers.add(active.spec.tier);
      rich.abandon(1);
    }
    expect(tiers.has('red')).toBe(true);
  });

  it('one job at a time', () => {
    const { state } = atPhone();
    const m = new Missions();
    expect(m.take(1, state, map)).toBeNull();
    expect(m.take(1, state, map)).toMatch(/already/);
  });

  it('the clock is a real failure condition', () => {
    const { state } = atPhone();
    const m = new Missions();
    m.take(1, state, map);
    const deadline = m.activeFor(1)!.deadlineTick;
    let s = state;
    // Fast-forward past the deadline without touching the objective.
    s.tick = deadline;
    const out = m.step([], s, map);
    expect(m.activeFor(1)).toBeUndefined();
    expect(out.notices[0]!.text).toMatch(/out of time/);
    expect(out.completed.length).toBe(0);
  });

  it('dying fails the job — the sandbox can kill a mission', () => {
    const { state } = atPhone();
    const m = new Missions();
    m.take(1, state, map);
    state.players.byId[1]!.mode = 'dead';
    const out = m.step([], state, map);
    expect(m.activeFor(1)).toBeUndefined();
    expect(out.notices[0]!.text).toMatch(/did not make it/);
  });

  it('kills count toward the job, and finishing pays and earns respect', () => {
    const { state, gang } = atPhone();
    const m = new Missions();
    m.take(1, state, map);
    const spec = m.activeFor(1)!.spec;
    // Only kill-shaped jobs are testable this way; retake until we get one.
    let guard = 0;
    while (m.activeFor(1)!.spec.kind === 'delivery' && guard++ < 8) {
      m.abandon(1);
      m.take(1, state, map);
    }
    const target = m.activeFor(1)!.spec.count;
    const before = respectOf(state.players.byId[1]!, gang);

    const events: SimEvent[] = [];
    for (let i = 0; i < target; i++) {
      events.push({ type: 'pedDown', tick: state.tick, killerId: 1 });
    }
    const out = m.step(events, state, map);
    expect(out.completed.length).toBe(1);
    expect(out.completed[0]!.pay).toBeGreaterThan(0);
    expect(respectOf(state.players.byId[1]!, gang)).toBeGreaterThan(before);
    expect(m.activeFor(1)).toBeUndefined();
    expect(spec.seconds).toBeGreaterThan(0);
  });

  it("somebody else's kills do not do your job for you", () => {
    const { state } = atPhone();
    const m = new Missions();
    m.take(1, state, map);
    const out = m.step([{ type: 'pedDown', tick: state.tick, killerId: 2 }], state, map);
    expect(out.completed.length).toBe(0);
    expect(m.activeFor(1)!.progress).toBe(0);
  });

  it('the view is what the HUD needs, and reads empty when idle', () => {
    const { state } = atPhone();
    const m = new Missions();
    expect(m.view(1, state.tick).active).toBe(false);
    m.take(1, state, map);
    const v = m.view(1, state.tick);
    expect(v.active).toBe(true);
    expect(v.text.length).toBeGreaterThan(0);
    expect(v.employer.length).toBeGreaterThan(0);
    expect(v.secondsLeft).toBeGreaterThan(0);
    expect(v.secondsLeft).toBeLessThanOrEqual(m.activeFor(1)!.spec.seconds);
    expect(v.target).toBe(m.activeFor(1)!.spec.count);
    expect(TICK_RATE).toBe(30);
  });
});

describe('three more mission kinds (N1)', () => {
  /**
   * Force a specific kind onto a player, bypassing the board's rotation and
   * respect gate: this suite is about the VERBS, not about who offers them.
   */
  function give(kind: string): { missions: Missions; state: GameState } {
    const { state, gang } = atPhone();
    const missions = new Missions();
    const p = state.players.byId[1]!;
    p.respect = p.respect.map(() => 60);
    // Take jobs until the rotating board offers the one we want.
    for (let i = 0; i < 40; i++) {
      missions.abandon(1);
      const why = missions.take(1, state, map);
      expect(why, `attempt ${i}`).toBeNull();
      if (missions.activeFor(1)?.spec.kind === kind) return { missions, state };
    }
    throw new Error(`board never offered a ${kind}`);
  }
  void 0;

  it('a race must be run IN ORDER', () => {
    // The difference between a race and a scavenger hunt, and the obvious
    // implementation gets it wrong.
    const { missions, state } = give('race');
    const m = missions.activeFor(1)!;
    expect(m.route?.length).toBe(m.spec.count);
    const route = m.route!;
    const p = state.players.byId[1]!;

    // Standing on the LAST checkpoint first counts for nothing.
    p.pos = { x: route[route.length - 1]!.x, y: route[route.length - 1]!.y };
    missions.step([], state, map);
    expect(missions.activeFor(1)!.progress).toBe(0);

    // Taken in order, each one counts exactly once.
    for (let i = 0; i < route.length; i++) {
      p.pos = { x: route[i]!.x, y: route[i]!.y };
      missions.step([], state, map);
      missions.step([], state, map); // and standing there does not double-count
      const still = missions.activeFor(1);
      if (!still) {
        expect(i).toBe(route.length - 1); // finished on the last one
        return;
      }
      expect(still.progress).toBe(i + 1);
    }
  });

  it('an escape needs you to arrive hot, then go quiet', () => {
    const { missions, state } = give('escape');
    const m = missions.activeFor(1)!;
    expect(m.marker).not.toBeNull();
    const p = state.players.byId[1]!;
    p.pos = { x: m.marker!.x, y: m.marker!.y };

    // Arriving clean is a walk, not an escape: the hold does not start,
    // because the job was never primed.
    p.heat = 0;
    missions.step([], state, map);
    expect(missions.activeFor(1)!.primed).toBe(false);
    expect(missions.activeFor(1)!.holdUntilTick).toBeNull();

    // Get hot: primed now, but still no hold — they are still on you.
    p.heat = 260;
    missions.step([], state, map);
    expect(missions.activeFor(1)!.primed).toBe(true);
    expect(missions.activeFor(1)!.holdUntilTick).toBeNull();

    // Shake them off at the marker and the clock starts.
    p.heat = 0;
    missions.step([], state, map);
    const until = missions.activeFor(1)!.holdUntilTick;
    expect(until).toBeGreaterThan(state.tick);

    // Leaving resets it — lying low means staying put.
    p.pos = { x: m.marker!.x + 400, y: m.marker!.y };
    missions.step([], state, map);
    expect(missions.activeFor(1)!.holdUntilTick).toBeNull();
  });

  it('a bomb job wants an explosion on their doorstep, not just any bang', () => {
    const { missions, state } = give('bomb');
    const m = missions.activeFor(1)!;
    expect(m.marker).not.toBeNull();

    // A blast on the far side of town does nothing.
    missions.step(
      [{ type: 'explosion', tick: state.tick, x: m.marker!.x + 3000, y: m.marker!.y, radius: 90 }],
      state,
      map,
    );
    expect(missions.activeFor(1)?.progress ?? 0).toBe(0);

    // One on the target finishes it.
    const out = missions.step(
      [{ type: 'explosion', tick: state.tick, x: m.marker!.x, y: m.marker!.y, radius: 90 }],
      state,
      map,
    );
    expect(out.completed.some((c) => c.playerId === 1)).toBe(true);
  });

  it('every kind on the board can be described without crashing the HUD', () => {
    const { state } = atPhone();
    const missions = new Missions();
    state.players.byId[1]!.respect = state.players.byId[1]!.respect.map(() => 60);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      missions.abandon(1);
      if (missions.take(1, state, map) !== null) continue;
      const m = missions.activeFor(1);
      if (!m) continue;
      seen.add(m.spec.kind);
      const view = missions.view(1, state.tick);
      expect(view.active).toBe(true);
      expect(view.text.length).toBeGreaterThan(0);
    }
    // All six verbs are reachable from the board.
    for (const kind of ['hit', 'sweep', 'delivery', 'escape', 'race', 'bomb']) {
      expect(seen, kind).toContain(kind);
    }
  });
});
