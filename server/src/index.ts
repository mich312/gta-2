import { TICK_RATE, getTuning } from 'shared';
import { loadConfig } from './config.js';
import { loadCatalog, loadEconomyParams, loadSharedTuning, loadWorldgenParams } from './tuning.js';
import { Economy } from './economy/economy.js';
import { createStore } from './economy/createStore.js';
import { nodePasswords } from './platform/nodePasswords.js';
import { Session } from './session.js';
import { GameServer } from './net/wsServer.js';
import { TickLoop } from './loop.js';
import { createFileRecorder } from './replay/record.js';

async function main(): Promise<void> {
  const config = loadConfig();
  loadSharedTuning(config.difficulty);
  // The flag reaches the city through worldgen, and worldgen rides in the
  // welcome message — so the client builds exactly the same map rather than
  // disagreeing with the server about where the walls are.
  const worldgen = { ...loadWorldgenParams(), provingGround: config.provingGround };

  const recorder = config.replayDir
    ? createFileRecorder(config.replayDir, {
        seed: config.seed,
        tickRate: TICK_RATE,
        startedAt: new Date().toISOString(),
        tuning: getTuning(),
        worldgen,
      })
    : null;
  const session = new Session(config.seed, worldgen, recorder, {
    weaponsLostOnDeath: config.weaponsLostOnDeath,
    pedCount: config.pedCount,
  });
  const economy = new Economy(
    createStore(config.persistPath),
    loadCatalog(),
    loadEconomyParams(),
    nodePasswords,
  );
  const server = new GameServer(config, session, economy);
  await server.listen();

  const loop = new TickLoop(() => server.onTick());
  loop.start();

  // The harness greps for this exact prefix to know the server is up.
  const clientNote = config.clientDir ? ` (serving client from ${config.clientDir})` : '';
  console.log(`listening on ws://${config.host}:${config.port} seed=${config.seed}${clientNote}`);
  if (config.provingGround) {
    // Loud on purpose. Anybody who joins this session can help themselves to
    // a tank, and that should never be a surprise to whoever started it.
    console.log('PROVING GROUND ON — free vehicles and kit from the depot near spawn');
  }

  const shutdown = (): void => {
    loop.stop();
    server.close();
    recorder?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
