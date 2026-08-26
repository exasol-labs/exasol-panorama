/**
 * Follows a foreign key in the real app.
 *
 * Opens SAMPLE_100, clicks a COUNTRY cell, and checks that a filtered
 * COUNTRIES table opens bound to it — then drags the source table and confirms
 * the connector re-routes without the binding record changing.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { connectorMidpoint } from './lib/connector-midpoint.mjs';

mkdirSync('scripts/shots', { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text()}`);
});

await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Hide' }).click();
await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
await page.waitForTimeout(900);

const box = await page.locator('.pn-canvas').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

/** Maps world coordinates to screen using the live pointer state. */
const mapper = async () => {
  await page.mouse.move(centre.x, centre.y);
  await page.waitForTimeout(120);
  const a = await page.evaluate(() => {
    const p = globalThis.__panorama.core.session.pointer;
    return { x: p.world.x, y: p.world.y };
  });
  await page.mouse.move(centre.x + 100, centre.y);
  await page.waitForTimeout(120);
  const b = await page.evaluate(() => {
    const p = globalThis.__panorama.core.session.pointer;
    return { x: p.world.x, y: p.world.y };
  });
  const scale = 100 / (b.x - a.x);
  return (world) => ({
    x: centre.x + (world.x - a.x) * scale,
    y: centre.y + (world.y - a.y) * scale,
  });
};

const toScreen = await mapper();

/** Centre of the COUNTRY cell on the given row, in world coordinates. */
const cellWorld = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const entity = core.world.entities.get(core.world.order[0]);
  let x = entity.transform.x + 64;
  for (const column of entity.columns) {
    if (column.sourceColumn.name === 'COUNTRY') break;
    x += column.width;
  }
  const country = entity.columns.find((c) => c.sourceColumn.name === 'COUNTRY');
  return {
    x: x + country.width / 2,
    y: entity.transform.y + entity.view.headerHeight + entity.view.rowHeight * 2.5,
    hasForeignKey: country.sourceColumn.foreignKey !== undefined,
  };
});

const report = { hasForeignKey: cellWorld.hasForeignKey };

const cellScreen = toScreen(cellWorld);
await page.mouse.move(cellScreen.x, cellScreen.y);
await page.waitForTimeout(250);
report.cursor = await page.evaluate(() => document.querySelector('.pn-canvas').style.cursor);
await page.screenshot({ path: 'scripts/shots/fk-hover.png' });

await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(1200);

report.after = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const bindings = [...core.world.bindings.values()];
  const entities = [...core.world.entities.values()];
  return {
    tables: entities.length,
    openTables: globalThis.__panorama.openTableCount,
    names: entities.map((entity) => entity.source.table),
    bindings: bindings.map((binding) => ({
      label: binding.label,
      directed: binding.directed,
      meta: binding.meta,
    })),
  };
});
await page.screenshot({ path: 'scripts/shots/fk-followed.png' });

// Following the key revealed the new table, which pans the camera: the screen
// mapping has to be derived again.
const toScreenNow = await mapper();

// The marker: compact by default, expanded on hover. The two ends are read out
// of the page; the curve is worked out here, from the same formula as the
// renderer.
const ends = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const binding = [...core.world.bindings.values()][0];
  return {
    from: core.world.entities.get(binding.fromId).transform,
    to: core.world.entities.get(binding.toId).transform,
  };
});
const markerWorld = connectorMidpoint(ends.from, ends.to);
await page.mouse.move(centre.x - 400, centre.y + 300);
await page.waitForTimeout(200);
await page.screenshot({ path: 'scripts/shots/marker-compact.png' });
report.beforeHover = await page.evaluate(
  () => globalThis.__panorama.core.session.hoveredBinding ?? null,
);

const markerScreen = toScreenNow(markerWorld);
await page.mouse.move(markerScreen.x, markerScreen.y);
await page.waitForTimeout(300);
report.markerCursor = await page.evaluate(() => document.querySelector('.pn-canvas').style.cursor);
report.afterHover = await page.evaluate(
  () => globalThis.__panorama.core.session.hoveredBinding ?? null,
);
await page.screenshot({ path: 'scripts/shots/marker-revealed.png' });

// Drag the source table and confirm the line follows without the record changing.
const beforeDrag = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const binding = [...core.world.bindings.values()][0];
  return { id: binding.id, json: JSON.stringify(binding) };
});
const titleWorld = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const entity = core.world.entities.get(core.world.order[0]);
  return { x: entity.transform.x + 200, y: entity.transform.y + 14 };
});
const from = toScreenNow(titleWorld);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x - 220, from.y + 260, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
await page.screenshot({ path: 'scripts/shots/fk-moved.png' });

report.afterDrag = await page.evaluate((id) => {
  const core = globalThis.__panorama.core;
  const binding = core.world.bindings.get(id);
  return { unchanged: JSON.stringify(binding), stillThere: binding !== undefined };
}, beforeDrag.id);
report.bindingRecordUnchanged = report.afterDrag.unchanged === beforeDrag.json;

console.log(JSON.stringify(report, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
