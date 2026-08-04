import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { createStaticServer } from './staticServer.js';
import type { ServerConfig } from '../config.js';
import type { Session } from '../session.js';
import type { Economy } from '../economy/economy.js';
import { GameHost } from '../host.js';
import { ClientConn } from './client.js';

/**
 * The WebSocket transport.
 *
 * Everything about *the game* now lives in `GameHost`; this class opens a
 * port, wraps each socket in a `ClientConn`, and forwards frames. It is one
 * of two transports — the other is a `MessagePort` to a Web Worker, which is
 * what lets the game run with no server at all (SHIP.md T1).
 *
 * What it does own is everything that is a property of the *socket* rather
 * than of the game: how big a frame may be, whether the peer is still there,
 * and whether it is reading what it is sent. The budgets on what a message
 * MEANS live in `GameHost`, so both transports get them.
 */

/**
 * The largest frame the server will read.
 *
 * `ws` defaults to 100 MiB, which is a hundred megabytes of buffering any
 * anonymous socket may ask for. The biggest thing a real client sends is an
 * `input` carrying ten intents — a couple of hundred bytes — so this is three
 * orders of magnitude of headroom and still four of protection.
 */
const MAX_PAYLOAD = 32 * 1024;

/** How often to ping an idle socket, and therefore how fast a dead one is reaped. */
const HEARTBEAT_MS = 15_000;

export class GameServer {
  readonly host: GameHost;

  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;

  constructor(
    private readonly config: ServerConfig,
    readonly session: Session,
    readonly economy: Economy,
  ) {
    this.host = new GameHost(
      {
        interestRadius: config.interestRadius,
        maxConnections: config.maxConnections,
        maxPlayers: config.maxPlayers,
      },
      session,
      economy,
    );
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;
      if (this.config.clientDir) {
        // Production: one HTTP server serves the built client AND carries the
        // WebSocket upgrade, so a single TLS origin (the edge proxy) fronts
        // both. The client connects to wss://<host> (same origin).
        const http = createStaticServer(this.config.clientDir);
        this.httpServer = http;
        wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
        http.once('error', reject);
        http.listen(this.config.port, this.config.host, () => resolve());
      } else {
        // Local dev: standalone WS; the client runs on Vite (:5173) over ws://.
        wss = new WebSocketServer({
          host: this.config.host,
          port: this.config.port,
          maxPayload: MAX_PAYLOAD,
        });
        wss.once('listening', () => resolve());
        wss.once('error', reject);
      }
      this.wss = wss;
      wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  /** Called by the tick loop. */
  onTick(): void {
    this.host.onTick();
  }

  close(): void {
    this.host.closeAll();
    this.wss?.close();
    this.httpServer?.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn = new ClientConn(ws);
    if (!this.host.accept(conn)) {
      ws.close();
      return;
    }
    // Liveness. Nothing else notices a socket whose peer has vanished without
    // a FIN — a laptop lid, a dropped wifi link — and the server goes on
    // encoding a state message a tick for it until TCP eventually gives up
    // minutes later. Worse, the slot stays `connected`, so `resumeByToken`
    // refuses the player's reconnect and they come back as a SECOND player
    // with their old body still standing in the road.
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('message', (data, isBinary) => {
      // `ws` hands over a Buffer either way and says which it was, so a text
      // frame has to be turned back into a string HERE. Read as binary, a
      // JSON peer's `{` is a frame tag the codec has never heard of: the
      // documented text fallback threw on the first byte of every message and
      // the server answered nothing at all.
      const frame = rawToFrame(data, isBinary);
      conn.bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
      this.host.receive(conn, frame);
    });
    ws.on('close', () => {
      clearInterval(beat);
      this.host.drop(conn);
    });
    ws.on('error', () => {
      clearInterval(beat);
      this.host.drop(conn);
    });
  }
}

/**
 * Normalise a ws RawData frame into what the codec accepts. Binary frames
 * become a Uint8Array view over the same memory (no copy); text frames become
 * strings so a JSON-speaking peer keeps working.
 */
export function rawToFrame(data: RawData, isBinary: boolean): string | Uint8Array {
  if (typeof data === 'string') return data;
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (!isBinary) return buf.toString('utf8');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
