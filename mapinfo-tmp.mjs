import { generateCity, parseWorldgenParams, initTuning } from './shared/dist/index.js';
import fs from 'node:fs';
const j = (n)=>JSON.parse(fs.readFileSync(`./shared/data/${n}.json`,'utf8'));
const police = j('police'); const {presets, ...rest} = police; const pol = presets? {...rest, ...presets['normal']} : police;
initTuning({player:j('player'),vehicles:j('vehicles'),weapons:j('weapons'),police:pol,peds:j('peds'),ambulance:j('ambulance'),props:j('props'),pickups:j('pickups'),traffic:j('traffic'),fittings:j('fittings'),gangs:j('gangs'),respect:j('respect')});
const map = generateCity(7, parseWorldgenParams(j('worldgen')));
console.log('size', map.widthTiles, map.heightTiles, 'shops', map.shops.length, 'landmarks', map.landmarks.length, 'buildings', map.buildings.length);
for (const s of map.shops.slice(0,8)) console.log('shop', s.kind, s.doorX, s.doorY, JSON.stringify(s.interior));
console.log(map.landmarks.slice(0,20).map(l=>`${l.name} @${l.x},${l.y} ${l.w}x${l.h}`).join('\n'));
