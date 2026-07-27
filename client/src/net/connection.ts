import {
  type ClientMessage,
  type InputIntent,
  type ServerMessage,
  PROTOCOL_VERSION,
  binaryCodec,
  parseServerMessage,
} from 'shared';
import type { NetStats } from '../debug/stats.js';

export interface ConnectionOptions {
  url: string;
  name: string;
  stats: NetStats;
  getResumeToken: () => string | null;
  onMessage: (msg: ServerMessage) => void;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * WebSocket wrapper: joins on open, auto-reconnects with the resume token,
 * counts bytes for the overlay. All encoding goes through the shared codec.
 */
export class Connection {
  connected = false;

  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly opts: ConnectionOptions) {}

  connect(): void {
    this.closedByUs = false;
    const ws = new WebSocket(this.opts.url);
    // Without this the browser hands us Blobs, which are async to read and
    // would put snapshot decoding a microtask behind the frame that needs it.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      const token = this.opts.getResumeToken();
      const join: ClientMessage = {
        type: 'join',
        protocol: PROTOCOL_VERSION,
        name: this.opts.name,
        ...(token ? { resumeToken: token } : {}),
      };
      this.send(join);
    };
    ws.onmessage = (ev: MessageEvent) => {
      let frame: string | Uint8Array;
      if (typeof ev.data === 'string') {
        frame = ev.data;
        this.opts.stats.addIn(ev.data.length);
      } else if (ev.data instanceof ArrayBuffer) {
        frame = new Uint8Array(ev.data);
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
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (!this.closedByUs) {
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = binaryCodec.encode(msg);
    if (typeof data === 'string') {
      this.opts.stats.addOut(data.length);
      this.ws.send(data);
    } else {
      this.opts.stats.addOut(data.byteLength);
      this.ws.send(data);
    }
  }

  sendInput(ackTick: number, intents: InputIntent[]): void {
    this.send({ type: 'input', ackTick, intents });
  }

  ping(now: number): void {
    this.send({ type: 'ping', t: now });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }
}
