import { hashState } from 'shared';
import { Session } from '../session.js';
import type { WorldgenParams } from 'shared';

/**
 * Step a session and report its hashes.
 *
 * The point is that this function imports nothing host-specific, so the same
 * code runs in Node and in a browser. If the two disagree about a single
 * hash, the offline host is not the game — it is a fork of the game that
 * looks like it (SHIP.md T1, and ROADMAP §0 invariant 1: `step()` stays
 * bit-identical everywhere).
 *
 * It drives the session with no input on purpose. Peds, traffic, the police
 * spawner, the day/night clock and every rng draw still run, so a divergence
 * in any of them shows up; adding scripted input would test more of the sim
 * but make the probe's own fixture something to get wrong.
 */
export interface ProbeResult {
  seed: number;
  ticks: number;
  /** Hash of the sim state at each sampled tick. */
  samples: Array<{ tick: number; hash: number }>;
  /** Hash of the final state — the one-line answer. */
  final: number;
}

export function probeHashes(
  seed: number,
  worldgen: WorldgenParams,
  ticks: number,
  every = 30,
): ProbeResult {
  const session = new Session(seed, worldgen, null, {
    weaponsLostOnDeath: true,
    pedCount: 200,
  });
  const samples: Array<{ tick: number; hash: number }> = [];
  for (let i = 0; i < ticks; i++) {
    session.tick();
    if (session.state.tick % every === 0) {
      samples.push({ tick: session.state.tick, hash: hashState(session.state) });
    }
  }
  return { seed, ticks, samples, final: hashState(session.state) };
}
