import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * The portable boundary (SHIP.md §3, constraint 1).
 *
 * `GameHost` and everything it reaches has to run in a Web Worker with no
 * Node underneath it — that is what lets the game run with no server, which
 * is the whole of T1. The property held by accident before anybody depended
 * on it; now that something does, it needs a gate.
 *
 * The closure is walked rather than listed, on purpose. A list goes stale the
 * first time somebody adds a file, and the failure mode is silent: the import
 * lands, nobody updates the list, and the break is found when the bundler
 * chokes weeks later. Walking the graph means a new `node:` import *anywhere*
 * reachable from the host fails here, and the message says which chain
 * carried it in.
 */

/** Resolve a relative NodeNext specifier ('./x.js') to its source file. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare: 'shared', 'ws', 'node:*'
  const abs = resolve(dirname(fromFile), spec);
  for (const candidate of [abs.replace(/\.js$/, '.ts'), `${abs}.ts`, join(abs, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g;

interface Offence {
  file: string;
  spec: string;
  via: string[];
}

/** Walk every local import reachable from `entry`, collecting node: usages. */
function auditFrom(entry: string): { visited: Set<string>; offences: Offence[] } {
  const visited = new Set<string>();
  const offences: Offence[] = [];
  const walk = (file: string, trail: string[]): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const src = readFileSync(file, 'utf8');
    const here = [...trail, relative(SRC, file)];
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec === undefined) continue;
      if (spec.startsWith('node:')) {
        offences.push({ file: relative(SRC, file), spec, via: here });
        continue;
      }
      const next = resolveLocal(file, spec);
      if (next) walk(next, here);
    }
  };
  walk(entry, []);
  return { visited, offences };
}

describe('the portable boundary', () => {
  it('GameHost reaches no node: import, however deep', () => {
    const { offences } = auditFrom(join(SRC, 'host.ts'));
    const detail = offences
      .map((o) => `  ${o.file} imports ${o.spec}\n    via ${o.via.join(' -> ')}`)
      .join('\n');
    expect(
      offences,
      offences.length
        ? `GameHost's import closure must stay free of Node so it can run in a ` +
            `Web Worker (SHIP.md §3). Found:\n${detail}`
        : '',
    ).toEqual([]);
  });

  it('covers the game logic, so the check is not passing by being empty', () => {
    const { visited } = auditFrom(join(SRC, 'host.ts'));
    const names = [...visited].map((f) => relative(SRC, f));
    // If a refactor moved the game out from under the host, the walk above
    // would trivially pass. These are the files the port actually depends on.
    for (const expected of [
      'session.ts',
      'missions/missions.ts',
      'economy/economy.ts',
      'economy/jobs.ts',
      'economy/ledger.ts',
      'economy/accounts.ts',
      'economy/memoryStore.ts',
      'net/broadcast.ts',
      'provingGround.ts',
    ]) {
      expect(names, `${expected} should be reachable from host.ts`).toContain(expected);
    }
  });

  it('still lets the Node-only corner import Node', () => {
    // The point is a boundary, not abstinence. These are on the server side
    // of it and must keep their imports.
    const { offences } = auditFrom(join(SRC, 'index.ts'));
    expect(offences.length).toBeGreaterThan(0);
  });
});
