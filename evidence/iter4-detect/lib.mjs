// Shared loader for this round's measurement scripts.
//
//   node evidence/iter4-detect/measure-lanes-reachability.mjs
//
// The repo root is derived from this file's own location (evidence/iter4-detect/),
// so the scripts run from any checkout. `pnpm build` first: they read
// `shared/dist`, the same decoder `mapaudit` uses.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
export const ROOT = R;
export const S = await import(`file://${R}/shared/dist/index.js`);

/** Decode a `city.data.ts` — the shipped one, or any other by path. */
export function loadBake(p) {
  const src = readFileSync(p, 'utf8');
  const a = src.indexOf('"');
  const b = src.lastIndexOf('"');
  if (a < 0 || b <= a) throw new Error(`${p} does not look like a city.data.ts`);
  return S.decodeBakedCity(JSON.parse(JSON.parse(src.slice(a, b + 1))));
}

export const plan = S.parseCityPlan(JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8')));
export const NEW = `${R}/shared/src/world/city.data.ts`;
/**
 * The asset before iteration 3 planted the country outside the blocks and
 * stopped the ride being a ruler. Not in the tree — take it out of git first:
 *
 *   git show e3306c8~2:shared/src/world/city.data.ts > /tmp/prefix.city.data.ts
 */
export const OLD = process.env.OLD_CITY_DATA ?? '/tmp/prefix.city.data.ts';
