import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  Predictor,
  SnapshotSync,
  TICK_MS,
  jsonCodec,
  parseServerMessage,
} from 'shared';
import type { BotScript } from './scripts.js';

export interface BotReport {
  name: string;
  welcomed: boolean;
  connectedAtEnd: boolean;
  playerId: number;
  lastServerTick: number;
  entityCount: number;
  desyncs: number;
  staleDeltas: number;
  fullResyncs: number;
  /** Worst reconciliation correction seen, px. ~0 means prediction is sound. */
  maxCorrection: number;
  bytesIn: number;
  bytesOut: number;
  errors: string[];
}

/**
 * A headless client: connects over ws, joins, streams scripted inputs at
 * tick rate, and reassembles server snapshots exactly like the browser
 * client does (same SnapshotSync, same codec). This is how multiplayer gets
 * verified without opening N browser windows.
 */
export class Bot {
  readonly errors: string[] = [];
  playerId = -1;
  welcomed = false;

  private readonly sync = new SnapshotSync();
  private readonly predictor = new Predictor();
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seq = 1;
  private localTick = 0;
  private bytesIn = 0;
  private bytesOut = 0;

  constructor(
    private readonly url: string,
    readonly name: string,
    private readonly script: BotScript,
    private readonly index: number,
  ) {}

  start(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timeout = setTimeout(() => {
        this.errors.push('welcome timeout');
        reject(new Error(`${this.name}: welcome timeout`));
      }, timeoutMs);

      ws.on('open', () => {
        this.send({ type: 'join', protocol: PROTOCOL_VERSION, name: this.name });
      });
      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString();
        this.bytesIn += text.length;
        this.onMessage(text, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      ws.on('error', (err) => {
        this.errors.push(String(err));
        clearTimeout(timeout);
        reject(err);
      });
      ws.on('close', () => {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      });
    });
  }

  private onMessage(text: string, onWelcome: () => void): void {
    let msg;
    try {
      msg = parseServerMessage(jsonCodec.decode(text));
    } catch {
      this.errors.push('undecodable message');
      return;
    }
    if (!msg) return;
    if (msg.type === 'welcome') {
      this.playerId = msg.playerId;
      this.welcomed = true;
      this.sync.applyServerMessage(msg);
      this.startInputStream();
      onWelcome();
      return;
    }
    if (msg.type === 'snapshot' || msg.type === 'full') {
      this.sync.applyServerMessage(msg);
      // Bots run real client-side prediction: reconcile against the
      // authoritative snapshot exactly like the browser client does.
      const me = this.sync.latest?.players.find((p) => p.id === this.playerId);
      if (me) {
        const ackSeq = msg.type === 'snapshot' ? msg.ackSeq : me.lastInputSeq;
        this.predictor.reconcile(me, ackSeq);
      }
    }
  }

  private startInputStream(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.localTick++;
      const keys = this.script(this.localTick, this.index);
      const intent = { seq: this.seq++, tick: this.localTick, ...keys };
      this.send({ type: 'input', ackTick: this.sync.ackTick, intents: [intent] });
      this.predictor.applyLocalInput(intent);
    }, TICK_MS);
  }

  private send(msg: Parameters<typeof jsonCodec.encode>[0]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = jsonCodec.encode(msg);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data);
  }

  report(): BotReport {
    return {
      name: this.name,
      welcomed: this.welcomed,
      connectedAtEnd: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      playerId: this.playerId,
      lastServerTick: this.sync.ackTick,
      entityCount: this.sync.entityCount,
      desyncs: this.sync.desyncs,
      staleDeltas: this.sync.staleDeltas,
      fullResyncs: this.sync.fullResyncs,
      maxCorrection: this.predictor.maxCorrection,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      errors: this.errors.slice(),
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
  }
}
