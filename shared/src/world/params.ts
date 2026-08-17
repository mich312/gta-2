/**
 * Session parameters for the world.
 *
 * These used to decide what the city WAS: how far apart the arterials ran,
 * how big a downtown block got, where the noise put a river, and which
 * WINDOW onto an unbounded plane this session had opened. None of that is a
 * number any more — the city is drawn in `shared/data/city-plan.json` and
 * baked, once, into the bytes both hosts load. What is left here is what a
 * session is entitled to vary on top of a fixed map: how thickly the kerbs
 * are parked up, how many spawn points there are, how long a day lasts, how
 * much ground a gang holds.
 *
 * Lives in shared/data/worldgen.json; the server loads the file and ships the
 * parsed params to clients in the welcome message, so both sides always agree
 * even if the server's JSON was tuned after the client bundle was built.
 */
export interface WorldgenParams {
  /**
   * Put a proving ground in the city: one room, near the first player spawn,
   * that hands out vehicles and kit for free so a change can be driven at
   * rather than only argued about.
   *
   * A worldgen parameter and not a server flag, because the client dresses
   * the map itself from these — a server-side-only toggle would have the two
   * hosts disagreeing about what is a wall. Placed dead last and with no
   * random draw, so turning it on changes nothing else about the city.
   */
  provingGround: boolean;
  /** Roughly one parked car every N road-edge tiles. */
  parkedCarSpacing: number;
  playerSpawnCount: number;
  playerSpawnMinDist: number;
  /**
   * Gang territory. Lives here rather than in gangs.json because worldgen
   * must not depend on runtime tuning being initialised — several tests
   * generate a city at module scope, before any initTuning() has run. The
   * gangs' names, colours and rivalries stay in gangs.json, where the sim
   * reads them.
   */
  turf: {
    cellTiles: number;
    gangCount: number;
    /**
     * Where each gang's manor is anchored, in tiles. Authored, because which
     * gang holds the docks is a design decision and not something a formula
     * knows: the partition below grows outward from these over dry land, so
     * moving a manor is moving one pair of numbers.
     *
     * Empty means "spread them on a ring", which is what this did before it
     * had ever looked at the map, and is still the only thing available to a
     * city whose shape nobody has seen (`plangen`'s, a fixture's).
     */
    homes: Array<{ gang: number; x: number; y: number }>;
  };
  /**
   * Seconds in an in-game day. Here rather than in a tuning file for the same
   * reason as `turf`: it ships in the welcome message alongside the seed, so
   * the client's clock and the server's are the same function of the tick
   * without a second thing to keep in step.
   */
  dayLengthSec: number;
  /** How much of the daytime crowd is out at the dead of night. */
  nightCrowdScale: number;
  /** Hidden packages per city. See amenities.placePackages. */
  packageCount: number;
}

function parseTurf(raw: unknown): WorldgenParams['turf'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const count = num(r['gangCount'], 'turf.gangCount');
  const homes: WorldgenParams['turf']['homes'] = [];
  const list = r['homes'];
  if (Array.isArray(list)) {
    for (const [i, entry] of list.entries()) {
      const h = (entry ?? {}) as Record<string, unknown>;
      const gang = num(h['gang'], `turf.homes[${i}].gang`);
      if (gang > count) {
        throw new Error(`worldgen: turf.homes[${i}].gang is ${gang}, above gangCount ${count}`);
      }
      if (homes.some((o) => o.gang === gang)) {
        throw new Error(`worldgen: turf.homes has two manors for gang ${gang}`);
      }
      homes.push({
        gang,
        x: num(h['x'], `turf.homes[${i}].x`),
        y: num(h['y'], `turf.homes[${i}].y`),
      });
    }
  }
  // All of them or none: a partition grown from four anchors with seven gangs
  // in the tuning leaves three gangs holding nothing, and the failure shows up
  // as a missing colour on the radar rather than as an error.
  if (homes.length > 0 && homes.length !== count) {
    throw new Error(`worldgen: turf.homes has ${homes.length} manors for ${count} gangs`);
  }
  return { cellTiles: num(r['cellTiles'], 'turf.cellTiles'), gangCount: count, homes };
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`worldgen: ${name} must be a positive finite number`);
  }
  return v;
}

export function parseWorldgenParams(raw: unknown): WorldgenParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    // Optional and default off: replay headers written before it existed
    // still parse, and a session only gets one by asking.
    provingGround: r['provingGround'] === true,
    parkedCarSpacing: num(r['parkedCarSpacing'], 'parkedCarSpacing'),
    turf: parseTurf(r['turf']),
    // Defaulted rather than required: an older worldgen block (a replay
    // header, a saved config) must still parse, and a city with no clock is
    // simply the fixed-dusk city this one used to be.
    dayLengthSec:
      typeof r['dayLengthSec'] === 'number' && r['dayLengthSec'] > 0 ? r['dayLengthSec'] : 1440,
    nightCrowdScale:
      typeof r['nightCrowdScale'] === 'number' &&
      r['nightCrowdScale'] > 0 &&
      r['nightCrowdScale'] <= 1
        ? r['nightCrowdScale']
        : 0.55,
    packageCount:
      typeof r['packageCount'] === 'number' && r['packageCount'] >= 0 ? r['packageCount'] : 100,
    playerSpawnCount: num(r['playerSpawnCount'], 'playerSpawnCount'),
    playerSpawnMinDist: num(r['playerSpawnMinDist'], 'playerSpawnMinDist'),
  };
}
