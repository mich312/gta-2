import type { InputIntent } from '../sim/input.js';
import type { SimCommand } from '../sim/commands.js';
import type { Tuning } from '../tuning.js';
import type { WorldgenParams } from '../world/params.js';

/**
 * Replay file format: JSON-lines. First line is the header, then one record
 * per simulated tick containing exactly the inputs and commands the server
 * applied. Re-running the file through step() must reproduce the session
 * bit-for-bit — every bug gets captured as one of these before it gets fixed.
 */

export interface ReplayHeader {
  version: 1;
  seed: number;
  tickRate: number;
  startedAt: string;
  /** Snapshot of the tunables in force, so replays survive JSON re-tuning. */
  tuning: Tuning;
  worldgen: WorldgenParams;
}

export interface ReplayTickRecord {
  t: number;
  /** JSON object keys are strings; values keyed by playerId. */
  inputs: Record<string, InputIntent>;
  commands: SimCommand[];
}

export function isReplayHeader(v: unknown): v is ReplayHeader {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['version'] === 1 &&
    typeof (v as Record<string, unknown>)['seed'] === 'number' &&
    typeof (v as Record<string, unknown>)['tickRate'] === 'number'
  );
}

export function isReplayTickRecord(v: unknown): v is ReplayTickRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['t'] === 'number' && typeof r['inputs'] === 'object' && Array.isArray(r['commands']);
}
