import { readFileSync } from 'node:fs';
import { initTuning, parseWorldgenParams, type WorldgenParams } from 'shared';

/**
 * Load tunables from shared/data/*.json into the sim. shared/ cannot touch
 * the filesystem itself, so every server entrypoint calls this at boot.
 * The parsed values are also shipped to clients in the welcome message.
 */
export function loadSharedTuning(): void {
  const url = new URL(import.meta.resolve('shared/data/player.json'));
  initTuning({ player: JSON.parse(readFileSync(url, 'utf8')) });
}

export function loadWorldgenParams(): WorldgenParams {
  const url = new URL(import.meta.resolve('shared/data/worldgen.json'));
  return parseWorldgenParams(JSON.parse(readFileSync(url, 'utf8')));
}
