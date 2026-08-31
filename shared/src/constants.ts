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
 * 6: the tuning payload gained an `ambulance` section — the dispatch service
 * that answers casualties.
 * 7: `pedDown` and `copDown` carry the position they went down at, so the
 * client can throw blood for the commonest killing in the game.
 * 8: `InputIntent` gained `viewTick` — which moment of the world the client
 * was looking at when it made this input, so the server can judge the
 * collisions it produced against that same moment (lag compensation; see
 * sim/rewind.ts). It is a required field on the wire, so a client that does
 * not send it cannot be decoded. The vehicle tuning payload also lost
 * `enterRadius` and gained `enterReach`: the door is measured from the
 * bodywork now rather than from the vehicle's centre, which is the only
 * measure that reaches the front of a bus.
 * 9: `welcome` carries `inputSeq` — the last input sequence number the server
 * has taken from this slot. A client numbers its own intents and the server
 * drops anything at or below that watermark; a reloaded tab starts counting
 * at 1 again, so on a resume every intent it sent was dropped until the
 * counter climbed back over the watermark (a whole prior play session's
 * worth). The client now resumes its counter from this field instead, which
 * keeps the numbering monotonic across a reload and leaves the replay guard
 * exactly as strict as it was.
 */
export const PROTOCOL_VERSION = 9;

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
export const MAX_GANGS = 7;
