import type { ClientMessage, ServerMessage } from './messages.js';

export type WireMessage = ClientMessage | ServerMessage;

/**
 * Everything that crosses the wire goes through a Codec. Switching to a
 * binary encoding later means writing one new implementation of this
 * interface — nothing else in client, server, or bots changes.
 */
export interface Codec {
  encode(msg: WireMessage): string | Uint8Array;
  /** Returns unknown: callers must run the result through parse*Message. */
  decode(data: string | Uint8Array): unknown;
}

export const jsonCodec: Codec = {
  encode(msg: WireMessage): string {
    return JSON.stringify(msg);
  },
  decode(data: string | Uint8Array): unknown {
    if (typeof data !== 'string') {
      throw new Error('jsonCodec: binary frames not supported');
    }
    return JSON.parse(data) as unknown;
  },
};
