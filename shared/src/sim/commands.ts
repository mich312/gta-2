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
  | { type: 'spawnVehicle'; vehicleId: number; kind: string; x: number; y: number; heading: number }
  | { type: 'spawnPed'; pedId: number; x: number; y: number }
  | { type: 'spawnProp'; propId: number; kind: string; x: number; y: number; orient: number }
  | { type: 'spawnPickup'; pickupId: number; kind: PickupKind; x: number; y: number }
  /** Taken off the map with no wreck and no bang: the crusher ate it. */
  | { type: 'crushVehicle'; vehicleId: number }
  /** The garage bolts something to the car the player is sitting in. */
  | { type: 'fitVehicle'; playerId: number; fitting: string; ammo: number }
  /** Patched up at a hospital counter. */
  | { type: 'healPlayer'; playerId: number; health: number; armour: number }
  /** Into the back of an ambulance or a taxi: off the map until dropped off. */
  | { type: 'despawnPed'; pedId: number };
