/**
 * Clicks a column header in the running app and checks that a statistics panel
 * appears under it, with real numbers in it.
 *
 * Everything here is drawn by the GPU, so the only way to know a panel exists is
 * to look: the glyph and quad counts are read from the frame the renderer
 * actually produced, and the pixels below the table are sampled to be sure the
 * panel is on the canvas rather than merely in a draw list.
 */
import { chromium } from 'playwright';
import { openSample as openTable } from './lib/open-sample.mjs';

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`[console] ${message.text()}`);
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await openTable(page, 'SAMPLE_100');
await page.waitForTimeout(900);

const box = await page.locator('.pn-canvas-host').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/** Screen-to-world mapping, read from the live pointer rather than assumed. */
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const pointer = globalThis.__panorama.core.session.pointer;
    return pointer === null ? null : { x: pointer.world.x, y: pointer.world.y };
  });
};
const worldA = await probe(centre.x, centre.y);
const worldB = await probe(centre.x + 100, centre.y + 100);
const scale = 100 / (worldB.x - worldA.x);
const toScreen = (point) => ({
  x: centre.x + (point.x - worldA.x) * scale,
  y: centre.y + (point.y - worldA.y) * scale,
});

const table = await page.evaluate(() => {
  const workspace = globalThis.__panorama;
  const id = workspace.core.world.order[0];
  const entity = workspace.core.world.entities.get(id);
  const view = entity.view;
  return {
    id,
    x: entity.transform.x,
    y: entity.transform.y,
    width: entity.transform.width,
    height: entity.transform.height,
    headerHeight: view.headerHeight,
    titleHeight: view.titleHeight ?? 26,
    columns: entity.columns.map((column) => ({
      id: column.id,
      name: column.sourceColumn.name,
      width: column.width,
    })),
  };
});

/** The middle of the second column's header, in world units. */
const first = table.columns[0];
const second = table.columns[1];
const headerY = table.y + (table.titleHeight + table.headerHeight) / 2;
const gutter = 44;
const header = toScreen({
  x: table.x + gutter + first.width + second.width / 2,
  y: headerY,
});

/**
 * The strip of canvas the panel will hang in.
 *
 * Compared before and after the click rather than read back from WebGL: the
 * drawing buffer is cleared once the frame has been composited, so `readPixels`
 * says black about a canvas that plainly is not. Two screenshots of the same
 * strip do not have that problem.
 */
const panelStrip = (() => {
  const topLeft = toScreen({ x: table.x, y: table.y + table.height + 8 });
  return {
    x: Math.round(topLeft.x),
    y: Math.round(topLeft.y),
    width: Math.round(table.width * scale),
    height: Math.round(120 * scale),
  };
})();

await page.mouse.move(centre.x, centre.y);
await page.waitForTimeout(150);
const emptyStrip = await page.screenshot({ clip: panelStrip });
await page.mouse.click(header.x, header.y);
await page.waitForTimeout(1200);
const filledStrip = await page.screenshot({ clip: panelStrip });

const selected = await page.evaluate(() => [...globalThis.__panorama.core.session.selectedColumns]);
// Whatever the click actually landed on, rather than what it aimed at: the
// gutter width is derived from the row count and this script does not compute it.
const picked = selected[0] ?? null;
const summary =
  picked === null
    ? null
    : await page.evaluate((id) => globalThis.__panorama.columnSummary(id) ?? null, picked);
const pickedName = table.columns.find((column) => column.id === picked)?.name ?? null;

await page.screenshot({ path: 'scripts/shots/summary-panel.png' });

/**
 * A second column, numeric and varied enough to be binned rather than named —
 * two panels side by side, which is the case where one has to be pushed along.
 */
const revenue = table.columns[3];
const revenueHeader = toScreen({
  x: table.x + gutter + first.width + second.width + table.columns[2].width + revenue.width / 2,
  y: headerY,
});
await page.mouse.click(revenueHeader.x, revenueHeader.y);
await page.waitForTimeout(1200);
const both = await page.evaluate(() => [...globalThis.__panorama.core.session.selectedColumns]);
const secondSummary = await page.evaluate(
  (id) => globalThis.__panorama.columnSummary(id) ?? null,
  revenue.id,
);
await page.screenshot({ path: 'scripts/shots/summary-panels.png' });

/**
 * The frame's own numbers, read where they are actually published.
 *
 * This asked `__panorama.frameStats()`, which does not exist and never has, so it
 * reported `null` every run — a probe field that looks like a measurement and is
 * a spelling mistake. The counts live in the instrumentation overlay, which is
 * where `smoke` reads them: opened for the reading and closed again, since it
 * starts collapsed and covers the corner of the canvas when it is not.
 */
const stats = await (async () => {
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
})();

console.log(
  JSON.stringify(
    {
      aimedAt: second.name,
      picked: pickedName,
      selected,
      summary,
      // Bare canvas before, a panel after: the strip has to have changed, and a
      // panel that drew nothing would leave it identical.
      panelDrawn: !emptyStrip.equals(filledStrip),
      secondColumn: {
        name: revenue.name,
        selected: both.length,
        shape:
          secondSummary?.summary?.bins !== undefined
            ? 'histogram'
            : secondSummary?.summary?.frequencies !== undefined
              ? 'frequency'
              : 'none',
        bins: secondSummary?.summary?.bins?.length ?? 0,
        mean: secondSummary?.summary?.mean ?? null,
      },
      stripBytes: { before: emptyStrip.length, after: filledStrip.length },
      stats,
    },
    null,
    2,
  ),
);
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
