import type { InputIntent } from '../sim/input.js';
import { sanitizeIntent } from '../sim/input.js';
import type { FullSnapshot, SnapshotDelta } from './snapshot.js';

const MAX_NAME_LEN = 24;
const MAX_INTENTS_PER_MSG = 10;

/** Discrete non-state facts (kill feed, purchases…). First real variants in phase 4. */
export type GameEvent = { type: 'notice'; text: string };

export type ClientMessage =
  | { type: 'join'; protocol: number; name: string; resumeToken?: string }
  | { type: 'input'; ackTick: number; intents: InputIntent[] }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | {
      type: 'welcome';
      playerId: number;
      seed: number;
      tick: number;
      tickRate: number;
      resumeToken: string;
      snapshot: FullSnapshot;
    }
  | {
      type: 'snapshot';
      tick: number;
      baseTick: number;
      ackSeq: number;
      delta: SnapshotDelta;
      hash?: number;
    }
  | { type: 'full'; tick: number; snapshot: FullSnapshot }
  | { type: 'event'; tick: number; event: GameEvent }
  | { type: 'pong'; t: number; serverTick: number }
  | { type: 'error'; code: string; message: string };

/**
 * Server-side trust boundary: parse anything a socket sends into a valid
 * ClientMessage or reject it. Never throws on garbage.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['type']) {
    case 'join': {
      if (typeof r['protocol'] !== 'number') return null;
      const rawName = typeof r['name'] === 'string' ? r['name'].trim() : '';
      const name = (rawName || 'guest').slice(0, MAX_NAME_LEN);
      const token = r['resumeToken'];
      const msg: ClientMessage = { type: 'join', protocol: r['protocol'], name };
      if (typeof token === 'string' && token.length > 0 && token.length <= 64) {
        msg.resumeToken = token;
      }
      return msg;
    }
    case 'input': {
      const ackTick = r['ackTick'];
      if (typeof ackTick !== 'number' || !Number.isFinite(ackTick)) return null;
      const rawIntents = r['intents'];
      if (!Array.isArray(rawIntents)) return null;
      const intents: InputIntent[] = [];
      for (const it of rawIntents.slice(0, MAX_INTENTS_PER_MSG)) {
        const clean = sanitizeIntent(it);
        if (clean) intents.push(clean);
      }
      return { type: 'input', ackTick: Math.floor(ackTick), intents };
    }
    case 'ping': {
      if (typeof r['t'] !== 'number' || !Number.isFinite(r['t'])) return null;
      return { type: 'ping', t: r['t'] };
    }
    default:
      return null;
  }
}

const SERVER_MESSAGE_TYPES = new Set([
  'welcome',
  'snapshot',
  'full',
  'event',
  'pong',
  'error',
]);

/** Client-side parse. The server is trusted; this is a shape check, not a validator. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as Record<string, unknown>)['type'];
  if (typeof t !== 'string' || !SERVER_MESSAGE_TYPES.has(t)) return null;
  return raw as ServerMessage;
}
