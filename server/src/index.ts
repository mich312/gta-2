import { loadConfig } from './config.js';
import { loadSharedTuning } from './tuning.js';
import { Session } from './session.js';
import { GameServer } from './net/wsServer.js';
import { TickLoop } from './loop.js';
import { createFileRecorder } from './replay/record.js';

async function main(): Promise<void> {
  const config = loadConfig();
  loadSharedTuning();

  const recorder = config.replayDir ? createFileRecorder(config.replayDir, config.seed) : null;
  const session = new Session(config.seed, recorder);
  const server = new GameServer(config, session);
  await server.listen();

  const loop = new TickLoop(() => server.onTick());
  loop.start();

  // The harness greps for this exact prefix to know the server is up.
  console.log(`listening on ws://${config.host}:${config.port} seed=${config.seed}`);

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
