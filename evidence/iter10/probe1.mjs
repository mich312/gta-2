import { S, loadBake, NEW, plan } from './lib.mjs';
const city = loadBake(NEW);
console.log('keys', Object.keys(city));
console.log('courses', city.courses.length);
console.log('course0', JSON.stringify(city.courses[0]).slice(0, 400));
const kinds = {};
for (const c of city.courses) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
console.log('kinds', kinds);
console.log('S tile-ish keys:', Object.keys(S).filter((k) => /^T_|tile/i.test(k)).slice(0, 80).join(' '));
