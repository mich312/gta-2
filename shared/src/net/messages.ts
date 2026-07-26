import type { InputIntent } from '../sim/input.js';
import { sanitizeIntent } from '../sim/input.js';
import type { FullSnapshot, SnapshotDelta } from './snapshot.js';
import type { SimEvent } from '../sim/events.js';
import type { Tuning } from '../tuning.js';
import type { WorldgenParams } from '../world/params.js';
import type { Catalog } from '../economy/catalog.js';

const MAX_NAME_LEN = 24;
const MAX_INTENTS_PER_MSG = 10;

/** Discrete non-state facts: sim events (kills, shots) + server notices. */
export type GameEvent = SimEvent | { type: 'notice'; text: string };

export type ClientMessage =
  | { type: 'join'; protocol: number; name: string; resumeToken?: string }
  | { type: 'input'; ackTick: number; intents: InputIntent[] }
  | { type: 'ping'; t: number }
  /** Requests, not state: the server validates everything about them. */
  | { type: 'buy'; itemId: string }
  | { type: 'register'; username: string; password: string }
  | { type: 'login'; username: string; password: string };

export type ServerMessage =
  | {
      type: 'welcome';
      playerId: number;
      seed: number;
      tick: number;
      tickRate: number;
      resumeToken: string;
      snapshot: FullSnapshot;
      /** Server-authoritative tunables: clients must init from these, not
       * their bundled JSON, so a server-side tune can't desync generation. */
      tuning: Tuning;
      worldgen: WorldgenParams;
      catalog: Catalog;
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
  | { type: 'wallet'; cash: number }
  | { type: 'account'; ok: boolean; username: string | null; message: string }
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
    case 'buy': {
      const itemId = r['itemId'];
      if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 40) return null;
      return { type: 'buy', itemId };
    }
    case 'register':
    case 'login': {
      const username = r['username'];
      const password = r['password'];
      if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return null;
      if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
        return null;
      }
      return { type: r['type'], username, password };
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
  'wallet',
  'account',
  'error',
]);

/** Client-side parse. The server is trusted; this is a shape check, not a validator. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as Record<string, unknown>)['type'];
  if (typeof t !== 'string' || !SERVER_MESSAGE_TYPES.has(t)) return null;
  return raw as ServerMessage;
}
