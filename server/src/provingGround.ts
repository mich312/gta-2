import {
  PLAYER_RADIUS,
  TILE_SIZE,
  type CityMap,
  type DepotRow,
  type GameState,
  type SimCommand,
  boxInSolid,
  boxesOverlap,
  dCos,
  dSin,
  depotRow,
  getVehicleTuning,
  vehicleBox,
  vehicleBoxAt,
} from 'shared';

/**
 * The proving ground counter.
 *
 * Everything here is deliberately outside the economy: no ledger entry, no
 * price, no standings, no district. It exists so a physics change can be
 * driven at instead of only argued about, and the moment it starts sharing
 * code with the shop it becomes a hole in the one system in the game that is
 * about scarcity.
 *
 * It grants nothing except through `SimCommand`s that already existed for
 * other reasons — `spawnVehicle`, `grantWeapon`, `healPlayer` — so a session
 * with the proving ground on still records and replays exactly like any
 * other. Nothing here can produce a state the ordinary game could not.
 */

/** How far out to look for somewhere a vehicle actually fits, in tiles. */
const SPAWN_SEARCH_TILES = 6;
/** Spacing between the cars in the row, px. Roughly two car lengths. */
const ROW_SPACING = 70;

export interface DepotResult {
  ok: boolean;
  message: string;
  commands: SimCommand[];
  /** Cash to credit, if the row hands out money. */
  cash: number;
}

/** Is this player standing in a proving ground? */
export function inProvingGround(state: GameState, map: CityMap, playerId: number): boolean {
  const p = state.players.byId[playerId];
  if (!p) return false;
  return map.shops.some((s) => {
    if (s.kind !== 'depot') return false;
    const cx = (s.doorX + 0.5) * TILE_SIZE;
    const cy = (s.doorY + 0.5) * TILE_SIZE;
    if (Math.abs(p.pos.x - cx) < TILE_SIZE * 2 && Math.abs(p.pos.y - cy) < TILE_SIZE * 2) {
      return true;
    }
    const r = s.interior;
    return (
      p.pos.x >= r.x * TILE_SIZE &&
      p.pos.y >= r.y * TILE_SIZE &&
      p.pos.x <= (r.x + r.w) * TILE_SIZE &&
      p.pos.y <= (r.y + r.h) * TILE_SIZE
    );
  });
}

/**
 * Somewhere a vehicle of `kind` actually fits, nearest to (x, y) first.
 *
 * Tile CENTRES rather than a ring of bearings, for the reason the boat
 * disembark learned the hard way: a polar search can thread a bearing between
 * two candidate tiles and report a clear yard as blocked. `taken` carries the
 * spots already handed out this call, so a row of six cars does not stack all
 * six on the same paving slab.
 */
function clearSpot(
  state: GameState,
  map: CityMap,
  kind: string,
  x: number,
  y: number,
  heading: number,
  taken: Array<{ x: number; y: number }>,
): { x: number; y: number } | null {
  const t = getVehicleTuning(kind);
  const tx0 = Math.floor(x / TILE_SIZE);
  const ty0 = Math.floor(y / TILE_SIZE);
  const candidates: Array<{ d2: number; x: number; y: number }> = [];
  for (let ty = ty0 - SPAWN_SEARCH_TILES; ty <= ty0 + SPAWN_SEARCH_TILES; ty++) {
    for (let tx = tx0 - SPAWN_SEARCH_TILES; tx <= tx0 + SPAWN_SEARCH_TILES; tx++) {
      const cx = (tx + 0.5) * TILE_SIZE;
      const cy = (ty + 0.5) * TILE_SIZE;
      const dx = cx - x;
      const dy = cy - y;
      candidates.push({ d2: dx * dx + dy * dy, x: cx, y: cy });
    }
  }
  candidates.sort((a, b) => a.d2 - b.d2);

  for (const c of candidates) {
    if (boxInSolid(map, c, t.halfExtent, t.medium)) continue;
    const box = vehicleBoxAt(kind, c.x, c.y, heading);
    let blocked = false;
    for (const id of state.vehicles.ids) {
      const v = state.vehicles.byId[id];
      if (v && boxesOverlap(box, vehicleBox(v))) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const spot of taken) {
      if (boxesOverlap(box, vehicleBoxAt(kind, spot.x, spot.y, heading))) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    // Not on top of somebody's head either.
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (p && p.mode === 'foot' && boxInSolid(map, p.pos, PLAYER_RADIUS) === false) {
        const dx = p.pos.x - c.x;
        const dy = p.pos.y - c.y;
        if (dx * dx + dy * dy < (t.halfLength + PLAYER_RADIUS) ** 2) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;
    return { x: c.x, y: c.y };
  }
  return null;
}

/**
 * Hand over one row of the counter.
 *
 * `nextId` allocates entity ids the same way the session does; the caller
 * passes its own allocator so the proving ground cannot get out of step with
 * it.
 */
export function grantDepotRow(
  state: GameState,
  map: CityMap,
  playerId: number,
  rowId: string,
  weaponIds: readonly string[],
  nextId: () => number,
): DepotResult {
  const nothing = (message: string): DepotResult => ({
    ok: false,
    message,
    commands: [],
    cash: 0,
  });
  const row: DepotRow | null = depotRow(rowId);
  if (!row) return nothing('no such thing on the counter');
  const player = state.players.byId[playerId];
  if (!player) return nothing('no player');
  if (!inProvingGround(state, map, playerId)) return nothing('find the proving ground');

  switch (row.grant.kind) {
    case 'vehicle': {
      const { vehicle, count } = row.grant;
      // Laid out along the way the player is looking, so a row of cars is a
      // row you can drive down rather than a heap you have to pick through.
      const heading = player.aimAngle;
      const commands: SimCommand[] = [];
      const taken: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < count; i++) {
        // The first one goes a body-length ahead so it never lands on you.
        const reach = ROW_SPACING * (i + 1);
        const wantX = player.pos.x + dCos(heading) * reach;
        const wantY = player.pos.y + dSin(heading) * reach;
        const spot = clearSpot(state, map, vehicle, wantX, wantY, heading, taken);
        if (!spot) continue;
        taken.push(spot);
        commands.push({
          type: 'spawnVehicle',
          vehicleId: nextId(),
          kind: vehicle,
          x: spot.x,
          y: spot.y,
          heading,
        });
      }
      if (commands.length === 0) return nothing(`no room for a ${vehicle} here`);
      const what = commands.length === 1 ? vehicle : `${commands.length} x ${vehicle}`;
      return { ok: true, message: `${what} — on the house`, commands, cash: 0 };
    }
    case 'arsenal': {
      return {
        ok: true,
        message: 'tooled up',
        commands: weaponIds.map((weaponId) => ({
          type: 'grantWeapon' as const,
          playerId,
          weaponId,
          ammo: 999,
        })),
        cash: 0,
      };
    }
    case 'patch': {
      // The command clamps to the tuned maxima, so asking for a lot is the
      // same as asking for full.
      return {
        ok: true,
        message: 'patched up',
        commands: [{ type: 'healPlayer', playerId, health: 9999, armour: 9999 }],
        cash: 0,
      };
    }
    case 'cash': {
      return { ok: true, message: `+$${row.grant.amount}`, commands: [], cash: row.grant.amount };
    }
  }
}
