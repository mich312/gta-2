import {
  type ClientMessage,
  type InputIntent,
  type ServerMessage,
  PROTOCOL_VERSION,
  binaryCodec,
  parseServerMessage,
} from 'shared';
import type { NetStats } from '../debug/stats.js';
import type { LocalHostOptions } from '../local/host.worker.js';

export interface LocalConnectionOptions {
  name: string;
  stats: NetStats;
  host: LocalHostOptions;
  onMessage: (msg: ServerMessage) => void;
}

/**
 * The offline transport: the same protocol, over a worker instead of a wire.
 *
 * Deliberately the same shape as `Connection` — `connect`, `send`,
 * `sendInput`, `ping`, `close` — so `main.ts` picks one at boot and nothing
 * downstream knows which it got. There is no reconnect and no resume token,
 * because there is nothing to reconnect to: the host dies with the tab.
 *
 * Frames go through the binary codec exactly as they would over a socket.
 * That looks like waste when both ends share an address space, and it is the
 * point: encoding here means the offline game and the co-op game exercise the
 * same wire format, so a message that cannot survive the codec fails in
 * single-player rather than the first time somebody hosts for a friend.
 */
export class LocalConnection {
  connected = false;

  private worker: Worker | null = null;

  constructor(private readonly opts: LocalConnectionOptions) {}

  connect(): void {
    const worker = new Worker(new URL('../local/host.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as unknown;
      if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && 'type' in data) {
        if ((data as { type: string }).type === 'localClose') this.close();
        return;
      }
      let frame: string | Uint8Array;
      if (typeof data === 'string') {
        frame = data;
        this.opts.stats.addIn(data.length);
      } else if (data instanceof ArrayBuffer) {
        frame = new Uint8Array(data);
        this.opts.stats.addIn(frame.byteLength);
      } else if (ArrayBuffer.isView(data)) {
        frame = data as Uint8Array;
        this.opts.stats.addIn(frame.byteLength);
      } else {
        return;
      }
      let msg: ServerMessage | null;
      try {
        msg = parseServerMessage(binaryCodec.decode(frame));
      } catch {
        return;
      }
      if (msg) this.opts.onMessage(msg);
    };
    worker.postMessage({ localBoot: this.opts.host });
    this.connected = true;
    // The host is listening the moment it is constructed, and messages queue
    // behind the boot frame, so joining immediately is safe.
    this.send({ type: 'join', protocol: PROTOCOL_VERSION, name: this.opts.name });
  }

  send(msg: ClientMessage): void {
    if (!this.worker) return;
    const data = binaryCodec.encode(msg);
    if (typeof data === 'string') {
      this.opts.stats.addOut(data.length);
      this.worker.postMessage(data);
    } else {
      this.opts.stats.addOut(data.byteLength);
      this.worker.postMessage(data, [data.buffer as ArrayBuffer]);
    }
  }

  sendInput(ackTick: number, intents: InputIntent[]): void {
    this.send({ type: 'input', ackTick, intents });
  }

  ping(now: number): void {
    this.send({ type: 'ping', t: now });
  }

  close(): void {
    this.connected = false;
    this.worker?.terminate();
    this.worker = null;
  }
}
