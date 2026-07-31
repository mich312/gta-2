import WebSocket from 'ws';
import {
  type CityMap,
  PROTOCOL_VERSION,
  Predictor,
  SnapshotSync,
  TICK_MS,
  generateCity,
  initTuning,
  binaryCodec,
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
  everDrove: boolean;
  deaths: number;
  killEventsSeen: number;
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
  everDrove = false;
  deaths = 0;
  killEventsSeen = 0;
  private wasDead = false;

  private readonly sync = new SnapshotSync();
  private readonly predictor = new Predictor();
  private map: CityMap | null = null;
  private seed = 0;
  private worldgen: import('shared').WorldgenParams | null = null;
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seq = 1;
  private localTick = 0;
  /** Newest snapshot tick this bot has predicted against; see `viewTick`. */
  private viewTick = 0;
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
        // Binary frames must be measured and decoded as bytes — stringifying
        // them would both corrupt the payload and misreport bandwidth, which
        // is the number the harness gates on.
        const buf = Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.from(data as ArrayBuffer);
        const frame = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        this.bytesIn += frame.byteLength;
        this.onMessage(frame, () => {
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

  private onMessage(frame: string | Uint8Array, onWelcome: () => void): void {
    let msg;
    try {
      msg = parseServerMessage(binaryCodec.decode(frame));
    } catch {
      this.errors.push('undecodable message');
      return;
    }
    if (!msg) return;
    if (msg.type === 'welcome') {
      this.playerId = msg.playerId;
      this.welcomed = true;
      // Bots behave exactly like the browser client: tunables and worldgen
      // params come from the server, and the city regenerates from the seed.
      initTuning(msg.tuning);
      this.seed = msg.seed;
      this.worldgen = msg.worldgen;
      this.map = generateCity(msg.seed, msg.worldgen);
      this.sync.applyServerMessage(msg);
      this.startInputStream();
      onWelcome();
      return;
    }
    if (msg.type === 'event') {
      if (msg.event.type === 'kill') this.killEventsSeen++;
      return;
    }
    if (msg.type === 'snapshot' || msg.type === 'full') {
      this.sync.applyServerMessage(msg);
      // Bots run real client-side prediction: reconcile against the
      // authoritative snapshot exactly like the browser client does.
      const me = this.sync.latest?.players.find((p) => p.id === this.playerId);
      if (me?.mode === 'driving') this.everDrove = true;
      if (me) {
        if (me.mode === 'dead' && !this.wasDead) this.deaths++;
        this.wasDead = me.mode === 'dead';
      }
      if (me && this.map) {
        const ackSeq = msg.type === 'snapshot' ? msg.ackSeq : me.lastInputSeq;
        const myVehicle =
          me.vehicleId !== null
            ? (this.sync.latest?.vehicles.find((v) => v.id === me.vehicleId) ?? null)
            : null;
        // Same collision context the browser client gets, so the harness
        // measures the prediction players actually run. A bot has no render
        // delay, so the world it predicts against is the newest snapshot
        // whole — and `viewTick` says exactly that, which is what lets the
        // server rewind to the same moment (see `rewoundWorld`).
        if (this.sync.latest) {
          this.predictor.setWorld(this.sync.latest.vehicles);
          this.viewTick = this.sync.latest.tick;
        }
        this.predictor.reconcile(me, myVehicle, ackSeq, this.map);
      }
    }
  }

  private startInputStream(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.localTick++;
      const keys = this.script(this.localTick, this.index, {
        me: this.predictor.predicted,
        snapshot: this.sync.latest,
      });
      const intent = { seq: this.seq++, tick: this.localTick, viewTick: this.viewTick, ...keys };
      this.send({ type: 'input', ackTick: this.sync.ackTick, intents: [intent] });
      if (this.map) this.predictor.applyLocalInput(intent, this.map);
    }, TICK_MS);
  }

  private send(msg: Parameters<typeof binaryCodec.encode>[0]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const data = binaryCodec.encode(msg);
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
      everDrove: this.everDrove,
      deaths: this.deaths,
      killEventsSeen: this.killEventsSeen,
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
