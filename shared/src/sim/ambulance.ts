import { TICK_RATE } from '../constants.js';
import { getTuning } from '../tuning.js';
import type { GameState, PedState, VehicleState } from './state.js';
import {
  aiSpawnPlacement,
  assignGoto,
  holdAt,
  isAiDriver,
  putAiVehicle,
  releaseErrand,
  type AiSpawnPlacement,
} from './traffic.js';
import { dAtan2 } from '../math/trig.js';
import { drivableAt, drivableTile, planRoute } from './roadgrid.js';
import { TILE_SIZE } from '../world/types.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';

/**
 * The ambulance service.
 *
 * One pedestrian "kill" in `downOneIn` leaves somebody down but alive, bleeding
 * out on a clock (see peds.ts). Until now the only thing in the city that could
 * do anything about that was a player who happened to be driving an ambulance
 * and happened to be looking — so in every session where nobody was playing the
 * job, every casualty ever produced died on the pavement. The city had an
 * ambulance JOB and no ambulance SERVICE.
 *
 * This is the service. It is deliberately slower off the mark than a player is
 * (`responseDelaySec`) and stands off any casualty a player-driven ambulance is
 * already closing on (`playerClaimDist`), because the job is the better content
 * and must keep first refusal: the service exists to make the outcome of your
 * violence uncertain, not to take the fare.
 *
 * It rides entirely on machinery that already existed. `assignGoto` drives the
 * van (traffic.ts), `holdAt` parks it at the scene, and the whole of the
 * bookkeeping lives in `GameState.ambulanceCalls`, which never goes on the
 * wire — what a client sees is a van pulling up and somebody getting to their
 * feet.
 */

/**
 * Where an ambulance can park to reach somebody.
 *
 * NOT the casualty's own position. Peds walk pavements, plazas and park
 * interiors, and `planRoute` only snaps a destination onto the road grid
 * within three tiles — so routing straight at a casualty who had wandered a
 * little way in returned no route at all, and the whole dispatch silently
 * did nothing. (Worse: it did nothing AFTER turning a van out, so every
 * unreachable casualty leaked an ambulance onto the streets.)
 *
 * Deterministic: row-major scan, strict improvement only.
 */
function sceneFor(map: CityMap, ped: PedState, reach: number): { x: number; y: number } | null {
  if (drivableAt(map, ped.pos.x, ped.pos.y)) return { x: ped.pos.x, y: ped.pos.y };
  const tx0 = Math.floor(ped.pos.x / TILE_SIZE);
  const ty0 = Math.floor(ped.pos.y / TILE_SIZE);
  const rings = Math.ceil(reach / TILE_SIZE);
  let best: { x: number; y: number } | null = null;
  let bestD = reach * reach;
  for (let ty = ty0 - rings; ty <= ty0 + rings; ty++) {
    for (let tx = tx0 - rings; tx <= tx0 + rings; tx++) {
      if (!drivableTile(map, tx, ty)) continue;
      const cx = (tx + 0.5) * TILE_SIZE;
      const cy = (ty + 0.5) * TILE_SIZE;
      const d = (cx - ped.pos.x) ** 2 + (cy - ped.pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
  }
  return best;
}

/** Casualties: down, alive, and not yet in the back of anybody's van. */
function isCasualty(ped: PedState | undefined): ped is PedState {
  return !!ped && ped.mode === 'downed';
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** True if any player is driving an ambulance close enough to claim this one. */
function playerIsAnswering(state: GameState, ped: PedState, within: number): boolean {
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || p.mode !== 'driving' || p.vehicleId === null) continue;
    const v = state.vehicles.byId[p.vehicleId];
    if (!v || v.kind !== 'ambulance') continue;
    if (dist(v.pos.x, v.pos.y, ped.pos.x, ped.pos.y) <= within) return true;
  }
  return false;
}

/** Distance from a point to the nearest player, or Infinity with nobody about. */
function nearestPlayerDist(state: GameState, x: number, y: number): number {
  let best = Infinity;
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p) continue;
    best = Math.min(best, dist(p.pos.x, p.pos.y, x, y));
  }
  return best;
}

/**
 * An ambulance already in ambient traffic and not on a call, nearest first.
 * Reuse before spawning: the streets already have the odd one circulating
 * (traffic.json `mix`), and one that is genuinely nearby beats one conjured at
 * the hospital every time.
 */
function idleAmbulance(state: GameState, x: number, y: number, within: number): number | null {
  let best: number | null = null;
  let bestD = within;
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (!v || v.kind !== 'ambulance' || v.condition !== 'ok') continue;
    if (!isAiDriver(v.driverId)) continue;
    if (state.ambulanceCalls[id]) continue;
    const d = dist(v.pos.x, v.pos.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/**
 * Turn a van out to a call.
 *
 * The nearest kerbside spot to the scene that is still far enough from every
 * player that nobody watches an ambulance appear — which is what a dispatcher
 * does, and, less romantically, the only thing that arrives in time. Sending
 * one from the door of the nearest hospital was the first attempt and it read
 * beautifully in the code and terribly in play: the hospital is routinely
 * most of a kilometre from the accident, so the van spent the casualty's
 * entire bleed-out clock in traffic and turned up to a body.
 *
 * Chosen by minimum distance rather than from an rng offset, deliberately:
 * dispatch must not perturb the shared random stream, because everything else
 * that draws from it — cop spawns, ped wander, weapon spread — would then
 * depend on whether somebody, somewhere, had run a pedestrian over.
 */
function turnOutNearest(
  state: GameState,
  map: CityMap,
  ped: PedState,
  scene: { x: number; y: number },
): number | null {
  const t = getTuning().ambulance;
  let chosen: AiSpawnPlacement | null = null;
  let chosenD = Infinity;
  for (const s of map.vehicleSpawns) {
    const toScene = dist(s.x, s.y, scene.x, scene.y);
    if (toScene < t.spawnMinDist || toScene > t.spawnMaxDist) continue;
    if (toScene >= chosenD) continue;
    if (nearestPlayerDist(state, s.x, s.y) < t.spawnMinDist) continue;
    // Facing the way the call is, not the way the parking bay happens to
    // point: a van put down backwards has to complete a U-turn before it can
    // set off, and a U-turn is taken at `turnSpeed`.
    const place = aiSpawnPlacement(state, map, s, dAtan2(scene.y - s.y, scene.x - s.x));
    if (!place) continue;
    // And a road that connects. Checked BEFORE the van exists, so a call that
    // cannot be driven costs nothing instead of leaving an ambulance stranded
    // on the far side of the city for the rest of the session.
    if (!planRoute(map, place.x, place.y, scene.x, scene.y)) continue;
    chosen = place;
    chosenD = toScene;
  }
  if (!chosen) return null;
  // An ordinary ambient driver with somewhere to be: same id band, same lane
  // placement, same rolling start — so if the call falls through it is simply
  // another van on the street rather than a special case anything must know
  // about.
  return putAiVehicle(state, 'ambulance', chosen);
}

/**
 * Ticks a van may make no progress towards the scene before the call is
 * abandoned.
 *
 * Ambient traffic can wedge — nosed into a gap it cannot take, reversing out,
 * trying the same gap again. That cycle is bounded for a car with nowhere in
 * particular to be, and unbounded for one being told to go somewhere: a van
 * caught in it sat 270 px from a casualty for the whole bleed-out clock,
 * shuffling back and forth, while dispatch counted the call as in hand.
 * Giving up releases the van into ordinary cruise, which breaks the cycle,
 * and the next cadence sends somebody at the problem from a fresh direction.
 */
const STALL_GIVE_UP_TICKS = 150;
/**
 * How long a failed attempt is remembered.
 *
 * Deleting the record outright was worse than useless: the next cadence found
 * the same wedged van (still the nearest ambulance to the scene) and sent it
 * at the same gap, so the van shuffled back and forth for the whole clock
 * while dispatch congratulated itself every five seconds. Keeping the spent
 * record for a few seconds takes both the van and the casualty out of the
 * pool for long enough that the van cruises somewhere else, and the next
 * attempt comes at the problem from a different street.
 */
const FAILED_CALL_COOLDOWN_TICKS = 150;

/** Close a call: forget it, and put the driver back into traffic. */
function endCall(state: GameState, vehicleId: number): void {
  delete state.ambulanceCalls[vehicleId];
  releaseErrand(state, vehicleId);
}

/** Abandon an attempt, but remember it — see FAILED_CALL_COOLDOWN_TICKS. */
function abandonCall(state: GameState, vehicleId: number): void {
  const call = state.ambulanceCalls[vehicleId];
  if (call) call.cooldown = FAILED_CALL_COOLDOWN_TICKS;
  releaseErrand(state, vehicleId);
}

/**
 * One tick of the service: work the calls already out, then send one more.
 *
 * Runs after stepPeds so this tick's casualties are visible to dispatch, and
 * after stepTraffic so a van assigned here sets off on the NEXT tick — one
 * tick of dispatch delay, by construction rather than by accident, exactly
 * like the crowd's reaction to a gunshot.
 */
export function stepAmbulance(state: GameState, map: CityMap, events: SimEvent[]): void {
  const t = getTuning().ambulance;

  // Integer-like keys iterate in ascending numeric order, so this is stable.
  for (const key of Object.keys(state.ambulanceCalls)) {
    const vehicleId = Number(key);
    const call = state.ambulanceCalls[vehicleId];
    if (!call) continue;
    // A spent attempt, sitting out its cooldown.
    if (call.cooldown > 0) {
      if (--call.cooldown <= 0) delete state.ambulanceCalls[vehicleId];
      continue;
    }
    const v = state.vehicles.byId[vehicleId];
    const ped = state.peds.byId[call.pedId];

    // The van is gone, wrecked, or somebody jacked it out from under the
    // driver: the call is off, and so is the errand.
    if (!v || v.condition !== 'ok' || !isAiDriver(v.driverId)) {
      endCall(state, vehicleId);
      continue;
    }
    // The patient is gone: they bled out into a body, a player's ambulance got
    // there first, or something finished them off. Nothing to answer.
    if (!isCasualty(ped)) {
      endCall(state, vehicleId);
      continue;
    }

    const scene = sceneFor(map, ped, t.crewReach);
    if (!scene) {
      // Dragged somewhere no road reaches. Nothing on wheels is coming.
      endCall(state, vehicleId);
      continue;
    }
    const d = dist(v.pos.x, v.pos.y, scene.x, scene.y);
    const driver = state.trafficDrivers[vehicleId];
    const stillDriving = driver?.mission === 'goto';
    // Close enough to the parking spot to pull up and get out — or, if the
    // errand has run its course, as close as the road ever allowed. Both
    // halves are needed: a van drives a LANE, up to a tile and a half off the
    // route's centre-line, so it can finish its route without ever touching
    // the destination point; and a van that gave up because no road connects
    // any more has not arrived anywhere.
    const onScene = d <= t.sceneRadius || (!stillDriving && d <= t.sceneRadius * 2);
    if (!onScene) {
      // Making progress? A van that is not is wedged, and no amount of
      // waiting will unwedge it — see STALL_GIVE_UP_TICKS.
      if (d < call.best - 1) {
        call.best = d;
        call.stall = 0;
      } else if (++call.stall > STALL_GIVE_UP_TICKS) {
        abandonCall(state, vehicleId);
        continue;
      }
      // Still driving. The casualty does not move, so the route stays good;
      // `assignGoto` is re-issued only if the errand has lapsed — a shunt, a
      // panic, or a plan that could not be followed.
      if (!stillDriving && driver?.mission !== 'tend') {
        if (!assignGoto(state, map, vehicleId, scene.x, scene.y)) endCall(state, vehicleId);
      }
      continue;
    }

    // On scene. Stop, and work on them — but only once actually stopped, so a
    // van that arrives at speed does not treat somebody through the windscreen.
    if (!holdAt(state, vehicleId)) {
      endCall(state, vehicleId);
      continue;
    }
    if (Math.abs(v.speed) > 12) continue;
    if (call.treat > 0) {
      call.treat--;
      continue;
    }
    // Back on their feet. Not merely un-downed: full health, because the
    // alternative is somebody who gets up with 1 hp and dies to the next
    // bump, which reads as the ambulance having done nothing.
    ped.health = getTuning().peds.health;
    ped.mode = 'walk';
    ped.timer = 0;
    ped.targetId = null;
    events.push({
      type: 'casualtySaved',
      tick: state.tick,
      pedId: ped.id,
      x: Math.round(ped.pos.x),
      y: Math.round(ped.pos.y),
    });
    endCall(state, vehicleId);
  }

  if (state.tick % Math.max(1, Math.round(t.dispatchCadenceTicks)) !== 0) return;
  let active = 0;
  for (const key of Object.keys(state.ambulanceCalls)) {
    if (state.ambulanceCalls[Number(key)]) active++;
  }
  if (active >= t.maxActive) return;

  // One dispatch per cadence, to the casualty who has been waiting longest —
  // `timer` counts DOWN from the bleed-out clock, so the lowest is the most
  // urgent, and ties break on id. A ramp, not a wall, exactly as cop spawning
  // is: two casualties in the same second do not summon two vans at once.
  const bleedOut = Math.round(getTuning().peds.bleedOutSec * TICK_RATE);
  const noticedAfter = bleedOut - Math.round(t.responseDelaySec * TICK_RATE);
  let worst: PedState | null = null;
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!isCasualty(ped)) continue;
    // Only somebody who has been down long enough for the city to have
    // noticed, and whom no player is already on their way to.
    if (ped.timer > noticedAfter) continue;
    if (nearestPlayerDist(state, ped.pos.x, ped.pos.y) > t.callRadius) continue;
    if (playerIsAnswering(state, ped, t.playerClaimDist)) continue;
    if (claimed(state, id)) continue;
    if (!worst || ped.timer < worst.timer) worst = ped;
  }
  if (!worst) return;
  // Where the van will actually be able to stop. No parking spot, no call.
  const scene = sceneFor(map, worst, t.crewReach);
  if (!scene) return;

  const vehicleId =
    idleAmbulance(state, scene.x, scene.y, t.reuseRadius) ??
    turnOutNearest(state, map, worst, scene);
  if (vehicleId === null) return;
  if (!assignGoto(state, map, vehicleId, scene.x, scene.y)) {
    // No road connects the two. A freshly-turned-out van stays in traffic as
    // an ordinary ambient ambulance rather than being deleted.
    return;
  }
  const van = state.vehicles.byId[vehicleId] as VehicleState;
  state.ambulanceCalls[vehicleId] = {
    pedId: worst.id,
    treat: Math.round(t.treatSec * TICK_RATE),
    best: dist(van.pos.x, van.pos.y, scene.x, scene.y),
    stall: 0,
    cooldown: 0,
  };
}

/** Is somebody already on their way to this casualty? */
function claimed(state: GameState, pedId: number): boolean {
  for (const key of Object.keys(state.ambulanceCalls)) {
    if (state.ambulanceCalls[Number(key)]?.pedId === pedId) return true;
  }
  return false;
}

/** The vehicle a call is riding on, for tests and tools. */
export function ambulanceAnsweringPed(state: GameState, pedId: number): VehicleState | null {
  for (const key of Object.keys(state.ambulanceCalls)) {
    const vehicleId = Number(key);
    if (state.ambulanceCalls[vehicleId]?.pedId === pedId) {
      return state.vehicles.byId[vehicleId] ?? null;
    }
  }
  return null;
}
