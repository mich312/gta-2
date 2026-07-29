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
 */
export class GameServer {
  readonly host: GameHost;

  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;

  constructor(
    private readonly config: ServerConfig,
    readonly session: Session,
    readonly economy: Economy,
  ) {
    this.host = new GameHost({ interestRadius: config.interestRadius }, session, economy);
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
    this.host.accept(conn);
    ws.on('message', (data) => {
      // Binary frames arrive as Buffer/ArrayBuffer; a JSON-speaking peer may
      // still send text, and the codec tolerates both.
      const frame = rawToFrame(data);
      conn.bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
      this.host.receive(conn, frame);
    });
    ws.on('close', () => this.host.drop(conn));
    ws.on('error', () => this.host.drop(conn));
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
