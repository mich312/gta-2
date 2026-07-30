import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import worldgenJson from '../../shared/data/worldgen.json';
import { type InputIntent, NULL_INPUT, initTuning, parseWorldgenParams } from 'shared';
import { Session } from '../src/session.js';

const worldgen = parseWorldgenParams(worldgenJson);

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

/**
 * A client that cannot render fast is not a client that has gone away.
 *
 * A client emits one intent per tick it simulates, and a slow one simulates
 * fewer than the wall clock has: at about 1.4 frames a second it sends an
 * intent roughly every twenty-one ticks while the world runs at thirty. The
 * server holds the last input across the gap so movement does not stutter — but
 * that hold was a fixed six ticks, chosen against network jitter, so ten ticks
 * in every twenty-one had no input at all and the player moved in slow motion
 * while the city carried on around them at full speed.
 *
 * It is worth stating what that cost, because it is not "fewer frames": every
 * threshold in the game is a speed. `WALL_HIT_MIN_SPEED` is 54,
 * `CAR_HIT_MIN_SPEED` 36, `RUNOVER_MIN_SPEED` 24, `SKID_MIN_SPEED` 170. A
 * player below all of them cannot crash a car, lay a skid mark or run anybody
 * over, however long they hold the key down.
 */

function holdRight(seq: number, tick: number): InputIntent {
  return { ...NULL_INPUT, seq, tick, right: true };
}

/** Walk east for `ticks`, sending an intent only every `every` ticks. */
function distanceEast(every: number, ticks: number): number {
  const session = new Session(4242, worldgen);
  const slot = session.addPlayer('slow', 'tok-slow');
  // A player joins on the first tick, so there is nothing to measure until one
  // has run.
  session.tick();
  const start = session.state.players.byId[slot.playerId]!.pos.x;
  let seq = 1;
  for (let t = 2; t <= ticks + 1; t++) {
    if ((t - 2) % every === 0) session.queueInput(slot.playerId, t - 1, [holdRight(seq++, t)]);
    session.tick();
  }
  return session.state.players.byId[slot.playerId]!.pos.x - start;
}

describe('a client that renders slowly still plays at full speed', () => {
  it('keeps a sparse sender moving nearly as far as a fast one', () => {
    // Every tick: what a machine comfortably making 30 fps sends.
    const fast = distanceEast(1, 120);
    // Every 21st tick: what ~1.4 fps sends, measured on a GPU-less box.
    const slow = distanceEast(21, 120);

    expect(fast).toBeGreaterThan(50);
    // 0.38 before the hold learned the client's cadence; 0.82 after.
    //
    // Not 1.0, and the shortfall is honest rather than tunable: the estimator
    // has not seen a gap until the first one has ended, so that first gap is
    // still covered at the old fixed six ticks, and on foot there is an
    // acceleration ramp at the start of each held run. Over a longer session
    // the first gap stops mattering. What the threshold is guarding is the
    // difference between "slightly behind" and "cannot reach any speed
    // threshold in the game".
    expect(slow / fast).toBeGreaterThan(0.75);
  });

  it('still stops a client that has genuinely gone quiet', () => {
    // One intent, then silence for four seconds. The hold is bounded, so the
    // player must not coast onward for the whole of it.
    const session = new Session(4242, worldgen);
    const slot = session.addPlayer('gone', 'tok-gone');
    session.tick();
    const start = session.state.players.byId[slot.playerId]!.pos.x;
    session.queueInput(slot.playerId, 1, [holdRight(1, 2)]);
    for (let t = 2; t <= 121; t++) session.tick();
    const coasted = session.state.players.byId[slot.playerId]!.pos.x - start;

    // Well under what four seconds of held input would cover.
    expect(coasted).toBeLessThan(distanceEast(1, 120) * 0.5);
  });
});
