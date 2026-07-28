/**
 * Sim commands: the ONLY write-path into the deterministic sim from the
 * outside world (connection lifecycle now; economy grants from phase 5).
 * Commands are tick-stamped by the session, applied at tick boundaries like
 * inputs, and recorded in replay files — so replays reproduce exactly even
 * though the code emitting commands (joins, purchases) is not deterministic.
 */
import type { PickupKind, WeaponSlot } from './state.js';

export type SimCommand =
  | { type: 'spawnPlayer'; playerId: number; name: string; loadout?: WeaponSlot[] }
  | { type: 'respawnPlayer'; playerId: number; loadout: WeaponSlot[]; atStation?: boolean }
  | { type: 'despawnPlayer'; playerId: number }
  | { type: 'grantWeapon'; playerId: number; weaponId: string; ammo: number }
  | { type: 'setCosmetic'; playerId: number; cosmeticId: number }
  | { type: 'clearHeat'; playerId: number }
  | { type: 'addHeat'; playerId: number; amount: number }
  | {
      type: 'spawnVehicle';
      vehicleId: number;
      kind: string;
      x: number;
      y: number;
      heading: number;
      /** Whose car it is, or 0/absent for anybody's. */
      gangId?: number;
    }
  | { type: 'spawnPed'; pedId: number; x: number; y: number }
  | { type: 'spawnProp'; propId: number; kind: string; x: number; y: number; orient: number }
  | { type: 'spawnPickup'; pickupId: number; kind: PickupKind; x: number; y: number }
  /** Taken off the map with no wreck and no bang: the crusher ate it. */
  | { type: 'crushVehicle'; vehicleId: number }
  /** The garage bolts something to the car the player is sitting in. */
  | { type: 'fitVehicle'; playerId: number; fitting: string; ammo: number }
  /** ...or puts it right: panels and glass, or the whole car. */
  | { type: 'repairVehicle'; playerId: number; tier: 'panel' | 'full' }
  /** Patched up at a hospital counter. */
  | { type: 'healPlayer'; playerId: number; health: number; armour: number }
  | {
      /**
       * Put a pedestrian in somebody's care, or take them out of it with a
       * null playerId. Issued by the mission system, which chooses who — the
       * sim only carries out the assignment.
       */
      type: 'setEscort';
      pedId: number;
      playerId: number | null;
    }
  /** Into the back of an ambulance or a taxi: off the map until dropped off. */
  | { type: 'despawnPed'; pedId: number }
  /**
   * The window learns to walk (WORLDGEN.md §11.2 B2/B3): the session's
   * viewport onto the unbounded world moves to a new origin. Players (and
   * the vehicles they are driving) shift by the pixel delta into the new
   * frame; every ambient entity — AI traffic, peds, cops, props, pickups,
   * projectiles — despawns with the old region, and the session reseeds
   * the new one with ordinary spawn commands in the same tick. Recorded
   * like every command, so a replay re-walks the same world.
   */
  | { type: 'rebase'; windowX: number; windowY: number; dxPx: number; dyPx: number };
