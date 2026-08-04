import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import { initTuning } from '../src/tuning.js';
import {
  createCop,
  createPed,
  createPickup,
  createPlayer,
  createProjectile,
  createProp,
  createVehicle,
} from '../src/sim/state.js';
import { applyDelta, diffSnapshots, type FullSnapshot } from '../src/net/snapshot.js';
import { hashSnapshot } from '../src/net/hash.js';

/**
 * The rule the field lists keep breaking, as a test rather than as a comment.
 *
 * `snapshot.ts` carries an explicit field list per table, `hash.ts` carries an
 * explicit list of what goes into the desync hash, and the two are maintained
 * by hand in different files. A field the hash reads and the diff does not is
 * a silent, permanent desync: the server's value changes, the delta says
 * nothing, the client's copy stays at whatever the last FULL snapshot carried,
 * and every hashed snapshot after that disagrees. It looks correct on the
 * frame a player joins and is wrong for the rest of the session.
 *
 * It has now happened three times — `airDist`, then `climb`/`liftHeld`, then
 * `escortOf`, which also cost the escort mission the marker over the person
 * you were sent to protect, since both renderers draw it off that field. Each
 * time the repair was one line in a list and each time the next omission was
 * invisible until somebody went looking.
 *
 * So this does not check a list against a list — it checks the property the
 * lists exist for. Perturb one field of one entity; if that moved the hash,
 * the delta must name the entity, and applying the delta must reproduce the
 * hash. Any future field, on any table, is covered the moment it is added to
 * the state, because the walk is over `Object.keys`.
 */

/** A representative entity per table, with every field populated. */
function fixtures(): FullSnapshot {
  const player = createPlayer(1, 'a', { x: 100, y: 100 });
  const vehicle = createVehicle(2, 'car', { x: 120, y: 100 }, 0);
  const cop = createCop(3, { x: 140, y: 100 }, 100);
  const ped = createPed(4, { x: 160, y: 100 }, 30);
  const prop = createProp(5, 'lamp', { x: 180, y: 100 }, 0);
  const pickup = createPickup(6, 'health', { x: 200, y: 100 });
  const projectile = createProjectile(7, 1, { x: 220, y: 100 }, { x: 1, y: 0 }, 'rocket');
  return {
    tick: 10,
    players: [player],
    vehicles: [vehicle],
    cops: [cop],
    peds: [ped],
    props: [prop],
    pickups: [pickup],
    projectiles: [projectile],
  };
}

/**
 * Move a value to a different one of the same shape.
 *
 * Returns undefined for anything this cannot meaningfully perturb, which the
 * caller skips — a field it cannot move is a field it cannot test.
 */
function perturb(v: unknown): unknown {
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') return v === 'zzz' ? 'yyy' : 'zzz';
  if (v === null) return 1;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined; // nothing in it to move
    const out = v.slice();
    const first = perturb(out[0]);
    if (first === undefined) return undefined;
    out[0] = first;
    return out;
  }
  if (typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const k of Object.keys(src)) {
      const moved = perturb(src[k]);
      if (moved !== undefined) {
        out[k] = moved;
        return out;
      }
    }
    return undefined;
  }
  return undefined;
}

type TableName = keyof Omit<FullSnapshot, 'tick'>;
const TABLES: TableName[] = [
  'players',
  'vehicles',
  'cops',
  'peds',
  'props',
  'pickups',
  'projectiles',
];

describe('every hashed field is a diffed field', () => {
  beforeAll(() => {
    initTuning({ player: playerTuning, vehicles: vehiclesJson });
  });

  it('carries any change the desync hash can see', () => {
    const base = fixtures();
    const baseHash = hashSnapshot(base);
    const gaps: string[] = [];
    let checked = 0;

    for (const table of TABLES) {
      const entity = base[table][0] as unknown as Record<string, unknown>;
      for (const field of Object.keys(entity)) {
        if (field === 'id') continue;
        const moved = perturb(entity[field]);
        if (moved === undefined) continue;
        checked++;

        const next: FullSnapshot = {
          ...base,
          tick: base.tick + 1,
          [table]: [{ ...entity, [field]: moved }],
        };
        // Only fields the hash can see are this test's business: a field
        // outside the hash costs bandwidth to diff and nothing to omit.
        if (hashSnapshot(next) === baseHash) continue;

        const applied = applyDelta(base, diffSnapshots(base, next), next.tick);
        if (hashSnapshot(applied) !== hashSnapshot(next)) {
          gaps.push(`${table}.${field}`);
        }
      }
    }

    // Guard against the walk silently checking nothing.
    expect(checked).toBeGreaterThan(60);
    expect(gaps, 'hashed but not in the diff field list').toEqual([]);
  });

  it('names escortOf in particular', () => {
    // The instance that prompted the test above. A mission assigns an
    // escortee by writing this one field, so before the repair the delta came
    // back completely empty and the client's ped never learned it was being
    // escorted.
    const base = fixtures();
    const ped = base.peds[0]!;
    const next: FullSnapshot = {
      ...base,
      tick: base.tick + 1,
      peds: [{ ...ped, escortOf: 42 }],
    };
    const delta = diffSnapshots(base, next);
    expect(delta.peds.updated).toHaveLength(1);
    expect(delta.peds.updated[0]).toMatchObject({ id: ped.id, escortOf: 42 });
    expect(applyDelta(base, delta, next.tick).peds[0]?.escortOf).toBe(42);
  });
});
