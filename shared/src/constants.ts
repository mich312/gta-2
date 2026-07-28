/**
 * Bumped whenever the wire contract changes shape — including the tuning
 * payload in `welcome`, because the client parses it and a missing key used to
 * throw inside the message handler and leave the game on "connecting…"
 * for ever. 2: traffic tuning gained steerGain/turnSpeed/brakeDistance/
 * reverseTicks and lost turnProbe/laneHalfWidth. 3: traffic tuning gained the
 * Intelligent Driver Model parameters (minGap/timeHeadway/comfortAccel/
 * comfortBrake/scanHorizon). 4: vehicle tuning gained halfLength/halfWidth/
 * mass, and VehicleState gained the damage map (zones/broken) while health
 * became an integer varint rather than a float.
 * 5: pedestrians gained a `dead` mode (a body that stays in the street) and a
 * `targetId`; pickups gained a `weapon` kind with `weaponId`/`ammo`; ped
 * tuning gained the armed-civilian and corpse numbers.
 */
export const PROTOCOL_VERSION = 5;

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

/** Hard ceiling on gangs, and therefore the width of a respect vector. */
export const MAX_GANGS = 4;
