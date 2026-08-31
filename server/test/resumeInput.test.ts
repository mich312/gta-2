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
  NULL_INPUT,
  PROTOCOL_VERSION,
  binaryCodec,
  initTuning,
  parseCatalog,
  parseWorldgenParams,
  type InputIntent,
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
 * A page reload has to give the player back a body they can move.
 *
 * The client numbers its own intents from a module-level counter and a
 * reloaded tab starts that counter at 1 again — while the resume token in
 * `sessionStorage` survives the reload and puts the player straight back into
 * the slot they already had. The server drops any intent at or below the last
 * sequence number it has taken from that slot, so half an hour of play then
 * F5 meant half an hour of ignored input: the car carried on by itself for
 * the few ticks the held-input path covers and then stopped, and nothing the
 * player pressed did anything until the counter had climbed all the way back.
 *
 * The repair is that `welcome` says where the numbering has got to and the
 * client picks it up from there, so the watermark never moves backwards.
 * Both halves are held here: the field is on the wire with the right value
 * and a client that honours it walks, and the replay guard that watermark
 * exists to be still refuses numbers the server has already taken.
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

type Welcome = Extract<ServerMessage, { type: 'welcome' }>;

const frame = (msg: unknown): Uint8Array => binaryCodec.encode(msg as never) as Uint8Array;

function newHost(): GameHost {
  const session = new Session(7, worldgen, null, { pedCount: 0 });
  const economy = new Economy(new MemoryStore(), catalog, economyParams, nodePasswords);
  return new GameHost({ interestRadius: 600, maxConnections: 64, maxPlayers: 8 }, session, economy);
}

/** Join (or resume) over the wire, and hand back the welcome that came out. */
function join(h: GameHost, conn: FakeConn, nowMs: number, resumeToken?: string): Welcome {
  h.accept(conn, nowMs);
  h.receive(
    conn,
    frame({
      type: 'join',
      protocol: PROTOCOL_VERSION,
      name: 'p',
      ...(resumeToken === undefined ? {} : { resumeToken }),
    }),
    nowMs,
  );
  const welcome = conn.of('welcome')[0] as Welcome | undefined;
  if (!welcome) throw new Error('joined and got no welcome');
  return welcome;
}

/**
 * The widest run of road on the map, borrowed from `sparseInput.test.ts`.
 * The spawn a seed hands out is a fact about the baked city and the city gets
 * rebaked; this is a test about input numbering, so it needs ground under the
 * player rather than a particular address.
 */
function openStart(session: Session): { x: number; y: number } {
  const map = session.map;
  let best = { x: 0, y: 0, len: 0 };
  for (let ty = 0; ty < map.heightTiles; ty++) {
    let run = 0;
    for (let tx = 0; tx <= map.widthTiles; tx++) {
      const road = tx < map.widthTiles && map.tiles[ty * map.widthTiles + tx] === 1; /* T_ROAD */
      if (road) {
        run++;
        continue;
      }
      if (run > best.len) best = { x: tx - run, y: ty, len: run };
      run = 0;
    }
  }
  return { x: (best.x + 2.5) * 16, y: (best.y + 0.5) * 16 };
}

const walkEast = (seq: number, tick: number): InputIntent => ({
  ...NULL_INPUT,
  seq,
  tick,
  right: true,
});

/** Stand the player somewhere they can actually walk, and return where. */
function standOnOpenRoad(h: GameHost, playerId: number): { x: number; y: number } {
  const at = openStart(h.session);
  const me = h.session.state.players.byId[playerId];
  if (!me) throw new Error('joined and got no body');
  me.pos.x = at.x;
  me.pos.y = at.y;
  return at;
}

function posOf(h: GameHost, playerId: number): { x: number; y: number } {
  const p = h.session.state.players.byId[playerId];
  if (!p) throw new Error('no player');
  return { x: p.pos.x, y: p.pos.y };
}

/** One input message per tick, on the millisecond grid the budget expects. */
function playTicks(
  h: GameHost,
  conn: FakeConn,
  seqs: number[],
  startMs: number,
  startTick: number,
): void {
  for (let i = 0; i < seqs.length; i++) {
    h.receive(
      conn,
      frame({ type: 'input', ackTick: -1, intents: [walkEast(seqs[i]!, startTick + i)] }),
      startMs + i * 33,
    );
    h.onTick();
  }
}

/** Run the world on with nobody pressing anything, so the hold expires. */
function idle(h: GameHost, ticks: number): void {
  for (let i = 0; i < ticks; i++) h.onTick();
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('a reloaded tab gets a body it can move', () => {
  it('welcome carries the input watermark, and a client resuming from it walks', () => {
    const h = newHost();
    const first = new FakeConn();
    const welcome = join(h, first, 0);
    // A fresh join is where it always was: the client's `seq = 1` is the
    // first number above this, so nothing changes for a first-time player.
    expect(welcome.inputSeq).toBe(0);

    h.onTick();
    const playerId = welcome.playerId;
    standOnOpenRoad(h, playerId);

    // Ten seconds of play: the client's counter reaches 300.
    playTicks(h, first, Array.from({ length: 300 }, (_, i) => i + 1), 100, 2);
    idle(h, 60); // let the held input lapse and the walk stop

    // F5. The socket goes; the resume token in sessionStorage does not.
    h.drop(first);
    const before = posOf(h, playerId);

    const second = new FakeConn();
    const back = join(h, second, 20_000, welcome.resumeToken);
    expect(back.playerId).toBe(playerId); // the same body...
    expect(back.inputSeq).toBe(300); // ...and where its numbering had got to

    // Exactly what the welcome handler in `client/src/main.ts` does with it:
    // a module-level `seq = 1` that is never allowed to sit below what the
    // server has already taken.
    let seq = 1;
    if (Number.isFinite(back.inputSeq)) seq = Math.max(seq, back.inputSeq + 1);
    expect(seq).toBe(301);

    playTicks(h, second, Array.from({ length: 150 }, () => seq++), 20_100, 400);

    const moved = distance(posOf(h, playerId), before);
    expect(moved).toBeGreaterThan(50);
  });

  it('still drops intents numbered at or below what it has already taken', () => {
    // The watermark is a replay guard first, and the fix above must not cost
    // it that job: a batch the server has already accepted must not be
    // accepted a second time, resume or no resume.
    const h = newHost();
    const conn = new FakeConn();
    const welcome = join(h, conn, 0);
    h.onTick();
    const playerId = welcome.playerId;
    standOnOpenRoad(h, playerId);

    const batch = Array.from({ length: 150 }, (_, i) => i + 1);
    playTicks(h, conn, batch, 100, 2);
    idle(h, 60);

    const slot = h.session.slots.get(playerId);
    if (!slot) throw new Error('no slot');
    expect(slot.lastQueuedSeq).toBe(150);

    const beforeReplay = posOf(h, playerId);
    playTicks(h, conn, batch, 10_000, 300); // the same 150 numbers, again
    const replayed = distance(posOf(h, playerId), beforeReplay);
    expect(slot.lastQueuedSeq).toBe(150); // nothing was taken
    expect(replayed).toBeLessThan(20);

    // The control, same connection and same length of batch, numbered on
    // past the watermark: that one is input and it moves the player.
    const beforeFresh = posOf(h, playerId);
    playTicks(h, conn, Array.from({ length: 150 }, (_, i) => 151 + i), 20_000, 600);
    expect(slot.lastQueuedSeq).toBe(300);
    expect(distance(posOf(h, playerId), beforeFresh)).toBeGreaterThan(50);
  });
});
