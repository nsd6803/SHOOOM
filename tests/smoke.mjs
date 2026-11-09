// Smoke test: opens dist/index.html in headless Chromium, applies every effect to the demo image,
// fails if any shader doesn't compile or the page throws. Screenshots go to tests/out/.
// Setup once: npm i && npx playwright install chromium
import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const page_url = pathToFileURL(path.resolve('dist/index.html')).href;
fs.mkdirSync('tests/out', { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(page_url);
await p.click('#demoBtn');
const ids = await p.$$eval('#library button[data-id]', bs => bs.map(x => x.dataset.id));
for (const id of ids) {
  await p.click('#clearBtn');
  await p.click(`#library button[data-id="${id}"]`);
  await p.waitForTimeout(150);
  await p.locator('#cv').screenshot({ path: `tests/out/${id}.png` });
}
const shaderErrs = await p.evaluate(() => [...window.__shooom.R.errors]);
await b.close();
if (errs.length || shaderErrs.length) { console.error('FAIL', { errs, shaderErrs }); process.exit(1); }
console.log(`OK: ${ids.length} эффектов, скриншоты в tests/out/`);
