import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CITY_DATA, decodeBakedCity, T_BRIDGE, T_RAMP, T_ROAD, type StreetCourse } from 'shared';

/**
 * `street-serves-nothing` asks the ground, not the course record (iteration 12).
 *
 * The signature looks for a short street that is a cul-de-sac at BOTH ends. Its
 * end test used to be `tarmacBeyond` alone: march the STRAIGHT extension of the
 * course's last segment and call the end a cap if the carriageway runs out
 * within four tiles. On a map whose streets bend that measures where the RAY
 * leaves the road, not where the ROAD stops — and every one of the five findings
 * it carried on the iteration-11 bake was that mistake:
 *
 *     street-serves-nothing  453,351,32   11.7-tile street from 469,361 to 469,373
 *     street-serves-nothing  244,552,32   11.8-tile street from 254,568 to 266,568
 *     street-serves-nothing  70,490,32    11.9-tile street from 80,505 to 91,508
 *     street-serves-nothing  645,142,40   19.9-tile street from 669,153 to 660,171
 *     street-serves-nothing  687,271,40   19.9-tile street from 711,282 to 704,301
 *
 * Iteration 10 had left this signature open on purpose: its population probe
 * concluded "the detector flags 5 of 44 indistinguishable short fragments
 * (11.4%)" and its own control then refused that conclusion —
 *
 *     courses with ZERO joining tarmac anywhere:      0
 *     => the measure NEVER reads zero — BROKEN, it cannot discriminate
 *
 * — because the measure counted a course's own end-cap paint as tarmac joining
 * it. Recomputed strictly, 4 of the 44 meet no other baked COURSE at either end
 * (`evidence/iter12-streets/population-strict.txt`), which points the opposite
 * way; but that measure has its own blind spot, because most of this map's
 * street tarmac is carved from the block grid and belongs to no course at all.
 * The measure with neither flaw is the one below: flood the carriageway from an
 * endpoint and count what you reach. Under it NONE of the courses in the
 * detector's length window is terminal at both ends, and each of the five above
 * has an end opening onto hundreds of tiles of other road.
 *
 * Both halves are asserted here. The first would fail on the pre-fix tool; the
 * second would fail if a future round changed the MAP so that one of these five
 * really did become an island, which is the reversal the first cannot see.
 */
describe('street-serves-nothing', () => {
  const cli = fileURLToPath(new URL('../dist/tools/mapAudit.js', import.meta.url));
  const audit = (...args: string[]): string => {
    expect(existsSync(cli), `${cli} is missing — run \`pnpm build\` first`).toBe(true);
    return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  };

  it('reports nothing on the shipped bake, where the pre-fix ray reported five', () => {
    const out = audit('--only=street-serves-nothing', '--all');
    const row = out.split('\n').find((l) => /^#\s+street-serves-nothing\s/.test(l));
    expect(row, 'no summary row for the signature').toBeTruthy();
    // `# street-serves-nothing         0        0        0.0        0.0  noisy`
    const cells = (row as string).replace(/^#\s*/, '').trim().split(/\s+/);
    expect(cells[0], `${row}`).toBe('street-serves-nothing');
    const n = Number(cells[1]);
    expect(Number.isFinite(n), `could not read a count out of: ${row}`).toBe(true);
    expect(n, `${row}`).toBe(0);
    expect(out.split('\n').filter((l) => l.startsWith('street-serves-nothing')).length).toBe(0);
  });

  it('still fires on a street planted in open field, so it was narrowed and not switched off', () => {
    // `--selftest` plants a 3-wide, 13-long carriageway with a course down it in
    // a meadow at least 300 tiles from anything, and that IS the defect this
    // signature exists to find. A gate that silenced the shipped map by
    // silencing the signature would show up right here.
    let out = '';
    try {
      out = audit('--selftest');
    } catch (e) {
      // --selftest exits non-zero while `shore-staircase`'s plant is silent,
      // which predates iteration 12 and is not what this test is about.
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    const row = out.split('\n').find((l) => l.includes('street-serves-nothing') && /FIRED|SILENT/.test(l));
    expect(row, 'the selftest printed no line for this signature').toBeTruthy();
    expect(row as string).toContain('FIRED');
    expect(row as string).toMatch(/0 -> 1/);
  });

  it('has no street on the shipped map with a cul-de-sac at both ends', { timeout: 60_000 }, () => {
    // The measurement the tool now makes, made again here independently of the
    // tool, so this stays true if someone re-tunes the gate — and goes red if a
    // rebake ever strands one of these streets for real.
    const city = decodeBakedCity(JSON.parse(CITY_DATA));
    const W = city.widthTiles;
    const H = city.heightTiles;
    const isRoad = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const t = city.tiles[y * W + x] as number;
      return t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
    };
    const len = (c: StreetCourse): number => {
      let l = 0;
      for (let k = 1; k < c.points.length; k++) {
        const [ax, ay] = c.points[k - 1] as readonly [number, number];
        const [bx, by] = c.points[k] as readonly [number, number];
        l += Math.hypot(bx - ax, by - ay);
      }
      return l;
    };
    /**
     * Carriageway reachable within 60 steps of one end that is not this street's
     * own paint. Walking the street's own band is allowed only within six tiles
     * of the end being tested, so the flood may step sideways off the cap but
     * cannot drive out of the far end.
     */
    const escape = (c: StreetCourse, fromStart: boolean): number => {
      const pts = c.points;
      const half = c.width / 2 + 0.5;
      const total = len(c);
      const D = Math.min(total / 2, 6);
      const end = (fromStart ? pts[0] : pts[pts.length - 1]) as readonly [number, number];
      const kind = (x: number, y: number): boolean | null => {
        if (!isRoad(x, y)) return null;
        let best = Infinity;
        let arc = 0;
        let acc = 0;
        for (let k = 0; k + 1 < pts.length; k++) {
          const [ax, ay] = pts[k] as readonly [number, number];
          const [bx, by] = pts[k + 1] as readonly [number, number];
          const dx = bx - ax;
          const dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const seg = Math.sqrt(l2);
          let t = l2 === 0 ? 0 : ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(ax + dx * t - x - 0.5, ay + dy * t - y - 0.5);
          if (d < best) {
            best = d;
            arc = acc + seg * t;
          }
          acc += seg;
        }
        if (best > half) return true;
        return (fromStart ? arc : total - arc) <= D ? false : null;
      };
      const seen = new Set<number>();
      let frontier: Array<[number, number]> = [];
      const ex = Math.round(end[0]);
      const ey = Math.round(end[1]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = ex + dx;
          const y = ey + dy;
          if (kind(x, y) === null) continue;
          const k = y * W + x;
          if (!seen.has(k)) {
            seen.add(k);
            frontier.push([x, y]);
          }
        }
      }
      let out = 0;
      for (let step = 0; step < 60 && frontier.length > 0; step++) {
        const next: Array<[number, number]> = [];
        for (const [x, y] of frontier) {
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            const k = ny * W + nx;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k)) continue;
            const t = kind(nx, ny);
            if (t === null) continue;
            seen.add(k);
            next.push([nx, ny]);
            if (t) out++;
            if (out > 4000) return out;
          }
        }
        frontier = next;
      }
      return out;
    };

    const roads = (city.courses ?? []).filter((c) => c.kind !== 'path');
    expect(roads.length, 'no road courses in the bake').toBeGreaterThan(300);

    // CONTROL, and it is the point of the whole exercise: this measure has to be
    // able to read BOTH ways, or "no cul-de-sacs" means nothing. #298 supplies
    // both readings from ONE street. Its east end stops two tiles short of the
    // ring — the ring shave, WORLDGEN.md §14.3 D6, which `road-stops-short`
    // settled in iteration 9 — and reads terminal. Its west end runs into the
    // street at x=253-255 and reads open. Iteration 10's measure could produce
    // no zero anywhere on the map; this one produces a zero and a 656 on the
    // same course.
    const control = roads.find(
      (c) => Math.round(c.points[0][0]) === 254 && Math.round(c.points[0][1] as number) === 568,
    );
    expect(control, 'the control street at 254,568 is gone from the bake').toBeTruthy();
    expect(escape(control as StreetCourse, false), 'east end, capped by the ring shave').toBeLessThanOrEqual(20);
    expect(escape(control as StreetCourse, true), 'west end, into the street at x=253-255').toBeGreaterThan(100);

    const stranded: string[] = [];
    for (const c of roads) {
      const L = len(c);
      if (L < 4 || L >= 20) continue;
      const a = escape(c, true);
      const b = escape(c, false);
      if (a <= 20 && b <= 20) {
        const [px, py] = c.points[0] as readonly [number, number];
        const [qx, qy] = c.points[c.points.length - 1] as readonly [number, number];
        stranded.push(`${px.toFixed(0)},${py.toFixed(0)}->${qx.toFixed(0)},${qy.toFixed(0)} escape ${a}/${b}`);
      }
    }
    expect(stranded, `${stranded.length} street(s) with nowhere to go at either end`).toEqual([]);
  });
});
