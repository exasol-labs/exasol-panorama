/**
 * Checks that only one action halo is ever on screen.
 *
 * Opens two tables, selects one, then hovers each in turn and reads which
 * entity the session considers activated.
 */
import { chromium } from 'playwright';

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

const open = async (name) => {
  await page.locator(`[aria-label="Sample tables"] button:has-text("${name}")`).first().click();
  await page.waitForTimeout(700);
};
await open('SAMPLE_100');
await open('TYPE_COVERAGE');

// New tables are staggered by a few pixels, so they overlap. Separate them,
// otherwise both probes would land on whichever is on top.
await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const second = core.world.order[1];
  const entity = core.world.entities.get(second);
  core.dispatch({
    type: 'MoveEntities',
    ids: [second],
    position: { x: entity.transform.x + 700, y: 0, z: 0 },
  });
  core.dispatchSession({ type: 'SetSelection', ids: [] });
});
const box = await page.locator('.pn-canvas').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await page.mouse.move(centre.x, centre.y);
for (let step = 0; step < 3; step += 1) {
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Control');
  await page.waitForTimeout(40);
}
await page.waitForTimeout(400);

/** Screen position of a table's centre, derived from live session state. */
const screenOf = async (index) => {
  const worldA = await (async () => {
    await page.mouse.move(centre.x, centre.y);
    await page.waitForTimeout(100);
    return page.evaluate(() => {
      const p = globalThis.__panorama.core.session.pointer;
      return p === null ? null : { x: p.world.x, y: p.world.y };
    });
  })();
  await page.mouse.move(centre.x + 100, centre.y);
  await page.waitForTimeout(100);
  const worldB = await page.evaluate(() => {
    const p = globalThis.__panorama.core.session.pointer;
    return { x: p.world.x, y: p.world.y };
  });
  const scale = 100 / (worldB.x - worldA.x);
  const target = await page.evaluate((i) => {
    const w = globalThis.__panorama.core.world;
    const entity = w.entities.get(w.order[i]);
    return {
      x: entity.transform.x + entity.transform.width / 2,
      y: entity.transform.y + entity.transform.height / 2,
    };
  }, index);
  return {
    x: centre.x + (target.x - worldA.x) * scale,
    y: centre.y + (target.y - worldA.y) * scale,
  };
};

const state = async () =>
  page.evaluate(() => {
    const core = globalThis.__panorama.core;
    const ids = [...core.world.order];
    const session = core.session;
    const activated = session.hovered ?? session.focusedTable;
    return {
      tables: ids.length,
      activatedIndex: activated === null ? -1 : ids.indexOf(activated),
      halosOnScreen: ids.filter((id) => id === activated).length,
    };
  });

const first = await screenOf(0);
const second = await screenOf(1);

const report = {};
await page.mouse.move(first.x, first.y);
await page.waitForTimeout(250);
report.hoverFirst = await state();
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
report.selectedFirst = await state();

await page.mouse.move(second.x, second.y);
await page.waitForTimeout(250);
report.hoverSecondWhileFirstSelected = await state();
await page.screenshot({ path: 'scripts/shots/halo-exclusive.png' });

await page.mouse.move(box.x + 20, box.y + 20);
await page.waitForTimeout(250);
report.pointerOnEmptyCanvas = await state();

console.log(JSON.stringify(report, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
