import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  RESUME_GRACE_MS,
  SNAPSHOT_HASH_INTERVAL,
  TICK_RATE,
  jsonCodec,
  parseClientMessage,
} from 'shared';
import type { ServerConfig } from '../config.js';
import type { Session } from '../session.js';
import { buildStateMessage } from './broadcast.js';
import { ClientConn } from './client.js';

export class GameServer {
  private wss: WebSocketServer | null = null;
  private readonly conns = new Set<ClientConn>();
  private readonly byPlayer = new Map<number, ClientConn>();

  constructor(
    private readonly config: ServerConfig,
    readonly session: Session,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.config.host, port: this.config.port });
      this.wss = wss;
      wss.on('connection', (ws) => this.onConnection(ws));
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });
  }

  /** Called by the tick loop: advance the sim and fan out per-client deltas. */
  onTick(): void {
    this.session.expireDisconnected(Date.now(), RESUME_GRACE_MS);
    const snap = this.session.tick();
    const withHash = snap.tick % SNAPSHOT_HASH_INTERVAL === 0;
    for (const [playerId, conn] of this.byPlayer) {
      const slot = this.session.slots.get(playerId);
      if (!slot || !slot.connected) continue;
      conn.send(buildStateMessage(this.session, slot, snap, withHash));
    }
  }

  close(): void {
    for (const conn of this.conns) conn.ws.close();
    this.wss?.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn = new ClientConn(ws);
    this.conns.add(conn);
    ws.on('message', (data) => this.onMessage(conn, data));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => this.onClose(conn));
  }

  private onMessage(conn: ClientConn, data: RawData): void {
    const text = rawToString(data);
    conn.bytesIn += text.length;
    let raw: unknown;
    try {
      raw = jsonCodec.decode(text);
    } catch {
      return; // not JSON; drop silently
    }
    const msg = parseClientMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case 'join':
        this.handleJoin(conn, msg.name, msg.resumeToken);
        break;
      case 'input':
        if (conn.playerId !== null) {
          this.session.queueInput(conn.playerId, msg.ackTick, msg.intents);
        }
        break;
      case 'ping':
        conn.send({ type: 'pong', t: msg.t, serverTick: this.session.state.tick });
        break;
    }
  }

  private handleJoin(conn: ClientConn, name: string, resumeToken?: string): void {
    if (conn.playerId !== null) return; // already joined

    let slot = resumeToken ? this.session.resumeByToken(resumeToken) : null;
    if (slot) {
      // A resumed player keeps their entity; kick any zombie conn mapping.
      this.byPlayer.get(slot.playerId)?.ws.close();
    } else {
      slot = this.session.addPlayer(name, randomUUID());
    }
    conn.playerId = slot.playerId;
    this.byPlayer.set(slot.playerId, conn);

    const snap = this.session.latestSnapshot;
    slot.lastAckTick = snap.tick;
    conn.send({
      type: 'welcome',
      playerId: slot.playerId,
      seed: this.session.seed,
      tick: snap.tick,
      tickRate: TICK_RATE,
      resumeToken: slot.resumeToken,
      snapshot: snap,
    });
  }

  private onClose(conn: ClientConn): void {
    this.conns.delete(conn);
    if (conn.playerId !== null) {
      if (this.byPlayer.get(conn.playerId) === conn) {
        this.byPlayer.delete(conn.playerId);
        this.session.markDisconnected(conn.playerId, Date.now());
      }
      conn.playerId = null;
    }
  }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
