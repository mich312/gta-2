import { S, loadBake, NEW, plan } from './lib.mjs';
const { buildLayout } = S;
const city = loadBake(NEW);
const ranges = [];
globalThis.__PASS_PROBE__ = (name, a, b) => ranges.push([name, a, b]);
const L = buildLayout(plan);
delete globalThis.__PASS_PROBE__;
console.log('buildLayout courses:', L.courses.length, ' bake courses:', city.courses.length);
for (const [n, a, b] of ranges) console.log(`  ${n.padEnd(20)} [${a},${b}) n=${b - a}`);
const k = (cs) => { const m = {}; for (const c of cs) m[c.kind] = (m[c.kind] ?? 0) + 1; return m; };
console.log('layout kinds', k(L.courses), 'bake kinds', k(city.courses));
// identity check: are the first N courses the same object-for-object?
let same = 0;
for (let i = 0; i < Math.min(L.courses.length, city.courses.length); i++) {
  if (JSON.stringify(L.courses[i]) === JSON.stringify(city.courses[i])) same++;
}
console.log('index-identical courses:', same);
