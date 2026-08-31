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
  /** Called with a human-readable reason whenever the socket cannot stay up. */
  onDisconnected?: (attempts: number) => void;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Server error codes that reconnecting cannot fix.
 *
 * The server answers a bad join with an `error` frame and then hangs up, so
 * every rejection lands in `onclose` and looks exactly like a dropped socket.
 * For most of them retrying is the right answer — `full` above all, where the
 * city is at `maxPlayers` and the whole point of waiting is that a slot frees
 * up — so the default stays "reconnect".
 *
 * `protocol` is different in kind: the rejection is about *this build*, and
 * the next socket sends the same `PROTOCOL_VERSION` and is refused
 * identically. Retrying it is a 2-second loop with no end, and after a
 * version bump every tab left open across the deploy runs it at once. Nothing
 * short of the player reloading the page can change the outcome, which is
 * what the server's message tells them to do — so stop, and let the fatal
 * banner stand.
 */
const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set(['protocol']);

/**
 * WebSocket wrapper: joins on open, auto-reconnects with the resume token,
 * counts bytes for the overlay. All encoding goes through the shared codec.
 */
export class Connection {
  connected = false;

  private ws: WebSocket | null = null;
  private closedByUs = false;
  /** Consecutive failed connection attempts, for the "is it even up?" message. */
  private attempts = 0;

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
      this.attempts = 0;
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
      if (!msg) return;
      // Before handing it on: a terminal rejection has to stop the reconnect
      // loop, and the close that follows it is a beat away.
      if (msg.type === 'error' && TERMINAL_ERROR_CODES.has(msg.code)) this.close();
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.closedByUs) return;
      this.attempts++;
      this.opts.onDisconnected?.(this.attempts);
      // Re-checked on the way out, not just on the way in: `close()` can land
      // inside the wait, and a scheduled reconnect would otherwise undo it.
      setTimeout(() => {
        if (!this.closedByUs) this.connect();
      }, RECONNECT_DELAY_MS);
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
