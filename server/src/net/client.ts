import type { WebSocket } from 'ws';
import { type ServerMessage, binaryCodec } from 'shared';
import type { Conn } from './conn.js';

/**
 * How much unsent data may pile up behind one socket.
 *
 * `ws.send` never blocks: if the peer is not reading, the frame goes into the
 * socket's own queue and that queue has no ceiling. The server writes a state
 * message per client per tick whether anybody is listening or not, so before
 * this an idle socket accumulated for as long as it stayed open, and nothing
 * ever hung up on it.
 *
 * **The rate is small and the bound is the point.** Measured, one non-reading
 * client queues about 45 KB/s — a couple of megabytes over two minutes, lost
 * in GC noise, and an earlier reading of 300 MB turned out to be the server's
 * own warm-up rather than anything the socket did (a client reading normally
 * grew the same amount). What justifies the guard is not the rate but that
 * there was no ceiling on it at all: a socket left open overnight is a
 * different number, and half a dozen of them are a different number again.
 *
 * The soft limit skips state messages, which is the right thing to skip: they
 * are the bulk of the bytes, they are superseded every tick anyway, and the
 * delta base is chosen from what the client last ACKED, so a client that
 * misses a run of them is brought back up to date by construction rather than
 * left inconsistent.
 */
const SEND_QUEUE_SOFT = 256 * 1024;
/** Past this the connection is not slow, it is gone. */
const SEND_QUEUE_HARD = 2 * 1024 * 1024;

/** Socket-level wrapper: one per connection, tracks bandwidth for the overlay. */
export class ClientConn implements Conn {
  playerId: number | null = null;
  bytesIn = 0;
  bytesOut = 0;
  /** State messages skipped because this socket was not draining. */
  skipped = 0;

  constructor(readonly ws: WebSocket) {}

  /**
   * True when the socket is keeping up.
   *
   * The host asks before building a state message, so a backed-up client
   * costs neither the filter, the diff, nor the encode.
   */
  get draining(): boolean {
    return this.ws.bufferedAmount < SEND_QUEUE_SOFT;
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > SEND_QUEUE_HARD) {
      // Not a slow client any more. Terminate rather than close: a close
      // handshake is another frame onto a queue that is already the problem.
      this.ws.terminate();
      return;
    }
    const data = binaryCodec.encode(msg);
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }
}
