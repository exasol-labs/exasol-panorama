/**
 * Exports a table from the real halo, in a real browser.
 *
 * The unit tests prove the encoders write what they meant to and the sample
 * files prove another library can read them. What neither can prove is that the
 * button works: that the halo reveals the formats where the pointer can reach
 * them, that pressing one opens a save dialog, and that the bytes reach a file.
 * So this drives the actual app with an actual pointer and catches the actual
 * download.
 *
 * `showSaveFilePicker` is removed before the page loads, because a native save
 * dialog is not something a test can drive — which puts the app on its download
 * fallback, the path every browser without the File System Access API takes.
 */
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { chromium } from 'playwright';
import { sweepHalo } from './lib/halo-sweep.mjs';

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';

mkdirSync('scripts/shots', { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text()}`);
});

// A native dialog cannot be driven, so the app takes its download route.
await page.addInitScript(() => {
  delete window.showSaveFilePicker;
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Hide' }).click();
await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
await page.waitForTimeout(900);

const box = await page.locator('.pn-canvas').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/**
 * Derives the screen-to-world mapping from live session state rather than
 * assuming a camera position: hovering reports the pointer's world coordinates,
 * so two samples give both the scale and the offset.
 */
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(80);
  return page.evaluate(() => {
    const pointer = globalThis.__panorama.core.session.pointer;
    return pointer === null ? null : { x: pointer.world.x, y: pointer.world.y };
  });
};

const worldA = await probe(centre.x, centre.y);
const worldB = await probe(centre.x + 100, centre.y + 100);
const scale = 100 / (worldB.x - worldA.x);
const toScreen = (world) => ({
  x: centre.x + (world.x - worldA.x) * scale,
  y: centre.y + (world.y - worldA.y) * scale,
});

const table = await page.evaluate(() => {
  const workspace = globalThis.__panorama;
  const id = workspace.core.world.order[0];
  return workspace.core.world.entities.get(id).transform;
});

/**
 * Finds a halo button by hovering for it, wherever the halo has put it. That
 * proves the button is hit-testable where it is drawn and survives any change to
 * the layout — which it has now had.
 */
const findAction = async (wanted) =>
  (await sweepHalo({ page, rect: table, toScreen })).get(wanted) ?? null;

const press = async (point) => {
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(200);
};

const results = [];

for (const [action, format, expected] of [
  ['export-csv', 'csv', 'ORDER_ID,COUNTRY,ORDER_DATE,REVENUE'],
  ['export-xlsx', 'xlsx', 'PK'],
  ['export-parquet', 'parquet', 'PAR1'],
]) {
  const disclose = await findAction('export');
  if (disclose === null) {
    results.push({ format, error: 'the export button was not reachable' });
    continue;
  }
  // The halo as it is before anything is disclosed: one export button.
  if (format === 'csv') await page.screenshot({ path: 'scripts/shots/export-halo.png' });
  await press(disclose);
  const expanded = await page.evaluate(
    () => globalThis.__panorama.core.session.expandedAction?.action ?? null,
  );
  await page.screenshot({ path: 'scripts/shots/export-formats.png' });

  const target = await findAction(action);
  if (target === null) {
    results.push({ format, expanded, error: `${action} was not reachable` });
    continue;
  }
  const downloading = page.waitForEvent('download', { timeout: 15_000 });
  await press(target);
  const download = await downloading;
  const path = await download.path();
  const bytes = readFileSync(path);
  // The BOM sits in front of a CSV header, so the comparison skips it.
  const head = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? bytes.subarray(3)
    : bytes;
  results.push({
    format,
    expanded,
    suggestedName: download.suggestedFilename(),
    bytes: bytes.length,
    startsCorrectly: head.subarray(0, expected.length).toString('latin1') === expected,
  });
  unlinkSync(path);
}

const panel = await page
  .locator('[aria-label="Exports"] .pn-export__status')
  .allTextContents()
  .catch(() => []);

console.log(JSON.stringify({ results, panel }, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();

const failed = results.filter((result) => result.error !== undefined || !result.startsCorrectly);
if (failed.length > 0) process.exitCode = 1;
