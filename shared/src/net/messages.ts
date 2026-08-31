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
  | { type: 'mission'; action: 'take' | 'abandon' }
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
      /**
       * The last input `seq` this slot has had taken from it — 0 for a fresh
       * join, the live watermark for a resume. A client numbers its own
       * intents and `Session.queueInput` drops anything at or below this, so
       * a client that starts counting from 1 again (a reloaded tab) must
       * resume its counter from here or every intent it sends is a replay.
       */
      inputSeq: number;
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
  | {
      type: 'wallet';
      cash: number;
      multiplier: number;
      lifetime: number;
      /** Lifetime earned per district — how well each one knows you (L3). */
      standing: Record<string, number>;
    }
  | {
      /**
       * Which hidden packages THIS player has found. Indices into
       * `map.packages`, which the client already generated from the seed —
       * so a hundred finds cost a hundred small integers, once.
       */
      type: 'secrets';
      found: number[];
      total: number;
    }
  | {
      /** Vehicle kinds the crushers are paying over the odds for right now. */
      type: 'exports';
      kinds: string[];
      bonus: number;
    }
  | {
      /** The job you are on, or `active: false` when you are not on one. */
      type: 'missionState';
      active: boolean;
      text: string;
      tier: string;
      employer: string;
      progress: number;
      target: number;
      secondsLeft: number;
      marker: { x: number; y: number } | null;
    }
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
    case 'mission': {
      const action = r['action'];
      if (action !== 'take' && action !== 'abandon') return null;
      return { type: 'mission', action };
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
  'exports',
  'secrets',
  'missionState',
]);

/** Client-side parse. The server is trusted; this is a shape check, not a validator. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as Record<string, unknown>)['type'];
  if (typeof t !== 'string' || !SERVER_MESSAGE_TYPES.has(t)) return null;
  return raw as ServerMessage;
}
