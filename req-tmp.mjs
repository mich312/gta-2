import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 2200, height: 1000 } });
p.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText));
p.on('response', r => { if (r.status() >= 400) console.log(r.status(), r.url()); });
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text(), JSON.stringify(m.location())); });
await p.goto(process.argv[2], { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
await b.close();
