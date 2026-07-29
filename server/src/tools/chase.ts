import {
  createGameState,
  generateCity,
  NULL_INPUT,
  step,
  type CityMap,
  type GameState,
  type InputIntent,
} from 'shared';
import { loadSharedTuning, loadWorldgenParams } from '../tuning.js';

/**
 * The chase bench.
 *
 * GTA.md's Wave P makes two claims that are measurements rather than
 * opinions — "you can lose the police" and "it is not too hard" — and this is
 * what measures them. Both were argued for years by feel, and feel is exactly
 * what a wanted system defeats: the person tuning it knows where the alleys
 * are.
 *
 * Two numbers, and they are deliberately two:
 *
 *  - **escape rate.** Of N runs at a given star level, how many reach zero
 *    heat inside the window. Before P1 this was 0 at every level, on every
 *    seed, for ever: heat decayed only while nobody could see you, and the
 *    dispatcher answered a wanted level by placing fresh officers inside
 *    sight range.
 *  - **survival time.** How long a player lasts, measured twice — moving,
 *    and standing still in the open. One number alone is a trap. Making the
 *    police weaker moves both, and a police force you can ignore by standing
 *    still is not a difficulty fix, it is a broken one.
 *
 * **What the escape number does not show.** The driver here is an autopilot:
 * throttle down, steering off the nearest pursuer. It does not use the map —
 * it will not duck into an alley, go under a bridge or swap cars, which is
 * how a person actually breaks line of sight. So above three stars nearly
 * every failed run is `caught` rather than `still wanted`, and what that
 * measures is the autopilot's driving, not whether the escape exists. The
 * mechanism itself is pinned by unit tests: the decay curve, the search
 * expiring, and the radio going quiet once the trail is cold.
 *
 * Not a test, because the honest form of both numbers is a distribution over
 * seeds and a test wants a threshold. Run it when the police numbers move.
 *
 *   pnpm chase                 # the shipped numbers
 *   pnpm chase --stars=5       # one level, more detail
 */

interface Args {
  stars: number[];
  seeds: number[];
  windowSec: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const list = (v: string | undefined, fallback: number[]): number[] =>
    v ? v.split(',').map((n) => Number.parseInt(n, 10)).filter(Number.isFinite) : fallback;
  return {
    stars: list(get('stars'), [3, 4, 5]),
    seeds: list(get('seeds'), [3, 11, 29, 47, 61]),
    windowSec: Number.parseInt(get('window') ?? '90', 10),
  };
}

/** A player who legs it: a zig-zag, which is what a fleeing player looks like. */
function fleeing(seq: number, i: number): InputIntent {
  return {
    ...NULL_INPUT,
    seq,
    tick: i,
    right: i % 240 < 120,
    left: i % 240 >= 120,
    up: i % 120 < 60,
    down: i % 120 >= 60,
  };
}

function spawn(map: CityMap, seed: number, heat: number): GameState {
  let state = createGameState(seed);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'runner' }], map);
  const p = state.players.byId[1];
  if (p) p.heat = heat;
  return state;
}

/**
 * Seconds until the heat reaches zero, or null if it never does.
 *
 * The heat is seeded once and then left alone — this is the escape, not a
 * spree. Dying would clear it for the wrong reason, so a death ends the run
 * as a failure rather than as an escape.
 *
 * In a car, because that is the escape the design is about: break line of
 * sight, take a corner, keep going. The first version of this bench ran the
 * same zig-zag `timeToDie` uses and reported 0 escapes out of 5 at every
 * level — correctly, and uselessly. A player jinking on the spot in the open
 * never breaks anybody's line of sight, and on foot they cannot: a patrolman
 * runs at 73 px/s against a walk of 78. Measuring an escape with an input
 * that cannot escape measures the input.
 */
type Escape = { at: number } | { failed: 'died' | 'still wanted'; heatLeft: number };

function timeToEscape(map: CityMap, seed: number, stars: number, windowSec: number): Escape {
  let state = spawn(map, seed, stars * 100 + 10);
  const me0 = state.players.byId[1];
  if (!me0) return { failed: 'died', heatLeft: 0 };
  // A car under the driver, and the door already open.
  state = step(
    state,
    {},
    [
      {
        type: 'spawnVehicle',
        vehicleId: 90_001,
        kind: 'car',
        x: me0.pos.x,
        y: me0.pos.y,
        heading: 0,
      },
    ],
    map,
  );
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);

  for (let i = 0; i < windowSec * 30; i++) {
    const me = state.players.byId[1];
    // Which kind of failure matters: "they caught me" and "I never got clear"
    // are different verdicts on the same escape, and a bare null hides it.
    if (!me) return { failed: 'died', heatLeft: 0 };
    if (me.mode === 'dead') return { failed: 'died', heatLeft: Math.round(me.heat) };
    if (me.heat === 0) return { at: i / 30 };
    // Drive AWAY from the nearest officer, rather than turning on a fixed
    // schedule. The scheduled version was the first draft and it flattered
    // nobody: every failed run was "caught", because an autopilot holding the
    // throttle down and turning every 2.3 seconds drives into things and gets
    // boxed in. Steering off the nearest pursuer is the crudest input that is
    // still recognisably fleeing, which is what the number is supposed to be
    // about.
    const car = me.vehicleId === null ? null : state.vehicles.byId[me.vehicleId];
    let steer = 0;
    if (car) {
      let near: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const cid of state.cops.ids) {
        const c = state.cops.byId[cid];
        if (!c || c.health <= 0) continue;
        const d = Math.hypot(c.pos.x - me.pos.x, c.pos.y - me.pos.y);
        if (d < bestD) {
          bestD = d;
          near = c.pos;
        }
      }
      if (near) {
        // Positive error = the pursuer is off to the left of the nose, so
        // turn right, and vice versa. Wrapped to (-pi, pi].
        const away = Math.atan2(me.pos.y - near.y, me.pos.x - near.x);
        const err = Math.atan2(Math.sin(away - car.heading), Math.cos(away - car.heading));
        steer = err > 0.2 ? 1 : err < -0.2 ? -1 : 0;
      } else {
        steer = Math.floor(i / 70) % 4 === 1 ? 1 : 0;
      }
    }
    state = step(
      state,
      {
        1: {
          ...NULL_INPUT,
          seq: i + 2,
          tick: i,
          up: true,
          left: steer < 0,
          right: steer > 0,
        },
      },
      [],
      map,
    );
  }
  const last = state.players.byId[1];
  return { failed: 'still wanted', heatLeft: Math.round(last?.heat ?? 0) };
}

/** Seconds until death at a pinned star level, or null if they outlast it. */
function timeToDie(
  map: CityMap,
  seed: number,
  stars: number,
  moving: boolean,
  windowSec: number,
): number | null {
  const heat = stars * 100 + 10;
  let state = spawn(map, seed, heat);
  for (let i = 0; i < windowSec * 30; i++) {
    const me = state.players.byId[1];
    if (!me) return null;
    if (me.mode === 'dead') return i / 30;
    // Pinned, so this measures lethality rather than the escape above.
    me.heat = Math.max(me.heat, heat);
    state = step(state, { 1: moving ? fleeing(i + 1, i) : { ...NULL_INPUT, seq: i + 1, tick: i } }, [], map);
  }
  return null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function show(v: number | null, windowSec: number): string {
  return v === null ? `${windowSec}+` : v.toFixed(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  loadSharedTuning(process.env['DIFFICULTY'] ?? 'normal');
  const map = generateCity(6006, loadWorldgenParams());

  console.log(`chase bench — ${args.seeds.length} seeds, ${args.windowSec}s window\n`);
  for (const stars of args.stars) {
    const escapes = args.seeds.map((s) => timeToEscape(map, s, stars, args.windowSec));
    const got = escapes.filter((e): e is { at: number } => 'at' in e).map((e) => e.at);
    const died = escapes.filter((e) => 'failed' in e && e.failed === 'died').length;
    const moving = args.seeds.map((s) => timeToDie(map, s, stars, true, args.windowSec));
    const still = args.seeds.map((s) => timeToDie(map, s, stars, false, args.windowSec));
    const alive = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
    console.log(
      `${stars} stars  escape ${got.length}/${args.seeds.length}` +
        (got.length > 0 ? ` in ${median(got).toFixed(1)}s` : '') +
        (died > 0 ? ` (${died} caught)` : '') +
        `  |  survive moving ${show(alive(moving).length === moving.length ? median(alive(moving)) : null, args.windowSec)}s` +
        `  still ${show(alive(still).length === still.length ? median(alive(still)) : null, args.windowSec)}s`,
    );
    console.log(
      `          escapes [${escapes
        .map((e) => ('at' in e ? e.at.toFixed(1) : e.failed === 'died' ? 'caught' : `${e.heatLeft}h`))
        .join(' ')}]` +
        `  moving [${moving.map((e) => show(e, args.windowSec)).join(' ')}]` +
        `  still [${still.map((e) => show(e, args.windowSec)).join(' ')}]`,
    );
  }
}

main();
