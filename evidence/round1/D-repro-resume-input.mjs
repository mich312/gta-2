/**
 * R1-D01 — a page reload reconnects the player to a body they cannot move.
 *
 * Part 1 is the original mechanism probe: `Session` alone, showing that the
 * replay watermark survives a resume while the client's counter does not.
 * Part 2 is the same thing end to end through the real `GameHost` — wire
 * frames through the binary codec, `accept`/`receive`/`drop`, and the
 * character's position measured in pixels — because part 1 bypasses
 * `handleJoin` and cannot see the welcome message, which is where the repair
 * lives.
 *
 * Run: `node evidence/round1/D-repro-resume-input.mjs` (after `pnpm build`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const j = (p) => JSON.parse(readFileSync(join(root, 'shared/data', p), 'utf8'));
const shared = await import(join(root, 'shared/dist/index.js'));
const { Session } = await import(join(root, 'server/dist/session.js'));
const { GameHost } = await import(join(root, 'server/dist/host.js'));
const { Economy } = await import(join(root, 'server/dist/economy/economy.js'));
const { parseEconomyParams } = await import(join(root, 'server/dist/economy/awards.js'));
const { MemoryStore } = await import(join(root, 'server/dist/economy/store.js'));
const { nodePasswords } = await import(join(root, 'server/dist/platform/nodePasswords.js'));

shared.initTuning({
  player: j('player.json'),
  vehicles: j('vehicles.json'),
  weapons: j('weapons.json'),
  police: j('police.json'),
  peds: j('peds.json'),
  props: j('props.json'),
  traffic: j('traffic.json'),
});
const worldgen = shared.parseWorldgenParams(j('worldgen.json'));

// ── Part 1: the watermark, at the Session level ───────────────────────────
const s = new Session(7, worldgen, null, { pedCount: 0 });
const slot = s.addPlayer('p', 'tok-1');
s.tick();
const intent = (seq) => ({ ...shared.NULL_INPUT, seq, tick: seq, up: true });

// Play for 30 s at 30 Hz: the client's `seq` counter reaches 900.
for (let n = 1; n <= 900; n++) {
  s.queueInput(slot.playerId, -1, [intent(n)]);
  s.tick();
}
console.log('after 30s of play  lastQueuedSeq =', slot.lastQueuedSeq);

// The tab is reloaded. Socket closes, slot goes to disconnected, the client
// comes back inside the 120 s grace with the resumeToken from sessionStorage.
s.markDisconnected(slot.playerId, Date.now());
const resumed = s.resumeByToken('tok-1');
console.log(
  'resumed same slot  =',
  resumed?.playerId === slot.playerId,
  ' lastQueuedSeq =',
  resumed.lastQueuedSeq,
);

// A client that restarts its numbering at 1 is numbering below the watermark,
// and the guard at session.ts:475 drops every one of those intents. That guard
// is correct and stays: what changed is that the client no longer has to
// restart at 1 — see part 2.
const before = resumed.queue.length;
for (let n = 1; n <= 150; n++) s.queueInput(slot.playerId, -1, [intent(n)]);
console.log('intents accepted after reconnect =', resumed.queue.length - before, 'of 150');
console.log('ticks of dead controls =', slot.lastQueuedSeq, `(~${(slot.lastQueuedSeq / 30).toFixed(0)}s at 30 Hz)`);

// ── Part 2: the same reload, end to end through GameHost ──────────────────
const catalog = shared.parseCatalog(j('shop.json'));
const economyParams = parseEconomyParams(j('economy.json'));

class FakeConn {
  playerId = null;
  bytesIn = 0;
  bytesOut = 0;
  closed = false;
  draining = true;
  sent = [];
  send(msg) {
    this.sent.push(msg);
  }
  close() {
    this.closed = true;
  }
  of(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

const frame = (msg) => shared.binaryCodec.encode(msg);

/** The widest run of road on the map: ground the player can actually walk. */
function openStart(session) {
  const map = session.map;
  let best = { x: 0, y: 0, len: 0 };
  for (let ty = 0; ty < map.heightTiles; ty++) {
    let run = 0;
    for (let tx = 0; tx <= map.widthTiles; tx++) {
      const road = tx < map.widthTiles && map.tiles[ty * map.widthTiles + tx] === 1;
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

function newHost() {
  const session = new Session(7, worldgen, null, { pedCount: 0 });
  const economy = new Economy(new MemoryStore(), catalog, economyParams, nodePasswords);
  return new GameHost({ interestRadius: 600, maxConnections: 64, maxPlayers: 8 }, session, economy);
}

function joinOver(h, conn, nowMs, resumeToken) {
  h.accept(conn, nowMs);
  h.receive(
    conn,
    frame({
      type: 'join',
      protocol: shared.PROTOCOL_VERSION,
      name: 'p',
      ...(resumeToken ? { resumeToken } : {}),
    }),
    nowMs,
  );
  return conn.of('welcome')[0];
}

function play(h, conn, seqs, startMs, startTick) {
  for (let i = 0; i < seqs.length; i++) {
    h.receive(
      conn,
      frame({
        type: 'input',
        ackTick: -1,
        intents: [{ ...shared.NULL_INPUT, seq: seqs[i], tick: startTick + i, right: true }],
      }),
      startMs + i * 33,
    );
    h.onTick();
  }
}

const posOf = (h, id) => ({ ...h.session.state.players.byId[id].pos });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Play 10 s, reload, then send 150 more inputs numbered `numbering`:
 * 'resume' picks up from what `welcome` says, 'restart' is the old client
 * that always began again at 1.
 */
function reloadAndWalk(numbering) {
  const h = newHost();
  const first = new FakeConn();
  const welcome = joinOver(h, first, 0);
  h.onTick();
  const id = welcome.playerId;
  const at = openStart(h.session);
  h.session.state.players.byId[id].pos.x = at.x;
  h.session.state.players.byId[id].pos.y = at.y;

  play(h, first, Array.from({ length: 300 }, (_, i) => i + 1), 100, 2);
  for (let i = 0; i < 60; i++) h.onTick(); // held input lapses; the walk stops

  h.drop(first); // F5
  const before = posOf(h, id);

  const second = new FakeConn();
  const back = joinOver(h, second, 20_000, welcome.resumeToken);
  let seq = 1;
  if (numbering === 'resume' && Number.isFinite(back.inputSeq)) {
    seq = Math.max(seq, back.inputSeq + 1);
  }
  const slot = h.session.slots.get(id);
  const queuedBefore = slot.lastQueuedSeq;
  play(h, second, Array.from({ length: 150 }, () => seq++), 20_100, 400);

  return {
    sameBody: back.playerId === welcome.playerId,
    welcomeInputSeq: back.inputSeq,
    watermark: queuedBefore,
    accepted: slot.lastQueuedSeq - queuedBefore,
    moved: dist(posOf(h, id), before),
  };
}

const line = (label, r) =>
  `${label} : resumedSamePlayer=${r.sameBody} welcome.inputSeq=${r.welcomeInputSeq} ` +
  `lastQueuedSeq=${r.watermark} accepted=${r.accepted} moved ${r.moved.toFixed(2)} px`;

console.log('');
console.log('end to end through GameHost (binary frames, real welcome):');
console.log(line('reloaded client resumes numbering from welcome', reloadAndWalk('resume')));
console.log(line('control: client restarts at seq 1 (replayed)   ', reloadAndWalk('restart')));
