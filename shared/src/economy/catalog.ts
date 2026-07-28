import type { ShopKind } from '../world/types.js';

/**
 * Shop catalog types. The catalog itself lives in shared/data/shop.json;
 * the server parses it and ships it in the welcome message. Prices are only
 * ever evaluated server-side — the client copy is purely for display.
 */

export type CatalogItem =
  | { kind: 'weapon'; shop: ShopKind; price: number; ammo: number }
  | { kind: 'ammo'; shop: ShopKind; price: number; ammo: number }
  | { kind: 'cosmetic'; shop: ShopKind; price: number; cosmeticId: number }
  /** A respray: clears police heat outright. The genre's escape valve. */
  | { kind: 'spray'; shop: ShopKind; price: number }
  /** Bolted to the car you drove in: bomb, slick, mines, guns. */
  | { kind: 'fitting'; shop: ShopKind; price: number; fitting: string; ammo: number }
  /**
   * The car you drove in, put right. 'panel' beats out the bodywork and
   * replaces the glass and lamps; 'full' also does the radiator and the tyres
   * and takes the health back to showroom. Cosmetic damage being cheap and
   * mechanical damage dear is what makes the choice interesting.
   */
  | { kind: 'repair'; shop: ShopKind; price: number; tier: 'panel' | 'full' }
  /** Patched up at the hospital counter. */
  | { kind: 'heal'; shop: ShopKind; price: number; health: number; armour: number };

export type Catalog = Record<string, CatalogItem>;

export function parseCatalog(raw: unknown): Catalog {
  const items = ((raw ?? {}) as { items?: unknown }).items;
  if (typeof items !== 'object' || items === null) throw new Error('catalog: missing items');
  const out: Catalog = {};
  for (const [id, v] of Object.entries(items as Record<string, unknown>)) {
    const r = (v ?? {}) as Record<string, unknown>;
    const price = r['price'];
    const shop = r['shop'];
    if (typeof price !== 'number' || price <= 0 || !Number.isFinite(price)) {
      throw new Error(`catalog: bad price for ${id}`);
    }
    if (shop !== 'gun' && shop !== 'clothing' && shop !== 'spray' && shop !== 'clinic') {
      throw new Error(`catalog: bad shop for ${id}`);
    }
    switch (r['kind']) {
      case 'weapon':
      case 'ammo': {
        const ammo = r['ammo'];
        if (typeof ammo !== 'number' || ammo <= 0) throw new Error(`catalog: bad ammo for ${id}`);
        out[id] = { kind: r['kind'], shop, price, ammo };
        break;
      }
      case 'spray': {
        out[id] = { kind: 'spray', shop, price };
        break;
      }
      case 'repair': {
        const tier = r['tier'];
        if (tier !== 'panel' && tier !== 'full') throw new Error(`catalog: bad tier for ${id}`);
        out[id] = { kind: 'repair', shop, price, tier };
        break;
      }
      case 'heal': {
        const health = r['health'];
        const armour = r['armour'];
        if (typeof health !== 'number' || typeof armour !== 'number') {
          throw new Error(`catalog: bad heal for ${id}`);
        }
        out[id] = { kind: 'heal', shop, price, health, armour };
        break;
      }
      case 'fitting': {
        const fitting = r['fitting'];
        const ammo = r['ammo'];
        if (typeof fitting !== 'string' || typeof ammo !== 'number') {
          throw new Error(`catalog: bad fitting for ${id}`);
        }
        out[id] = { kind: 'fitting', shop, price, fitting, ammo };
        break;
      }
      case 'cosmetic': {
        const cosmeticId = r['cosmeticId'];
        if (typeof cosmeticId !== 'number') throw new Error(`catalog: bad cosmeticId for ${id}`);
        out[id] = { kind: 'cosmetic', shop, price, cosmeticId };
        break;
      }
      default:
        throw new Error(`catalog: unknown kind for ${id}`);
    }
  }
  return out;
}
