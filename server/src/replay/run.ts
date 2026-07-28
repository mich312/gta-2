import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  type GameState,
  type InputIntent,
  createGameState,
  generateCity,
  hashState,
  initTuning,
  isReplayHeader,
  isReplayTickRecord,
  step,
} from 'shared';

export interface ReplayResult {
  finalTick: number;
  finalHash: number;
  hashes: Array<{ tick: number; hash: number }>;
}

/**
 * Re-simulate a recorded session headlessly. Two runs of the same lines must
 * produce identical hashes — that is the determinism regression test.
 */
export function runReplay(lines: string[], hashEvery = 30): ReplayResult {
  const headerLine = lines[0];
  if (!headerLine) throw new Error('empty replay');
  const header: unknown = JSON.parse(headerLine);
  if (!isReplayHeader(header)) throw new Error('bad replay header');

  // Replays are self-contained: they carry the tunables that were in force,
  // so re-tuning the JSON files never breaks an old recording.
  initTuning(header.tuning);
  let worldgen = header.worldgen;
  let map = generateCity(header.seed, worldgen);

  let state: GameState = createGameState(header.seed);
  const hashes: ReplayResult['hashes'] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    const rec: unknown = JSON.parse(line);
    if (!isReplayTickRecord(rec)) throw new Error(`bad replay record at line ${i + 1}`);
    // Tolerate gaps (idle ticks a future recorder might skip).
    while (state.tick < rec.t - 1) {
      state = step(state, {}, [], map);
      maybeHash(state, hashes, hashEvery);
    }
    // A rebase command means the session swapped its window before stepping
    // this tick — the replay swaps at the same boundary or every collision
    // after it happens in the wrong world.
    for (const cmd of rec.commands) {
      if (cmd.type === 'rebase') {
        worldgen = { ...worldgen, windowX: cmd.windowX, windowY: cmd.windowY };
        map = generateCity(header.seed, worldgen);
      }
    }
    state = step(state, rec.inputs as unknown as Record<number, InputIntent>, rec.commands, map);
    maybeHash(state, hashes, hashEvery);
  }
  return { finalTick: state.tick, finalHash: hashState(state), hashes };
}

function maybeHash(
  state: GameState,
  hashes: ReplayResult['hashes'],
  hashEvery: number,
): void {
  if (state.tick % hashEvery === 0) {
    hashes.push({ tick: state.tick, hash: hashState(state) });
  }
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node replay/run.js <replay.jsonl>');
    process.exit(2);
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  const a = runReplay(lines);
  const b = runReplay(lines);
  console.log(`ticks: ${a.finalTick}`);
  for (const { tick, hash } of a.hashes.slice(-5)) {
    console.log(`  tick ${tick}: ${hash.toString(16)}`);
  }
  console.log(`final hash run1: ${a.finalHash.toString(16)}`);
  console.log(`final hash run2: ${b.finalHash.toString(16)}`);
  if (a.finalHash !== b.finalHash) {
    console.error('DESYNC: replay is not deterministic');
    process.exit(1);
  }
  console.log('deterministic ✓');
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
