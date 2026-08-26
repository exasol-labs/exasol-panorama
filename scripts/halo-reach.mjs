/**
 * The reported bug: with one table selected, hovering another shows its halo
 * but the buttons cannot be reached — the halo reverts to the selected table
 * as soon as the pointer leaves the hovered one.
 *
 * Opens two tables, selects the first, then walks the pointer from the second
 * table's body out through its top edge to the close button and clicks it.
 */
import { chromium } from 'playwright';

/** The same variable every other probe reads; see docs/TESTING.md §8.2. */
const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text()}`);
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const open = async (name) => {
  await page.locator(`[aria-label="Sample tables"] button:has-text("${name}")`).first().click();
  await page.waitForTimeout(700);
};
await open('SAMPLE_100');
await open('COUNTRIES');

const box = await page.locator('.pn-canvas').boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(110);
  return page.evaluate(() => {
    const p = globalThis.__panorama.core.session.pointer;
    return p === null ? null : { x: p.world.x, y: p.world.y };
  });
};
const a = await probe(centre.x, centre.y);
const b = await probe(centre.x + 100, centre.y);
const scale = 100 / (b.x - a.x);
const toScreen = (world) => ({
  x: centre.x + (world.x - a.x) * scale,
  y: centre.y + (world.y - a.y) * scale,
});

// Place both tables inside the visible world rectangle, so the halo of the
// second is actually reachable by the pointer, then select the first.
const view = {
  left: a.x - (centre.x - box.x) / scale,
  top: a.y - (centre.y - box.y) / scale,
  right: a.x + (box.x + box.width - centre.x) / scale,
};
await page.evaluate(({ left, top, right }) => {
  const core = globalThis.__panorama.core;
  const [first, second] = core.world.order;
  const secondEntity = core.world.entities.get(second);
  core.dispatch({
    type: 'MoveEntities',
    ids: [first],
    position: { x: left + 30, y: top + 260, z: 0 },
  });
  core.dispatch({
    type: 'MoveEntities',
    ids: [second],
    position: {
      x: right - secondEntity.transform.width - 40,
      y: top + 120,
      z: 0,
    },
  });
  core.dispatchSession({ type: 'SetSelection', ids: [first] });
}, view);
await page.waitForTimeout(300);

const second = await page.evaluate(() => {
  const core = globalThis.__panorama.core;
  const ids = core.world.order;
  // The second table is whichever is not selected.
  const selected = core.session.selection[0];
  const entity = core.world.entities.get(ids.find((id) => id !== selected));
  return {
    id: entity.id,
    x: entity.transform.x,
    y: entity.transform.y,
    width: entity.transform.width,
    height: entity.transform.height,
  };
});

const state = async () =>
  page.evaluate(() => {
    const core = globalThis.__panorama.core;
    const session = core.session;
    const ids = [...core.world.order];
    const activated = session.hovered ?? session.focusedTable;
    const selected = session.selection[0] ?? null;
    return {
      activatedIsSelected: activated !== null && activated === selected,
      activatedIndex: activated === null ? -1 : ids.indexOf(activated),
      hoveredAction: session.hoveredAction?.action ?? null,
      tables: ids.length,
    };
  });

const report = {};
// 1. Hover the body of the *unselected* table.
await page.mouse.move(
  ...Object.values(toScreen({ x: second.x + second.width / 2, y: second.y + 120 })),
);
await page.waitForTimeout(200);
report.hoveringSecond = await state();

// 2. Leave through the top edge on the LEFT — nowhere near the button.
await page.mouse.move(...Object.values(toScreen({ x: second.x + 30, y: second.y - 6 })));
await page.waitForTimeout(200);
report.inBandFarFromButton = await state();

// 3. Travel along the band to the button. Halo buttons are sized in screen
// pixels, so their world size depends on the camera scale.
const BUTTON = 22 / scale;
const OFFSET = 8 / scale;
// The close button, on the corner: out past the right edge and up past the top.
const button = {
  x: second.x + second.width + OFFSET + BUTTON / 2,
  y: second.y - OFFSET - BUTTON / 2,
};
report.derived = { scale, button, second };
// Scan the band to find where the button actually responds.
const scan = [];
for (let dx = -60; dx <= 45; dx += 5) {
  for (let dy = -34; dy <= 30; dy += 4) {
    const world = { x: second.x + second.width + dx, y: second.y + dy };
    const point = toScreen(world);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(30);
    const found = await page.evaluate(
      () => globalThis.__panorama.core.session.hoveredAction?.action ?? null,
    );
    if (found !== null) scan.push({ dx, dy });
  }
}
report.buttonScan = scan.slice(0, 12);
report.buttonScanCount = scan.length;
await page.mouse.move(...Object.values(toScreen(button)));
await page.waitForTimeout(250);
report.onButton = await state();
await page.screenshot({ path: 'scripts/shots/halo-reach.png' });

// 4. Click it.
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
report.afterClick = await state();

console.log(JSON.stringify(report, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
