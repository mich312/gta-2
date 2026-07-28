import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import {
  type FullSnapshot,
  type VehicleState,
  createVehicle,
  initTuning,
} from 'shared';
import { INTERP_DELAY_TICKS, Interpolator } from '../src/net/interpolation.js';

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
});

/** A snapshot with one car at `x`, travelling along +x. */
function snapAt(tick: number, x: number): FullSnapshot {
  const v: VehicleState = createVehicle(1, 'car', { x, y: 100 }, 0);
  v.speed = 200;
  return {
    tick,
    players: [],
    vehicles: [v],
    cops: [],
    peds: [],
    props: [],
    pickups: [],
    projectiles: [],
  };
}

describe('what you collide with is what you can see', () => {
  it('the predictor world sits on the render timeline, not the wire timeline', () => {
    // Remote entities are DRAWN ~100 ms in the past so they interpolate
    // smoothly. Collision prediction used to read the newest snapshot
    // instead, which put every moving car's collider up to three ticks ahead
    // of its own sprite — over half a car length at road speed, and a whole
    // car at a closing speed. You crashed into empty tarmac and drove through
    // the car in front of you.
    const interp = new Interpolator();
    const speedPerTick = 200 / 30;
    // A snapshot a tick and a frame a tick, as it runs in the game: the
    // render clock settles INTERP_DELAY_TICKS behind the head of the buffer.
    for (let t = 0; t <= 40; t++) {
      interp.push(snapAt(t, 100 + t * speedPerTick));
      interp.advance(1000 / 30);
    }

    const drawn = interp.sample(-1, null).vehicles;
    const collided = interp.vehiclesAsDrawn();
    expect(drawn.length).toBe(1);
    expect(collided.length).toBe(1);
    // Same object, same place, same heading — to the pixel.
    expect(collided[0]!.pos.x).toBe(drawn[0]!.x);
    expect(collided[0]!.pos.y).toBe(drawn[0]!.y);
    expect(collided[0]!.heading).toBe(drawn[0]!.heading);
    expect(collided[0]!.id).toBe(1);

    // ...and demonstrably NOT where the newest snapshot puts it: the wire
    // timeline is a couple of ticks — over half a car — further down the road.
    const newest = 100 + 40 * speedPerTick;
    const gap = newest - collided[0]!.pos.x;
    expect(gap).toBeGreaterThan(speedPerTick);
    expect(gap).toBeLessThanOrEqual(speedPerTick * INTERP_DELAY_TICKS + 0.001);
  });

  it('a parked car is in the same place on both timelines', () => {
    // The common case, and the reason predicting against the raw snapshot
    // looked fine for so long: most of what you hit never moved.
    const interp = new Interpolator();
    for (let t = 0; t <= 20; t++) {
      interp.push(snapAt(t, 250));
      interp.advance(1000 / 30);
    }
    expect(interp.vehiclesAsDrawn()[0]!.pos.x).toBe(250);
  });

  it('hands out copies, not the snapshot rows themselves', () => {
    // The predictor SHOVES the car it hits. Handing it the live snapshot
    // rows would move the cars the renderer and the interpolator are reading.
    const interp = new Interpolator();
    const snap = snapAt(0, 300);
    interp.push(snap);
    interp.advance(1000 / 30);
    const mine = interp.vehiclesAsDrawn()[0]!;
    mine.pos.x = -999;
    mine.zones[0] = 42;
    expect(snap.vehicles[0]!.pos.x).toBe(300);
    expect(snap.vehicles[0]!.zones[0]).toBe(0);
  });
});
