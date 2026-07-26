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
  /** JSON persistence file (FileStore). MySQL replaces this via the same interface. */
  persistPath: string;
  pedCount: number;
  /** Interest-management radius (px): entities beyond it aren't sent. */
  interestRadius: number;
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
    persistPath: env['PERSIST_PATH'] ?? 'data/persist.json',
    pedCount: envInt(env['PED_COUNT'], 200),
    interestRadius: envInt(env['INTEREST_RADIUS'], 600),
  };
}
