import { readFileSync } from 'node:fs';
import { type Catalog, initTuning, parseCatalog, parseWorldgenParams, type WorldgenParams } from 'shared';
import { parseEconomyParams, type EconomyParams } from './economy/awards.js';

/**
 * Load tunables from shared/data/*.json into the sim. shared/ cannot touch
 * the filesystem itself, so every server entrypoint calls this at boot.
 * The parsed values are also shipped to clients in the welcome message.
 */
export function loadSharedTuning(difficulty = 'normal'): void {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(import.meta.resolve(`shared/data/${name}`)), 'utf8'));
  initTuning({
    player: read('player.json'),
    vehicles: read('vehicles.json'),
    weapons: read('weapons.json'),
    police: applyDifficulty(read('police.json'), difficulty),
    peds: read('peds.json'),
    ambulance: read('ambulance.json'),
    props: read('props.json'),
    pickups: read('pickups.json'),
    traffic: read('traffic.json'),
    fittings: read('fittings.json'),
    gangs: read('gangs.json'),
    respect: read('respect.json'),
  });
}

/**
 * Fold a difficulty preset over the shipped police numbers.
 *
 * Server-side, and only server-side. A difficulty each player picks for
 * themselves is not a setting in a shared city, it is a cheat — the whole
 * point of the police being in the sim is that everybody's cops obey the
 * same numbers. The resolved values ship to clients in `welcome` exactly as
 * the file's own do, so nothing downstream can tell a preset from an edit.
 *
 * Presets override only top-level scalars, deliberately: a preset that could
 * rewrite `kinds` or `tiers` would be a second copy of the roster to keep in
 * step with the first.
 */
function applyDifficulty(raw: unknown, difficulty: string): unknown {
  const base = (raw ?? {}) as Record<string, unknown>;
  const presets = base['presets'] as Record<string, Record<string, number>> | undefined;
  if (!presets) return base;
  const { presets: _drop, ...rest } = base;
  const chosen = presets[difficulty];
  if (!chosen) {
    if (difficulty !== 'normal') {
      console.warn(`unknown DIFFICULTY "${difficulty}"; using the shipped numbers`);
    }
    return rest;
  }
  return { ...rest, ...chosen };
}

export function loadWorldgenParams(): WorldgenParams {
  const url = new URL(import.meta.resolve('shared/data/worldgen.json'));
  return parseWorldgenParams(JSON.parse(readFileSync(url, 'utf8')));
}

export function loadCatalog(): Catalog {
  const url = new URL(import.meta.resolve('shared/data/shop.json'));
  return parseCatalog(JSON.parse(readFileSync(url, 'utf8')));
}

export function loadEconomyParams(): EconomyParams {
  const url = new URL(import.meta.resolve('shared/data/economy.json'));
  return parseEconomyParams(JSON.parse(readFileSync(url, 'utf8')));
}
