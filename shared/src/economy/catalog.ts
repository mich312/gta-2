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
  | { kind: 'spray'; shop: ShopKind; price: number };

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
    if (shop !== 'gun' && shop !== 'clothing' && shop !== 'spray') {
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
