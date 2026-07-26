/**
 * Entity storage with guaranteed-deterministic iteration order.
 * A bare object or Map iterates in insertion order, which can differ between
 * client and server; every system walks `ids` (always sorted ascending).
 */

export interface HasId {
  id: number;
}

export interface EntityTable<T extends HasId> {
  /** Sorted ascending. The only sanctioned iteration order. */
  ids: number[];
  byId: Record<number, T>;
}

export function createTable<T extends HasId>(): EntityTable<T> {
  return { ids: [], byId: {} };
}

function sortedIndex(ids: number[], id: number): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((ids[mid] as number) < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function insertEntity<T extends HasId>(table: EntityTable<T>, entity: T): void {
  if (table.byId[entity.id] !== undefined) {
    throw new Error(`entity ${entity.id} already exists`);
  }
  table.ids.splice(sortedIndex(table.ids, entity.id), 0, entity.id);
  table.byId[entity.id] = entity;
}

export function removeEntity<T extends HasId>(table: EntityTable<T>, id: number): boolean {
  if (table.byId[id] === undefined) return false;
  delete table.byId[id];
  const i = sortedIndex(table.ids, id);
  if (table.ids[i] === id) table.ids.splice(i, 1);
  return true;
}

export function getEntity<T extends HasId>(table: EntityTable<T>, id: number): T | undefined {
  return table.byId[id];
}

export function cloneTable<T extends HasId>(
  table: EntityTable<T>,
  cloneOne: (t: T) => T,
): EntityTable<T> {
  const byId: Record<number, T> = {};
  for (const id of table.ids) {
    byId[id] = cloneOne(table.byId[id] as T);
  }
  return { ids: table.ids.slice(), byId };
}
