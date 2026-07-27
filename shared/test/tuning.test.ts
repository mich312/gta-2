import { afterEach, describe, expect, it } from 'vitest';
import playerJson from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import trafficJson from '../data/traffic.json';
import { getTrafficTuning, getTuning, initTuning } from '../src/tuning.js';

/**
 * The tuning files are loaded two very different ways, and the difference
 * matters: the server reads its own disk at boot and should refuse to start on
 * a malformed file, while the client is handed the same data over the wire by
 * a server it does not control. One unparseable number there used to throw
 * inside the welcome handler, killing the frame loop and leaving the game on
 * "connecting…" for ever — with the reason only in the console.
 */
afterEach(() => {
  // Leave the module in a sane state for whatever runs next in this file.
  initTuning({ player: playerJson, vehicles: vehiclesJson, traffic: trafficJson });
});

describe('tuning', () => {
  it('rejects a malformed file outright by default', () => {
    expect(() =>
      initTuning({
        player: playerJson,
        vehicles: vehiclesJson,
        traffic: { ...trafficJson, turnSpeed: undefined },
      }),
    ).toThrow(/traffic.turnSpeed/);
  });

  it('leniently falls back per section, and says which', () => {
    const fellBack = initTuning(
      {
        player: playerJson,
        vehicles: vehiclesJson,
        // A server built before `turnSpeed` existed sends exactly this.
        traffic: { ...trafficJson, turnSpeed: undefined },
      },
      { lenient: true },
    );
    expect(fellBack).toEqual(['traffic']);
    // The bad section fell back to the built-in default...
    expect(getTrafficTuning().turnSpeed).toBeGreaterThan(0);
    // ...and everything else still came from the server.
    expect(getTuning().player.walkSpeed).toBe(playerJson.walkSpeed);
    expect(getTuning().vehicles['car']?.maxSpeed).toBe(vehiclesJson.car.maxSpeed);
  });

  it('reports nothing when the data is good', () => {
    expect(
      initTuning(
        { player: playerJson, vehicles: vehiclesJson, traffic: trafficJson },
        { lenient: true },
      ),
    ).toEqual([]);
  });
});
