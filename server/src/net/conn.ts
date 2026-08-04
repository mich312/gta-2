import type { ServerMessage } from 'shared';

/**
 * One connected player, as the game host sees it.
 *
 * The host never touches a socket: it calls `send` and, rarely, `close`. That
 * is the whole surface a transport has to provide, which is what lets the
 * same host run behind a WebSocket on a server and behind a `MessagePort` in
 * a worker (SHIP.md §3, T1).
 *
 * `bytesIn`/`bytesOut` are for the debug overlay's bandwidth readout. A
 * transport with no wire may leave them at zero.
 */
export interface Conn {
  /** Assigned by the host on join; null until then. */
  playerId: number | null;
  bytesIn: number;
  bytesOut: number;
  /**
   * Whether this connection is keeping up with what has been sent to it.
   *
   * The host skips a client's state message for the ticks it reads false, so
   * a peer that has stopped draining its socket cannot turn the tick rate
   * into server memory. A transport with no queue to speak of — the worker
   * `MessagePort` — may leave this true always.
   */
  readonly draining?: boolean;
  send(msg: ServerMessage): void;
  /** Hang up. The transport is expected to call back into `GameHost.drop`. */
  close(): void;
  /**
   * Hang up without the pleasantries, for a peer that has forfeited them.
   *
   * `close()` is a handshake: it sends a close frame and waits for one back,
   * and until that arrives the socket is still open and still delivering
   * everything the peer is sending. That is the right manners for a protocol
   * mismatch or a kicked zombie connection, and exactly the wrong ones for a
   * flood — the client that will not stop sending is also the client that
   * will not answer a close frame, so a polite hang-up on one is no hang-up
   * at all. Optional: a transport with no socket to cut has nothing to do
   * here and may fall back to `close`.
   */
  terminate?(): void;
}
