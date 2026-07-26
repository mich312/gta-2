import { describe, expect, it } from 'vitest';
import { jsonCodec } from '../src/net/codec.js';
import { parseClientMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '../src/net/messages.js';
import { NULL_INPUT } from '../src/sim/input.js';

describe('jsonCodec round-trip', () => {
  it('round-trips client messages through encode/decode/parse', () => {
    const msgs: ClientMessage[] = [
      { type: 'join', protocol: 1, name: 'alice' },
      { type: 'join', protocol: 1, name: 'bob', resumeToken: 'tok-123' },
      {
        type: 'input',
        ackTick: 42,
        intents: [{ ...NULL_INPUT, seq: 7, tick: 43, up: true, aimAngle: 1.25 }],
      },
      { type: 'ping', t: 123.456 },
    ];
    for (const m of msgs) {
      const parsed = parseClientMessage(jsonCodec.decode(jsonCodec.encode(m) as string));
      expect(parsed).toEqual(m);
    }
  });

  it('round-trips server messages', () => {
    const msgs: ServerMessage[] = [
      { type: 'pong', t: 1, serverTick: 99 },
      { type: 'error', code: 'nope', message: 'bad' },
      { type: 'full', tick: 10, snapshot: { tick: 10, players: [], vehicles: [], cops: [] } },
      {
        type: 'snapshot',
        tick: 11,
        baseTick: 10,
        ackSeq: 5,
        delta: {
          players: { added: [], updated: [{ id: 1, health: 90 }], removed: [2] },
          vehicles: { added: [], updated: [{ id: 9, speed: 120 }], removed: [] },
          cops: { added: [], updated: [], removed: [3] },
        },
        hash: 12345,
      },
    ];
    for (const m of msgs) {
      const parsed = parseServerMessage(jsonCodec.decode(jsonCodec.encode(m) as string));
      expect(parsed).toEqual(m);
    }
  });

  it('rejects garbage at the trust boundary', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage({})).toBeNull();
    expect(parseClientMessage({ type: 'input' })).toBeNull();
    expect(parseClientMessage({ type: 'input', ackTick: 'x', intents: [] })).toBeNull();
    expect(parseClientMessage({ type: 'nonsense' })).toBeNull();
    expect(parseServerMessage({ type: 'evil' })).toBeNull();
  });

  it('sanitizes hostile input intents instead of trusting them', () => {
    const parsed = parseClientMessage({
      type: 'input',
      ackTick: 5,
      intents: [
        { seq: 1, tick: 1, up: 'yes', aimAngle: Infinity, fire: 1 }, // coerced
        { seq: -1, tick: 1 }, // rejected
        'garbage', // rejected
      ],
    });
    expect(parsed).not.toBeNull();
    if (parsed && parsed.type === 'input') {
      expect(parsed.intents).toHaveLength(1);
      expect(parsed.intents[0]!.up).toBe(false);
      expect(parsed.intents[0]!.fire).toBe(false);
      expect(parsed.intents[0]!.aimAngle).toBe(0);
    }
  });

  it('caps oversized fields', () => {
    const parsed = parseClientMessage({ type: 'join', protocol: 1, name: 'x'.repeat(500) });
    expect(parsed).not.toBeNull();
    if (parsed && parsed.type === 'join') {
      expect(parsed.name.length).toBeLessThanOrEqual(24);
    }
    const flood = parseClientMessage({
      type: 'input',
      ackTick: 0,
      intents: Array.from({ length: 200 }, (_, i) => ({ ...NULL_INPUT, seq: i, tick: i })),
    });
    if (flood && flood.type === 'input') {
      expect(flood.intents.length).toBeLessThanOrEqual(10);
    }
  });
});
