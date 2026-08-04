import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, binaryCodec, parseClientMessage } from 'shared';
import { rawToFrame } from '../src/net/wsServer.js';

/**
 * The JSON-text fallback, which was documented in two places and worked in
 * neither.
 *
 * `binaryCodec.decode` says "Tolerated so a JSON-speaking peer still works
 * during a rollout" and `wsServer` said "the codec tolerates both". They were
 * both describing an intention: `ws` delivers a TEXT frame as a Buffer, same
 * as a binary one, and only says which it was through a separate argument.
 * Read as binary, a JSON peer's leading `{` is byte 0x7B, which the codec
 * reads as a frame tag it has never heard of — so it threw on the first byte
 * of every message and the server answered nothing at all. Measured against a
 * real server: a binary join got 76 frames back, the same join as text got 0.
 *
 * A rollout escape hatch nobody has tried is an escape hatch that is not
 * there, so this holds both framings to the same answer.
 */
describe('what the transport accepts', () => {
  const join = { type: 'join' as const, protocol: PROTOCOL_VERSION, name: 'probe' };

  it('reads a text frame as text and a binary frame as bytes', () => {
    const asText = Buffer.from(JSON.stringify(join), 'utf8');
    const asBinary = Buffer.from(binaryCodec.encode(join) as Uint8Array);

    expect(typeof rawToFrame(asText, false)).toBe('string');
    expect(typeof rawToFrame(asBinary, true)).not.toBe('string');
  });

  it('lands on the same message either way', () => {
    const fromText = parseClientMessage(
      binaryCodec.decode(rawToFrame(Buffer.from(JSON.stringify(join), 'utf8'), false)),
    );
    const fromBinary = parseClientMessage(
      binaryCodec.decode(rawToFrame(Buffer.from(binaryCodec.encode(join) as Uint8Array), true)),
    );
    expect(fromText).toEqual(fromBinary);
    expect(fromText).toMatchObject({ type: 'join', protocol: PROTOCOL_VERSION, name: 'probe' });
  });

  it('handles a fragmented binary frame', () => {
    // `ws` hands over an array of Buffers when a frame arrived in fragments.
    const bytes = binaryCodec.encode(join) as Uint8Array;
    const half = Math.floor(bytes.length / 2);
    const fragments = [Buffer.from(bytes.subarray(0, half)), Buffer.from(bytes.subarray(half))];
    const joined = rawToFrame(fragments, true);
    expect(parseClientMessage(binaryCodec.decode(joined))).toMatchObject({ type: 'join' });
  });
});
