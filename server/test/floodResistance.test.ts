import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import propsJson from '../../shared/data/props.json';
import trafficJson from '../../shared/data/traffic.json';
import worldgenJson from '../../shared/data/worldgen.json';
import shopJson from '../../shared/data/shop.json';
import economyJson from '../../shared/data/economy.json';
import {
  PROTOCOL_VERSION,
  binaryCodec,
  initTuning,
  parseCatalog,
  parseWorldgenParams,
  type ServerMessage,
} from 'shared';
import { Session } from '../src/session.js';
import { GameHost } from '../src/host.js';
import { Economy } from '../src/economy/economy.js';
import { parseEconomyParams } from '../src/economy/awards.js';
import { MemoryStore } from '../src/economy/store.js';
import { nodePasswords } from '../src/platform/nodePasswords.js';
import type { Conn } from '../src/net/conn.js';

/**
 * What one anonymous socket may cost the tick loop.
 *
 * Measured against a real server before these limits existed: a socket that
 * never joined sent 52,909 `register` messages in five seconds and took the
 * tick rate from 30 to 1 — and it was still 0 fifteen seconds after that
 * socket hung up, because each message had queued a synchronous 50 ms
 * password hash and 45 minutes of them were already in the pipe. A control
 * flood of 251,249 `ping` messages over the same five seconds cost 1.8 ticks
 * a second, which is what says the cost was the hashing and not the reading.
 *
 * Three things answer it and all three are tested here: the hash is off the
 * event loop, the verbs that spend one are on a tight budget, and everything
 * else is on a loose one.
 */

const worldgen = parseWorldgenParams(worldgenJson);
const catalog = parseCatalog(shopJson);
const economyParams = parseEconomyParams(economyJson);

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    traffic: trafficJson,
  });
});

class FakeConn implements Conn {
  playerId: number | null = null;
  bytesIn = 0;
  bytesOut = 0;
  closed = false;
  readonly sent: ServerMessage[] = [];
  draining = true;

  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }

  close(): void {
    this.closed = true;
  }

  of(type: string): ServerMessage[] {
    return this.sent.filter((m) => m.type === type);
  }
}

function host(over: Partial<{ maxConnections: number; maxPlayers: number }> = {}): GameHost {
  const session = new Session(7, worldgen, null, { pedCount: 20 });
  const economy = new Economy(new MemoryStore(), catalog, economyParams, nodePasswords);
  return new GameHost(
    { interestRadius: 600, maxConnections: 64, maxPlayers: 8, ...over },
    session,
    economy,
  );
}

const frame = (msg: unknown): Uint8Array =>
  binaryCodec.encode(msg as never) as Uint8Array;

const join = (name = 'p'): unknown => ({ type: 'join', protocol: PROTOCOL_VERSION, name });

describe('what one socket may spend', () => {
  it('drops messages past the per-connection budget instead of parsing them', () => {
    const h = host();
    const conn = new FakeConn();
    expect(h.accept(conn, 0)).toBe(true);
    h.receive(conn, frame(join()), 0);

    // Everything arrives on the same millisecond, so the bucket never refills:
    // exactly the burst gets through and the rest is dropped.
    const ping = frame({ type: 'ping', t: 1 });
    for (let i = 0; i < 400; i++) h.receive(conn, ping, 0);

    const pongs = conn.of('pong').length;
    expect(pongs).toBeGreaterThan(0);
    expect(pongs).toBeLessThan(200);
    expect(h.dropped.messages).toBeGreaterThan(200);
  });

  it('refills over real time, so a normal client never notices', () => {
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    h.receive(conn, frame(join()), 0);
    const before = h.dropped.messages;

    // Thirty inputs a second plus a ping, for ten seconds — what playing the
    // game actually costs. Not one of them may be refused.
    let seq = 1;
    for (let ms = 0; ms < 10_000; ms += 33) {
      h.receive(
        conn,
        frame({ type: 'input', ackTick: 0, intents: [{ seq: seq++, tick: seq, viewTick: 0 }] }),
        ms,
      );
      if (ms % 1000 === 0) h.receive(conn, frame({ type: 'ping', t: ms }), ms);
    }
    expect(h.dropped.messages).toBe(before);
  });

  it('hangs up on a socket that keeps flooding after its budget is gone', () => {
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    const ping = frame({ type: 'ping', t: 1 });
    for (let i = 0; i < 1000; i++) h.receive(conn, ping, 0);
    expect(conn.closed).toBe(true);
    expect(h.dropped.connections).toBeGreaterThan(0);
  });

  it('spends the budget before the decode, so junk frames cost no more', () => {
    // The flood that reached a real server was undecodable: JSON text read as
    // binary, which threw on its first byte. An exception per frame at socket
    // speed is its own denial of service, so the budget has to be taken
    // before the codec is asked.
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    const junk = new Uint8Array([0xff, 0xfe, 0xfd]);
    for (let i = 0; i < 400; i++) h.receive(conn, junk, 0);
    expect(h.dropped.messages).toBeGreaterThan(200);
  });
});

describe('the verbs that cost a password hash', () => {
  it('allows a handful of attempts and then says to wait', async () => {
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    h.receive(conn, frame(join()), 0);

    for (let i = 0; i < 20; i++) {
      h.receive(
        conn,
        frame({ type: 'login', username: `user${i}`, password: 'hunter2hunter2' }),
        0,
      );
    }
    // The refusals are synchronous; the accepted ones answer off the worker
    // pool, so let them land.
    await new Promise((r) => setTimeout(r, 2000));

    const answers = conn.of('account') as Array<{ ok: boolean; message: string }>;
    const waits = answers.filter((a) => a.message.includes('too many attempts'));
    expect(answers).toHaveLength(20);
    expect(waits.length).toBeGreaterThanOrEqual(14);
    // ...and the ones that were let through were really answered, not stubbed.
    expect(answers.filter((a) => a.message === 'bad credentials').length).toBeGreaterThan(0);
  });

  it('does not block the caller while a hash runs', () => {
    // The whole point of the repair. `receive` must return before the
    // derivation finishes, or the tick loop is waiting on scrypt again.
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    h.receive(conn, frame(join()), 0);
    const t0 = performance.now();
    h.receive(conn, frame({ type: 'register', username: 'gwen', password: 'hunter2hunter2' }), 0);
    const elapsed = performance.now() - t0;
    // A scrypt derivation is ~50 ms; one tick is 33 ms. Returning inside a
    // millisecond is the difference between the two.
    expect(elapsed).toBeLessThan(10);
    expect(conn.of('account')).toHaveLength(0); // not answered yet, by design
  });

  it('lets the answer land afterwards', async () => {
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    h.receive(conn, frame(join()), 0);
    h.receive(conn, frame({ type: 'register', username: 'gwen', password: 'hunter2hunter2' }), 0);
    await new Promise((r) => setTimeout(r, 2000));
    const answers = conn.of('account') as Array<{ ok: boolean }>;
    expect(answers).toHaveLength(1);
    expect(answers[0]?.ok).toBe(true);
  });
});

describe('caps on how much of the session one peer may hold', () => {
  it('refuses a connection past the cap, and says why', () => {
    const h = host({ maxConnections: 2 });
    const a = new FakeConn();
    const b = new FakeConn();
    const c = new FakeConn();
    expect(h.accept(a, 0)).toBe(true);
    expect(h.accept(b, 0)).toBe(true);
    expect(h.accept(c, 0)).toBe(false);
    expect(c.of('error')).toHaveLength(1);

    // ...and a slot frees when somebody leaves.
    h.drop(a);
    expect(h.accept(c, 0)).toBe(true);
  });

  it('refuses a join past the player cap but never a reconnect', () => {
    const h = host({ maxPlayers: 2 });
    const conns = [new FakeConn(), new FakeConn(), new FakeConn()];
    for (const c of conns) h.accept(c, 0);
    h.receive(conns[0]!, frame(join('a')), 0);
    h.receive(conns[1]!, frame(join('b')), 0);
    h.receive(conns[2]!, frame(join('c')), 0);

    expect(conns[0]!.of('welcome')).toHaveLength(1);
    expect(conns[1]!.of('welcome')).toHaveLength(1);
    expect(conns[2]!.of('welcome')).toHaveLength(0);
    expect(conns[2]!.of('error')).toHaveLength(1);
    expect(conns[2]!.closed).toBe(true);

    // A player already in the city coming back is not a new player: a full
    // server that could not readmit its own players after a wobbly connection
    // would empty itself one dropout at a time.
    const welcome = conns[0]!.of('welcome')[0] as { resumeToken: string };
    h.drop(conns[0]!);
    const again = new FakeConn();
    h.accept(again, 0);
    h.receive(
      again,
      frame({ type: 'join', protocol: PROTOCOL_VERSION, name: 'a', resumeToken: welcome.resumeToken }),
      0,
    );
    expect(again.of('welcome')).toHaveLength(1);
  });

  it('skips the state message for a socket that is not draining', () => {
    // A client that stops reading turns 30 snapshots a second into server
    // memory. Skipping is safe because the next delta is built against
    // whatever it last ACKED, so the gap closes itself.
    const h = host();
    const conn = new FakeConn();
    h.accept(conn, 0);
    h.receive(conn, frame(join()), 0);
    conn.sent.length = 0;

    conn.draining = false;
    for (let i = 0; i < 10; i++) h.onTick();
    expect(conn.of('snapshot')).toHaveLength(0);
    expect(conn.of('full')).toHaveLength(0);

    conn.draining = true;
    h.onTick();
    expect(conn.of('snapshot').length + conn.of('full').length).toBe(1);
  });
});
