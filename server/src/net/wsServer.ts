import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { createStaticServer } from './staticServer.js';
import {
  type ServerMessage,
  type SimCommand,
  RESUME_GRACE_MS,
  SNAPSHOT_HASH_INTERVAL,
  TICK_RATE,
  getTuning,
  PROTOCOL_VERSION,
  binaryCodec,
  parseClientMessage,
} from 'shared';
import type { ServerConfig } from '../config.js';
import type { Session } from '../session.js';
import type { Economy } from '../economy/economy.js';
import { Missions } from '../missions/missions.js';
import { Jobs } from '../economy/jobs.js';
import { buildStateMessage, filterSnapshot } from './broadcast.js';
import { ClientConn } from './client.js';

export class GameServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private readonly conns = new Set<ClientConn>();
  private readonly byPlayer = new Map<number, ClientConn>();

  constructor(
    private readonly config: ServerConfig,
    readonly session: Session,
    readonly economy: Economy,
  ) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;
      if (this.config.clientDir) {
        // Production: one HTTP server serves the built client AND carries the
        // WebSocket upgrade, so a single TLS origin (the edge proxy) fronts
        // both. The client connects to wss://<host> (same origin).
        const http = createStaticServer(this.config.clientDir);
        this.httpServer = http;
        wss = new WebSocketServer({ server: http });
        http.once('error', reject);
        http.listen(this.config.port, this.config.host, () => resolve());
      } else {
        // Local dev: standalone WS; the client runs on Vite (:5173) over ws://.
        wss = new WebSocketServer({ host: this.config.host, port: this.config.port });
        wss.once('listening', () => resolve());
        wss.once('error', reject);
      }
      this.wss = wss;
      wss.on('connection', (ws) => this.onConnection(ws));
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
    // The crusher issues commands, so it needs the map and somewhere to put
    // them; they join the next tick's batch like every other economy write.
    const crushCommands: SimCommand[] = [];
    const changed = this.economy.processTick(
      this.session.lastEvents,
      this.session.state,
      Date.now(),
      this.session.map,
      crushCommands,
    );
    for (const cmd of crushCommands) this.session.queueCommand(cmd);

    // Service jobs: fares, casualties and vigilante bounties.
    const jobs = this.jobs.step(
      this.session.lastEvents,
      this.session.state,
      this.session.map,
      Math.round(getTuning().peds.bleedOutSec * TICK_RATE),
    );
    for (const cmd of jobs.commands) this.session.queueCommand(cmd);
    for (const [playerId, amount] of jobs.pay) {
      this.economy.payJob(playerId, amount);
      changed.add(playerId);
    }
    for (const n of jobs.notices) {
      this.byPlayer.get(n.playerId)?.send({
        type: 'event',
        tick: this.session.state.tick,
        event: { type: 'notice', text: n.text },
      });
    }

    // Missions advance on the same tick as everything else they read.
    const outcome = this.missions.step(this.session.lastEvents, this.session.state, this.session.map);
    for (const cmd of outcome.commands) this.session.queueCommand(cmd);
    // Anything take() or abandon() queued between ticks — assigning or
    // releasing an escortee. Drained here so it reaches the sim through the
    // same command path as everything else missions do.
    for (const cmd of this.missions.drainCommands()) this.session.queueCommand(cmd);

    // Hold-ups. Driven off the same held key the garage uses, which is free
    // and unambiguous: you cannot be in a car and at a counter at once.
    for (const [playerId, conn] of this.byPlayer) {
      const holding = this.session.lastIntents[playerId]?.fitting === true;
      const res = holding
        ? this.economy.robTick(playerId, this.session.state, this.session.map, Date.now())
        : this.economy.robTick(-1, this.session.state, this.session.map, Date.now());
      if (!holding || !res.done) continue;
      this.session.queueCommand({ type: 'addHeat', playerId, amount: this.economy.robHeat });
      conn.send({
        type: 'event',
        tick: this.session.state.tick,
        event: { type: 'notice', text: `till emptied — $${res.take}` },
      });
      conn.send({ type: 'wallet', ...this.economy.walletOf(playerId) });
    }

    // Hidden packages: proximity, server-side, touching nothing in the sim.
    for (const find of this.economy.secrets.step(this.session.state, this.session.map)) {
      if (find.reward > 0) this.economy.creditSecret(find.playerId, find.reward, find.found);
      const conn = this.byPlayer.get(find.playerId);
      conn?.send({
        type: 'event',
        tick: this.session.state.tick,
        event: {
          type: 'notice',
          text:
            find.reward > 0
              ? `package ${find.found} of ${find.total} — $${find.reward}`
              : `package ${find.found} of ${find.total}`,
        },
      });
      conn?.send({
        type: 'secrets',
        found: this.economy.secrets.indicesOf(find.playerId),
        total: find.total,
      });
      if (find.reward > 0) conn?.send({ type: 'wallet', ...this.economy.walletOf(find.playerId) });
    }
    for (const n of outcome.notices) {
      this.byPlayer.get(n.playerId)?.send({
        type: 'event',
        tick: this.session.state.tick,
        event: { type: 'notice', text: n.text },
      });
    }
    for (const done of outcome.completed) {
      this.economy.payMission(done.playerId, done.pay);
      changed.add(done.playerId);
    }
    for (const playerId of outcome.changed) {
      this.byPlayer.get(playerId)?.send(this.missionMessage(playerId));
    }

    // The list rotates on a timer; tell everyone the moment it does.
    this.economy.exports(Date.now());
    if (this.economy.exportListVersion !== this.sentExportVersion) {
      this.sentExportVersion = this.economy.exportListVersion;
      for (const conn of this.conns) conn.send(this.exportMessage());
    }
    for (const playerId of changed) {
      this.byPlayer.get(playerId)?.send({ type: 'wallet', ...this.economy.walletOf(playerId) });
    }
  }

  private readonly missions = new Missions();
  private readonly jobs = new Jobs();
  private sentExportVersion = -1;

  private missionMessage(playerId: number): ServerMessage {
    const v = this.missions.view(playerId, this.session.state.tick);
    return { type: 'missionState', ...v };
  }

  private exportMessage(): ServerMessage {
    return {
      type: 'exports',
      kinds: this.economy.exports(Date.now()),
      bonus: this.economy.exportBonus,
    };
  }

  close(): void {
    for (const conn of this.conns) conn.ws.close();
    this.wss?.close();
    this.httpServer?.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn = new ClientConn(ws);
    this.conns.add(conn);
    ws.on('message', (data) => this.onMessage(conn, data));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => this.onClose(conn));
  }

  private onMessage(conn: ClientConn, data: RawData): void {
    // Binary frames arrive as Buffer/ArrayBuffer; a JSON-speaking peer may
    // still send text, and the codec tolerates both.
    const frame = rawToFrame(data);
    conn.bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
    let raw: unknown;
    try {
      raw = binaryCodec.decode(frame);
    } catch {
      return; // undecodable; drop silently
    }
    const msg = parseClientMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case 'join':
        // The protocol field has been sent since the first commit and never
        // read. A client on a different build than the server produces
        // baffling symptoms — a city generated from different worldgen code,
        // or tuning the client cannot parse — so say so plainly instead.
        if (msg.protocol !== PROTOCOL_VERSION) {
          conn.send({
            type: 'error',
            code: 'protocol',
            message:
              `server speaks protocol ${PROTOCOL_VERSION}, client speaks ${msg.protocol} — ` +
              'one of them is an older build: reload the page, or rebuild the server ' +
              '(pnpm build)',
          });
          conn.ws.close();
          return;
        }
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
      case 'mission': {
        if (conn.playerId === null) break;
        if (msg.action === 'abandon') {
          this.missions.abandon(conn.playerId);
        } else {
          const why = this.missions.take(conn.playerId, this.session.state, this.session.map);
          if (why) {
            conn.send({
              type: 'event',
              tick: this.session.state.tick,
              event: { type: 'notice', text: why },
            });
          }
        }
        conn.send(this.missionMessage(conn.playerId));
        break;
      }
      case 'buy': {
        if (conn.playerId === null) break;
        const result = this.economy.buy(conn.playerId, msg.itemId, this.session.state, this.session.map);
        if (result.command) this.session.queueCommand(result.command);
        conn.send({ type: 'event', tick: this.session.state.tick, event: { type: 'notice', text: result.message } });
        conn.send({ type: 'wallet', ...this.economy.walletOf(conn.playerId) });
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
    conn.send({ type: 'wallet', ...this.economy.walletOf(conn.playerId) });
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
    conn.send({ type: 'wallet', ...this.economy.walletOf(slot.playerId) });
    conn.send(this.exportMessage());
    conn.send(this.missionMessage(slot.playerId));
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

/**
 * Normalise a ws RawData frame into what the codec accepts. Binary frames
 * become a Uint8Array view over the same memory (no copy); text frames stay
 * strings so a JSON-speaking peer keeps working.
 */
function rawToFrame(data: RawData): string | Uint8Array {
  if (typeof data === 'string') return data;
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
