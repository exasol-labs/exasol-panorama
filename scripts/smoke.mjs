/**
 * Browser smoke test.
 *
 * Loads the dev server, exercises the table browser, and writes screenshots to
 * `scripts/shots/`. Not part of `npm test`: it needs a real browser.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';
/** Set to 2 to reproduce a Retina display. */
const scaleFactor = Number(process.env.PANORAMA_SMOKE_DPR ?? '1');
const suffix = scaleFactor === 1 ? '' : `@${scaleFactor}x`;
mkdirSync('scripts/shots', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: scaleFactor,
});

const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`[console] ${message.text()}`);
});
page.on('requestfailed', (request) =>
  problems.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`),
);

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
// The overlay covers the top-right corner; hide it for the screenshots.
await page.getByRole('button', { name: 'Hide' }).click();

const overlay = async () => {
  await page.getByRole('button', { name: /fps/ }).click();
  const rows = await page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll('.pn-overlay dl > div')) {
      out[row.querySelector('dt')?.textContent ?? ''] = row.querySelector('dd')?.textContent ?? '';
    }
    return out;
  });
  await page.getByRole('button', { name: 'Hide' }).click();
  return rows;
};

const openSample = async (name) => {
  await page.locator(`[aria-label="Sample tables"] button:has-text("${name}")`).first().click();
  await page.waitForTimeout(900);
};

const canvasBox = await page.locator('.pn-canvas').boundingBox();
const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };

const report = {};

for (const name of ['SAMPLE_100', 'TYPE_COVERAGE', 'VERY_WIDE', 'LARGE_STRINGS', 'MOSTLY_NULL']) {
  await openSample(name);
  report[name] = await overlay();
  await page.screenshot({ path: `scripts/shots/${name}${suffix}.png` });
  // Close it again so each screenshot shows one table.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    globalThis.__panorama?.closeAll?.();
  });
  await page.waitForTimeout(300);
}

// The action halo: hover the table, then close it from the halo.
await openSample('SAMPLE_100');
const tableBefore = await page.evaluate(() => globalThis.__panorama?.openTableCount ?? -1);
await page.mouse.move(centre.x, centre.y + 120);
await page.waitForTimeout(400);
await page.screenshot({ path: `scripts/shots/halo${suffix}.png` });

// Walk up to the halo, which hangs above the table's top-right corner.
const haloPoint = await page.evaluate(() => {
  const workspace = globalThis.__panorama;
  const id = workspace?.core?.world?.order?.[0];
  const entity = workspace?.core?.world?.entities?.get(id);
  return entity === undefined
    ? null
    : {
        worldX: entity.transform.x + entity.transform.width - 11,
        worldY: entity.transform.y - 19,
      };
});
report.haloProbe = { tableBefore, haloPoint };

// A deep fling through ten billion rows.
await openSample('VERY_TALL');
for (let step = 0; step < 30; step += 1) {
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(16);
}
await page.waitForTimeout(1200);
report.VERY_TALL_flung = await overlay();
await page.screenshot({ path: `scripts/shots/VERY_TALL-flung${suffix}.png` });

// Horizontal scrolling and a column resize on a wide table.
await page.evaluate(() => {
  globalThis.__panorama?.closeAll?.();
});
await page.waitForTimeout(300);
await openSample('VERY_WIDE');
await page.mouse.move(centre.x, centre.y);
await page.mouse.wheel(1200, 0);
await page.waitForTimeout(800);
report.VERY_WIDE_scrolled = await overlay();
await page.screenshot({ path: `scripts/shots/VERY_WIDE-scrolled${suffix}.png` });

report.haloClose = await page.evaluate(() => globalThis.__panorama?.openTableCount ?? -1);
console.log(JSON.stringify(report, null, 2));
console.log('--- problems ---');
console.log(problems.length === 0 ? '(none)' : problems.join('\n'));

await browser.close();
