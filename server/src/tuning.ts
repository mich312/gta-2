import { readFileSync } from 'node:fs';
import { initTuning } from 'shared';

/**
 * Load tunables from shared/data/*.json into the sim. shared/ cannot touch
 * the filesystem itself, so every server entrypoint calls this at boot.
 */
export function loadSharedTuning(): void {
  const url = new URL(import.meta.resolve('shared/data/player.json'));
  initTuning({ player: JSON.parse(readFileSync(url, 'utf8')) });
}
