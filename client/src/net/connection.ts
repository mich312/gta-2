import {
  type ClientMessage,
  type InputIntent,
  type ServerMessage,
  PROTOCOL_VERSION,
  jsonCodec,
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
      if (typeof ev.data !== 'string') return;
      this.opts.stats.addIn(ev.data.length);
      let msg: ServerMessage | null;
      try {
        msg = parseServerMessage(jsonCodec.decode(ev.data));
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
    const data = jsonCodec.encode(msg);
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
