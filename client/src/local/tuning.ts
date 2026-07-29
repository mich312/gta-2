import {
  type Catalog,
  type WorldgenParams,
  initTuning,
  parseCatalog,
  parseWorldgenParams,
} from 'shared';
import { parseEconomyParams, type EconomyParams } from 'server/economy/awards.js';

import player from 'shared/data/player.json';
import vehicles from 'shared/data/vehicles.json';
import weapons from 'shared/data/weapons.json';
import police from 'shared/data/police.json';
import peds from 'shared/data/peds.json';
import ambulance from 'shared/data/ambulance.json';
import props from 'shared/data/props.json';
import pickups from 'shared/data/pickups.json';
import traffic from 'shared/data/traffic.json';
import fittings from 'shared/data/fittings.json';
import gangs from 'shared/data/gangs.json';
import respect from 'shared/data/respect.json';
import worldgen from 'shared/data/worldgen.json';
import shop from 'shared/data/shop.json';
import economy from 'shared/data/economy.json';

/**
 * The browser's copy of `server/src/tuning.ts`.
 *
 * Same JSON, same parsers, same `initTuning` call — the only difference is
 * that the server reads the files and the bundler inlines them. `shared/`
 * cannot touch a filesystem, which is exactly why the tunables arrive through
 * `initTuning()` rather than an import inside the sim: each host loads them
 * its own way, and this is the second host.
 *
 * The `shared/data/*` alias this relies on was already in `vite.config.ts`
 * before any of this existed.
 */

/** Fold a difficulty preset over the shipped police numbers (see server/tuning.ts). */
function applyDifficulty(raw: unknown, difficulty: string): unknown {
  const base = (raw ?? {}) as Record<string, unknown>;
  const presets = base['presets'] as Record<string, Record<string, number>> | undefined;
  if (!presets) return base;
  const { presets: _drop, ...rest } = base;
  const chosen = presets[difficulty];
  return chosen ? { ...rest, ...chosen } : rest;
}

export function initLocalTuning(difficulty = 'normal'): void {
  initTuning({
    player,
    vehicles,
    weapons,
    police: applyDifficulty(police, difficulty),
    peds,
    ambulance,
    props,
    pickups,
    traffic,
    fittings,
    gangs,
    respect,
  });
}

export function localWorldgenParams(): WorldgenParams {
  return parseWorldgenParams(worldgen);
}

export function localCatalog(): Catalog {
  return parseCatalog(shop);
}

export function localEconomyParams(): EconomyParams {
  return parseEconomyParams(economy);
}
