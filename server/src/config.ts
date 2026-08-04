export interface ServerConfig {
  host: string;
  port: number;
  seed: number;
  /**
   * Design flag (decided in PLAN review): whether death costs you your guns.
   * Consumed from phase 4 on — it controls what loadout the respawn
   * SimCommand carries, never sim code itself, so both settings replay
   * deterministically.
   */
  weaponsLostOnDeath: boolean;
  /** null disables replay recording. */
  replayDir: string | null;
  /**
   * Persistence path: *.db => SQLite (node:sqlite, default), *.json =>
   * FileStore. A *.db path on a Node without node:sqlite degrades to the
   * FileStore at the sibling .json path rather than failing to boot.
   */
  persistPath: string;
  pedCount: number;
  /** Interest-management radius (px): entities beyond it aren't sent. */
  interestRadius: number;
  /**
   * Sockets allowed at once, joined or not.
   *
   * A connection is not free before anybody joins on it — it carries a parse
   * budget and a place in every fan-out loop — and nothing else bounds how
   * many an anonymous peer may open.
   */
  maxConnections: number;
  /**
   * Players allowed in the session at once.
   *
   * Each one is an entity in the sim plus a 90-deep ring of the filtered
   * snapshots sent to them. The game is designed around 4-8 and measured
   * healthy at 16; the default leaves room above that without leaving the
   * count unbounded. Reconnecting players are exempt (see `handleJoin`).
   */
  maxPlayers: number;
  /**
   * When set, the server also serves the built client from this directory over
   * HTTP and carries the WebSocket on the same port — one origin behind a TLS
   * proxy. When null (local dev), it's a standalone WS server and the client is
   * served separately by Vite.
   */
  clientDir: string | null;
  /**
   * Put a proving ground in the city: a room that hands out vehicles and kit
   * for nothing, so a physics change can be driven at.
   *
   * Off unless asked for, and it has to stay that way: it is a free-cars
   * room, and a session with one is not a session anybody's economy means
   * anything in. It reaches worldgen as a parameter rather than a private
   * server flag, so the client builds the same city from the same numbers.
   */
  provingGround: boolean;
  /**
   * Which police preset the session runs (see police.json `presets`).
   *
   * Server-side on purpose: in a shared city, a difficulty each player picks
   * for themselves is not a setting, it is a cheat. The resolved numbers
   * reach clients in `welcome` like every other tunable.
   */
  difficulty: string;
}

function envInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    host: env['HOST'] ?? '127.0.0.1',
    port: envInt(env['PORT'], 8080),
    // Seed is server-chosen per session; not sim code, so Date.now is fine here.
    seed: envInt(env['SEED'], Date.now() >>> 0),
    weaponsLostOnDeath: env['WEAPONS_LOST_ON_DEATH'] !== 'false',
    replayDir: env['REPLAY'] === '0' ? null : (env['REPLAY_DIR'] ?? 'replays'),
    persistPath: env['PERSIST_PATH'] ?? 'data/persist.db',
    pedCount: envInt(env['PED_COUNT'], 200),
    interestRadius: envInt(env['INTEREST_RADIUS'], 600),
    maxConnections: envInt(env['MAX_CONNECTIONS'], 128),
    maxPlayers: envInt(env['MAX_PLAYERS'], 32),
    clientDir: env['CLIENT_DIR'] ?? null,
    provingGround: env['PROVING_GROUND'] === '1' || env['PROVING_GROUND'] === 'true',
    difficulty: env['DIFFICULTY'] ?? 'normal',
  };
}
