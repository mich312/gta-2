import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  RESUME_GRACE_MS,
  SNAPSHOT_HASH_INTERVAL,
  TICK_RATE,
  getTuning,
  jsonCodec,
  parseClientMessage,
} from 'shared';
import type { ServerConfig } from '../config.js';
import type { Session } from '../session.js';
import type { Economy } from '../economy/economy.js';
import { buildStateMessage, filterSnapshot } from './broadcast.js';
import { ClientConn } from './client.js';

export class GameServer {
  private wss: WebSocketServer | null = null;
  private readonly conns = new Set<ClientConn>();
  private readonly byPlayer = new Map<number, ClientConn>();

  constructor(
    private readonly config: ServerConfig,
    readonly session: Session,
    readonly economy: Economy,
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
      conn.send(buildStateMessage(slot, snap, this.config.interestRadius, withHash));
      const me = snap.players.find((p) => p.id === playerId);
      for (const ev of this.session.lastEvents) {
        // Interest management applies to events too: positional events
        // (shots) outside the radius are noise; kill-feed events are global.
        if (ev.type === 'shot' && me) {
          const dx = ev.x0 - me.pos.x;
          const dy = ev.y0 - me.pos.y;
          const r = this.config.interestRadius;
          if (dx * dx + dy * dy > r * r) continue;
        }
        conn.send({ type: 'event', tick: snap.tick, event: ev });
      }
    }

    // Cash awards from this tick's events + driving coverage.
    const changed = this.economy.processTick(this.session.lastEvents, this.session.state, Date.now());
    for (const playerId of changed) {
      this.byPlayer.get(playerId)?.send({ type: 'wallet', cash: this.economy.cashOf(playerId) });
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
      case 'buy': {
        if (conn.playerId === null) break;
        const result = this.economy.buy(conn.playerId, msg.itemId, this.session.state, this.session.map);
        if (result.command) this.session.queueCommand(result.command);
        conn.send({ type: 'event', tick: this.session.state.tick, event: { type: 'notice', text: result.message } });
        conn.send({ type: 'wallet', cash: result.cash });
        break;
      }
      case 'register': {
        const res = this.economy.accounts.register(msg.username, msg.password);
        conn.send({ type: 'account', ok: res.ok, username: res.ok ? msg.username : null, message: res.message });
        if (res.ok && conn.playerId !== null) this.bindAccount(conn, msg.username);
        break;
      }
      case 'login': {
        const row = this.economy.accounts.verify(msg.username, msg.password);
        if (!row) {
          conn.send({ type: 'account', ok: false, username: null, message: 'bad credentials' });
          break;
        }
        conn.send({ type: 'account', ok: true, username: row.username, message: 'logged in' });
        if (conn.playerId !== null) this.bindAccount(conn, row.username);
        break;
      }
    }
  }

  private bindAccount(conn: ClientConn, username: string): void {
    if (conn.playerId === null) return;
    this.economy.bindAccount(conn.playerId, username);
    const cosmetic = this.economy.equippedCosmetic(conn.playerId);
    if (cosmetic > 0) {
      this.session.queueCommand({ type: 'setCosmetic', playerId: conn.playerId, cosmeticId: cosmetic });
    }
    conn.send({ type: 'wallet', cash: this.economy.cashOf(conn.playerId) });
  }

  private handleJoin(conn: ClientConn, name: string, resumeToken?: string): void {
    if (conn.playerId !== null) return; // already joined

    let slot = resumeToken ? this.session.resumeByToken(resumeToken) : null;
    if (slot) {
      // A resumed player keeps their entity; kick any zombie conn mapping.
      this.byPlayer.get(slot.playerId)?.ws.close();
    } else {
      slot = this.session.addPlayer(name, randomUUID());
      this.economy.bindGuest(slot.playerId);
    }
    conn.playerId = slot.playerId;
    this.byPlayer.set(slot.playerId, conn);

    const snap = this.session.latestSnapshot;
    // Welcome is filtered too (a fresh join must not receive 200 peds);
    // the player entity doesn't exist yet, so only players + driven cars.
    const me = snap.players.find((p) => p.id === slot.playerId);
    const filtered = filterSnapshot(snap, me ? me.pos : null, this.config.interestRadius);
    slot.sentRing.set(filtered.tick, filtered);
    slot.lastAckTick = snap.tick;
    conn.send({
      type: 'welcome',
      playerId: slot.playerId,
      seed: this.session.seed,
      tick: snap.tick,
      tickRate: TICK_RATE,
      resumeToken: slot.resumeToken,
      snapshot: filtered,
      tuning: getTuning(),
      worldgen: this.session.worldgen,
      catalog: this.economy.catalog,
    });
    conn.send({ type: 'wallet', cash: this.economy.cashOf(slot.playerId) });
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
