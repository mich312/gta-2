import { readFileSync } from 'node:fs';
const j = (p) => JSON.parse(readFileSync('/home/user/gta-2/shared/data/'+p,'utf8'));
const shared = await import('/home/user/gta-2/shared/dist/index.js');
const { Session } = await import('/home/user/gta-2/server/dist/session.js');
shared.initTuning({ player: j('player.json'), vehicles: j('vehicles.json'), weapons: j('weapons.json'), police: j('police.json'), peds: j('peds.json') });
const worldgen = shared.parseWorldgenParams(j('worldgen.json'));
const s = new Session(7, worldgen, null, { pedCount: 0 });
const slot = s.addPlayer('p', 'tok-1');
s.tick();
const intent = (seq) => ({ ...shared.NULL_INPUT, seq, tick: seq, up: true });

// Play for 30 s at 30 Hz: the client's `seq` counter reaches 900.
for (let n = 1; n <= 900; n++) { s.queueInput(slot.playerId, -1, [intent(n)]); s.tick(); }
console.log('after 30s of play  lastQueuedSeq =', slot.lastQueuedSeq);

// The tab is reloaded. Socket closes, slot goes to disconnected, the client
// comes back inside the 120 s grace with the resumeToken from sessionStorage.
s.markDisconnected(slot.playerId, Date.now());
const resumed = s.resumeByToken('tok-1');
console.log('resumed same slot  =', resumed?.playerId === slot.playerId, ' lastQueuedSeq =', resumed.lastQueuedSeq);

// main.ts re-initialises `let seq = 1` on reload, so the reconnected client
// starts numbering from 1 again. Feed it 5 s of held-forward input.
const before = resumed.queue.length;
for (let n = 1; n <= 150; n++) s.queueInput(slot.playerId, -1, [intent(n)]);
console.log('intents accepted after reconnect =', resumed.queue.length - before, 'of 150');
console.log('ticks of dead controls =', slot.lastQueuedSeq, `(~${(slot.lastQueuedSeq/30).toFixed(0)}s at 30 Hz)`);
