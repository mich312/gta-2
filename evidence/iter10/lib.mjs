// Shared loader for iteration 5's measurement scripts.
//   node evidence/iter5/<script>.mjs
// `pnpm build` first: these read `shared/dist`, the same decoder mapaudit uses.
import { readFileSync } from 'node:fs';

const R = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
export const ROOT = R;
export const S = await import(`file://${R}/shared/dist/index.js`);

export function loadBake(p) {
  const src = readFileSync(p, 'utf8');
  const a = src.indexOf('"');
  const b = src.lastIndexOf('"');
  if (a < 0 || b <= a) throw new Error(`${p} does not look like a city.data.ts`);
  return S.decodeBakedCity(JSON.parse(JSON.parse(src.slice(a, b + 1))));
}

export const raw = JSON.parse(readFileSync(`${R}/shared/data/city-plan.json`, 'utf8'));
export const plan = S.parseCityPlan(raw);
export const NEW = `${R}/shared/src/world/city.data.ts`;
