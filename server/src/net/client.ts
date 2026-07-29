import type { WebSocket } from 'ws';
import { type ServerMessage, binaryCodec } from 'shared';
import type { Conn } from './conn.js';

/** Socket-level wrapper: one per connection, tracks bandwidth for the overlay. */
export class ClientConn implements Conn {
  playerId: number | null = null;
  bytesIn = 0;
  bytesOut = 0;

  constructor(readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    const data = binaryCodec.encode(msg);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}
