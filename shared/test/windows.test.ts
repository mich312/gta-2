import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { PAINT_VARIANTS } from '../src/world/amenities.js';

/**
 * THE infinite-world invariant: the world is a pure function of (seed,
 * global coordinate), and a window is a viewport onto it. Two overlapping
 * windows must therefore agree tile-for-tile in their shared interior.
 *
 * The rim is excluded: carving passes (shops, landmarks) skip footprints
 * not fully inside their own window, so within one arterial-cell span of a
 * window's edge the two views may differ. That is the documented edge
 * effect — confined to the rim by construction — and the margin below is
 * sized to it.
 */

const base = parseWorldgenParams(worldgenJson);

function windowAt(wx: number, wy: number): typeof base {
  return { ...base, windowX: wx, windowY: wy };
}

describe('windows onto the unbounded world', () => {
  it('overlapping windows agree tile-for-tile away from their rims', () => {
    for (const seed of [7, 1234]) {
      // 320-tile windows so the overlap interior survives the rim margins.
      const size = { widthTiles: 320, heightTiles: 320 };
      const a = generateCity(seed, { ...windowAt(0, 0), ...size });
      const b = generateCity(seed, { ...windowAt(96, 48), ...size });
      // Overlap in global tiles: [96, 320) × [48, 320). Margin: one full
      // cell span (a rim cell can reach that far inward) plus jitter.
      const margin = base.arterialSpacing + Math.ceil(base.arterialSpacing / 2);
      const gx0 = 96 + margin;
      const gy0 = 48 + margin;
      const gx1 = 320 - margin;
      const gy1 = 320 - margin;
      expect(gx1 - gx0).toBeGreaterThan(40); // the test actually tests something
      let checked = 0;
      for (let gy = gy0; gy < gy1; gy++) {
        for (let gx = gx0; gx < gx1; gx++) {
          const ta = a.tiles[gy * a.widthTiles + gx];
          const tb = b.tiles[(gy - 48) * b.widthTiles + (gx - 96)];
          if (ta !== tb) {
            // One expect per mismatch would drown the output; fail loudly
            // on the first with coordinates in the message.
            expect(
              `tile mismatch at global (${gx}, ${gy}): windowA=${ta} windowB=${tb}`,
            ).toBe('');
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });

  it('a window a million tiles out is still a city, generated at the same cost', () => {
    const far = generateCity(7, windowAt(1_000_128, -777_600));
    let roads = 0;
    for (const t of far.tiles) if (t === 1) roads++;
    expect(roads / far.tiles.length).toBeGreaterThan(0.05);
    expect(far.buildings.length).toBeGreaterThan(100);
    expect(far.playerSpawns.length).toBeGreaterThanOrEqual(8);
    // Coverage lattice holds anywhere in the world.
    expect(far.hospitals.length).toBeGreaterThan(0);
    expect(far.policeStations.length).toBeGreaterThan(0);
  });

  it('distant windows are different places, same seed', () => {
    const here = generateCity(42, windowAt(0, 0));
    const there = generateCity(42, windowAt(100_000, 100_000));
    expect(Buffer.from(here.tiles).equals(Buffer.from(there.tiles))).toBe(false);
  });

  it('negative coordinates are as good as positive ones', () => {
    const m = generateCity(99, windowAt(-5_000, -12_345));
    let buildings = 0;
    for (const t of m.tiles) if (t === 3) buildings++;
    expect(buildings).toBeGreaterThan(0);
    expect(m.hospitals.length).toBeGreaterThan(0);
  });

  /**
   * The street does not repaint itself when the window moves.
   *
   * A session that walks into the next region regenerates the map at a new
   * origin and reseeds the ambient world from it. Everything about a parked
   * car used to be decided by its position in that regeneration's scan order:
   * `PARKED_CYCLE[i % n]` for the model, `i % 7` for gang ownership, and the
   * spawn id — handed out in the same order — for the paint. None of those
   * survive the origin moving, so every parked car in sight changed model,
   * livery and colour at once, in front of the player, for no reason visible
   * in the world. It read as the terrain repainting the traffic.
   *
   * All three are facts about the KERB now, in global coordinates, exactly
   * like every other pure worldgen pass. Same guarantee, same rim exclusion.
   */
  it('the same kerb parks the same car, whichever window generates it', () => {
    const size = { widthTiles: 320, heightTiles: 320 };
    const a = generateCity(31, { ...windowAt(0, 0), ...size });
    const b = generateCity(31, { ...windowAt(96, 48), ...size });
    const margin = base.arterialSpacing + Math.ceil(base.arterialSpacing / 2);

    // The rectangle both windows can speak for: their overlap, minus each
    // one's rim. In GLOBAL tiles.
    const gx0 = 96 + margin;
    const gy0 = 48 + margin;
    const gx1 = 320 - margin;
    const gy1 = 320 - margin;

    /** Parked cars inside that rectangle, keyed by global tile. */
    const inside = (
      m: typeof a,
      wx: number,
      wy: number,
    ): Map<string, string> => {
      const out = new Map<string, string>();
      for (const s of m.parkingSpots) {
        const gx = wx + Math.floor(s.x / 16);
        const gy = wy + Math.floor(s.y / 16);
        if (gx < gx0 || gy < gy0 || gx >= gx1 || gy >= gy1) continue;
        // Kind and paint. NOT `gangId`: which gang holds a given block is
        // decided by `assignTurf`, whose home points are placed relative to
        // the WINDOW centre and are window-scoped by construction (see
        // generate.ts's list of session furniture). A car that belongs to a
        // gang can therefore change livery when the window moves, and it
        // legitimately should — the ground under it changed hands. That is a
        // separate, larger piece of work: making territory a property of the
        // unbounded world rather than of the viewport.
        out.set(`${gx},${gy}`, `${s.kind}/${String(s.paint)}`);
      }
      return out;
    };

    const inA = inside(a, 0, 0);
    const inB = inside(b, 96, 48);
    // Same kerbs occupied — not merely "the ones both happen to have agree",
    // which would pass with the two windows parking nothing in common.
    expect([...inA.keys()].sort().join(' ')).toBe([...inB.keys()].sort().join(' '));
    for (const [tile, car] of inA) {
      expect(`${tile}: ${car}`).toBe(`${tile}: ${String(inB.get(tile))}`);
    }
    // If the shared rectangle were empty this would all pass vacuously.
    expect(inA.size).toBeGreaterThan(20);
  });

  it('every parked car is painted, and the paint spreads over the range', () => {
    // A colour that is always 0 would satisfy the test above and repaint
    // nothing — and would also turn the city monochrome.
    const m = generateCity(31, windowAt(0, 0));
    const seen = new Set<number>();
    for (const s of m.parkingSpots) {
      expect(s.paint).toBeGreaterThanOrEqual(0);
      expect(s.paint).toBeLessThan(PAINT_VARIANTS); // the sheet's body colours
      seen.add(s.paint as number);
    }
    expect(m.parkingSpots.length).toBeGreaterThan(50);
    expect(seen.size).toBeGreaterThan(PAINT_VARIANTS / 2);
  });
});
