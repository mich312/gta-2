import { readFileSync } from 'node:fs';
import { type Catalog, initTuning, parseCatalog, parseWorldgenParams, type WorldgenParams } from 'shared';
import { parseEconomyParams, type EconomyParams } from './economy/awards.js';

/**
 * Load tunables from shared/data/*.json into the sim. shared/ cannot touch
 * the filesystem itself, so every server entrypoint calls this at boot.
 * The parsed values are also shipped to clients in the welcome message.
 */
export function loadSharedTuning(): void {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(import.meta.resolve(`shared/data/${name}`)), 'utf8'));
  initTuning({
    player: read('player.json'),
    vehicles: read('vehicles.json'),
    weapons: read('weapons.json'),
  });
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
