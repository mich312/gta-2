import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dSin, dCos, dAtan2, wrapAngle, PI, TWO_PI } from '../src/math/trig.js';

// Tests may reference Math trig — the rule is only that SIM code never does.
describe('deterministic trig', () => {
  it('dSin matches Math.sin within 1e-6 across many revolutions', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.037;
      expect(Math.abs(dSin(x) - Math.sin(x))).toBeLessThan(1e-6);
    }
  });

  it('dCos matches Math.cos within 1e-6', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i * 0.041;
      expect(Math.abs(dCos(x) - Math.cos(x))).toBeLessThan(1e-6);
    }
  });

  it('dAtan2 matches Math.atan2 within 1e-4 in all quadrants', () => {
    const vals = [-10, -2, -1, -0.5, -0.01, 0, 0.01, 0.5, 1, 2, 10];
    for (const y of vals) {
      for (const x of vals) {
        if (x === 0 && y === 0) continue;
        expect(Math.abs(dAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-4);
      }
    }
    expect(dAtan2(0, 0)).toBe(0);
  });

  it('wrapAngle lands in [-PI, PI)', () => {
    for (let i = -100; i <= 100; i++) {
      const w = wrapAngle(i * 1.7);
      expect(w).toBeGreaterThanOrEqual(-PI);
      expect(w).toBeLessThan(PI);
      // wrapped angle is equivalent modulo 2*PI
      const k = (i * 1.7 - w) / TWO_PI;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
  });
});

/**
 * The rule `math/trig.ts` states in its own header, enforced.
 *
 * "Sim code must never call Math trig directly": ECMA-262 pins `Math.sqrt` to
 * the exactly rounded result and leaves `sin`, `cos`, `atan2`, `hypot`, `pow`,
 * `exp` and `log` approximated, so two conforming engines may return values a
 * bit apart. `step()` has to be bit-identical on every host (ROADMAP.md §0,
 * invariant 1; `ci/hostParity.mjs` is the gate), and these values reach hashed
 * fields — `cop.health` through the shield verdict, `ped.dirX`/`dirY` through
 * the carjack door — which `snapshot.ts` ships with no rounding.
 *
 * WORLDGEN.md §41.5 records exactly this defect found and fixed in worldgen;
 * the sweep never reached `shared/src/sim`, where five files had picked up
 * thirteen unpinned calls that nothing was watching for. This is what watches.
 *
 * Scanned rather than listed, for the reason `server/test/portable.test.ts`
 * walks its import graph rather than keeping a roster: a list goes stale the
 * first time somebody adds a file, and silently.
 */
describe('the trig rule holds in sim code', () => {
  const SIM = fileURLToPath(new URL('../src/sim/', import.meta.url));
  // `sqrt`, `abs`, `floor`, `round`, `min`, `max`, `sign`, `trunc` and integer
  // arithmetic are all exactly specified, so they are not on this list.
  const BANNED = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|log|log2|log10|cbrt|sinh|cosh|tanh|expm1|log1p|fround|random)\s*\(/;

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no unpinned Math call reaches a simulated value', () => {
    const offences: string[] = [];
    for (const file of sources(SIM)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Prose is allowed to name the thing it is banning, and every one of
        // these sites carries a comment saying why the pinned form is there.
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(line)) return;
        if (BANNED.test(code)) offences.push(`${relative(SIM, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offences, `unpinned Math in sim code:\n${offences.join('\n')}`).toEqual([]);
  });
});

/**
 * The same rule, for worldgen — but measured, not scanned.
 *
 * `shared/src/world` cannot take the source gate above. Ninety-seven Math trig
 * calls live there and only EIGHT of them run when somebody plays: the rest
 * belong to `citybake` and `plangen`, which run once on one machine and ship
 * their answer as bytes (`city.data.ts`), and to the 3D renderer, which is not
 * in the lockstep contract. Banning them all would mean re-baking the city to
 * satisfy a rule that cannot reach it.
 *
 * What matters is narrower and sharper: `generateCity` runs on BOTH hosts at
 * runtime. The server calls it (`session.ts:243`) and so does every browser —
 * "the whole city regenerates locally from the seed" (`main.ts:650`,
 * `three/live.ts:127`). Only the GROUND is shipped bytes; the FURNITURE —
 * parked cars, ped spawns, props, moorings, gang turf — is derived per session
 * on each host, and `parkingSpot.heading` becomes `vehicle.heading`, which
 * `snapshot.ts` ships and `hashState` hashes.
 *
 * So the check runs the function and counts, rather than reading the files.
 * A roster of "the files that matter" goes stale the first time somebody moves
 * a pass; an import-graph walk over-approximates (`buildings.ts` is imported
 * and its trig never executes). Counting cannot do either.
 *
 * What this caught: `placeParking` decided which way a car faces with
 * `Math.sin(a) > 0` at `a === PI`, where `Math.sin` returns 1.2246e-16 — the
 * residue of PI's own float representation, whose sign ECMA-262 does not pin.
 * One parked car per city faced the opposite way depending on the engine.
 */
describe('the trig rule holds on the path both hosts run', () => {
  const PINNED = [
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'hypot', 'pow',
    'exp', 'log', 'log2', 'log10', 'cbrt', 'sinh', 'cosh', 'tanh', 'expm1',
    'log1p', 'fround', 'random',
  ] as const;

  it('generateCity calls no unpinned Math function', async () => {
    const { generateCity } = await import('../src/world/generate.js');
    const { parseWorldgenParams } = await import('../src/world/params.js');
    const worldgen = parseWorldgenParams(
      JSON.parse(
        readFileSync(fileURLToPath(new URL('../data/worldgen.json', import.meta.url)), 'utf8'),
      ),
    );
    // Two seeds and both `provingGround` settings: the furniture passes are
    // the same code at every seed, and the census that found these eight
    // sites reported the identical set at all eight seeds it sampled. More
    // seeds bought nothing and cost a second of the suite each.
    const seeds = [1, 6006];

    // Warm the decode cache first: the one-time `decodeBakedCity` is not the
    // subject, and counting it would make the first seed differ from the rest.
    generateCity(1, worldgen);

    const M = Math as unknown as Record<string, (...a: number[]) => number>;
    function withCounters(record: (name: string) => void, body: () => void): void {
      const saved = new Map<string, (...a: number[]) => number>();
      for (const name of PINNED) {
        const orig = M[name] as (...a: number[]) => number;
        saved.set(name, orig);
        M[name] = (...args: number[]): number => {
          record(name);
          return orig(...args);
        };
      }
      try {
        body();
      } finally {
        for (const [name, fn] of saved) M[name] = fn;
      }
    }

    const run = (): void => {
      for (const seed of seeds) {
        generateCity(seed, worldgen);
        generateCity(seed, { ...worldgen, provingGround: true });
      }
    };

    // Pass one is a bare tally — no stack walk, so the green path costs
    // nothing. Only a failing run pays for the second pass, which is the one
    // that says WHERE: a report of "cos, 44028 times" is not actionable, and
    // capturing a stack on every call made the passing test three times
    // slower for a string nobody reads.
    let fired = false;
    withCounters(() => {
      fired = true;
    }, run);

    const seen = new Map<string, number>();
    if (fired) {
      withCounters(
        (name) => {
          const frame = (new Error().stack ?? '').split('\n')[3]?.trim() ?? 'unknown';
          const key = `Math.${name} @ ${frame}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        },
        run,
      );
    }

    const offences = [...seen.entries()].map(([k, n]) => `${n}x ${k}`).sort();
    expect(
      offences,
      `unpinned Math on the runtime worldgen path:\n${offences.join('\n')}`,
    ).toEqual([]);
  });
});
