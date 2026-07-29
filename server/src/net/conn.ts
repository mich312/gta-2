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
  send(msg: ServerMessage): void;
  /** Hang up. The transport is expected to call back into `GameHost.drop`. */
  close(): void;
}
