export const PROTOCOL_VERSION = 1;

/** Simulation tick rate. The sim advances only in whole ticks of this rate. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
/** Fixed timestep in seconds. The only "dt" that ever touches physics. */
export const DT = 1 / TICK_RATE;

/** Fixed internal render resolution; integer-scaled to the window. */
export const INTERNAL_WIDTH = 480;
export const INTERNAL_HEIGHT = 270;

export const PLAYER_RADIUS = 6;

/** Server includes a state hash in every Nth snapshot (desync tripwire). */
export const SNAPSHOT_HASH_INTERVAL = 15;

/** How long a disconnected player's entity survives awaiting a resume. */
export const RESUME_GRACE_MS = 120_000;

/** Snapshot ring depth on the server; acks older than this get a full resync. */
export const SNAPSHOT_RING_TICKS = 90;
