import { type ServerMessage, TICK_RATE, binaryCodec, getTuning } from 'shared';
import { GameHost } from 'server/host.js';
import { Session } from 'server/session.js';
import { Economy } from 'server/economy/economy.js';
import { MemoryStore } from 'server/economy/memoryStore.js';
import { TickLoop } from 'server/loop.js';
import type { Conn } from 'server/net/conn.js';
import { initLocalTuning, localCatalog, localEconomyParams, localWorldgenParams } from './tuning.js';

/**
 * The whole game, in a Web Worker, with no server.
 *
 * This is SHIP.md T1 proved rather than argued. Every import above except
 * `./tuning.js` is server code, unmodified, running in a browser: the same
 * `Session`, the same `Economy`, the same `GameHost`, the same `TickLoop`,
 * speaking the same protocol through the same codec. What used to be a
 * WebSocket is now `postMessage`.
 *
 * It runs on its own thread on purpose. The obvious reason is that a 30 Hz
 * simulation sharing a thread with a 60 Hz renderer would jitter under render
 * load. The better reason is that a worker makes the boundary structural: the
 * renderer cannot reach into sim state even by accident, because it is not in
 * this address space, and the discipline that made this port a day's work
 * stays enforced by the runtime instead of by review.
 */

export interface LocalHostOptions {
  seed: number;
  pedCount: number;
  roam: boolean;
  interestRadius: number;
  provingGround: boolean;
  difficulty: string;
}

/** The one connection: the tab that spawned us. */
class PortConn implements Conn {
  playerId: number | null = null;
  bytesIn = 0;
  bytesOut = 0;

  send(msg: ServerMessage): void {
    const data = binaryCodec.encode(msg);
    // Byte accounting is real even with no wire — the debug overlay's
    // bandwidth readout is how we know a change did not blow the budget, and
    // it should keep working offline. Encoding also has to happen anyway:
    // skipping it would let the local host accept messages the wire cannot
    // carry, which is precisely the class of bug that only shows up in co-op.
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    self.postMessage(data, { transfer: data instanceof Uint8Array ? [data.buffer] : [] });
  }

  close(): void {
    self.postMessage({ type: 'localClose' });
  }
}

let host: GameHost | null = null;
let loop: TickLoop | null = null;
const conn = new PortConn();

function boot(opts: LocalHostOptions): void {
  initLocalTuning(opts.difficulty);
  const worldgen = { ...localWorldgenParams(), provingGround: opts.provingGround };

  // No replay recorder: the file writer is Node-only, and an in-memory one is
  // a separate item (SHIP.md T1). Determinism is unaffected — the recorder
  // observes, it does not participate.
  const session = new Session(opts.seed, worldgen, null, {
    weaponsLostOnDeath: true,
    pedCount: opts.pedCount,
    roam: opts.roam,
  });
  // MemoryStore for the spike: the wallet lives as long as the tab. The real
  // item is an IndexedDB PersistenceStore, which is one implementation of an
  // interface MemoryStore already satisfies.
  const economy = new Economy(new MemoryStore(), localCatalog(), localEconomyParams());

  host = new GameHost({ interestRadius: opts.interestRadius }, session, economy);
  host.accept(conn);

  loop = new TickLoop(() => host?.onTick());
  loop.start();

  const weaponCount = Object.keys(getTuning().weapons).length;
  console.log(
    `[local] host up: seed=${opts.seed} tickRate=${TICK_RATE} peds=${opts.pedCount} ` +
      `weapons=${weaponCount} — no server`,
  );
}

self.onmessage = (ev: MessageEvent): void => {
  const data = ev.data as unknown;

  // Control frames are plain objects; game frames are what the codec makes.
  if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && 'localBoot' in data) {
    boot((data as { localBoot: LocalHostOptions }).localBoot);
    return;
  }
  if (!host) return;

  const frame =
    typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : (data as Uint8Array);
  conn.bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
  host.receive(conn, frame);
};
