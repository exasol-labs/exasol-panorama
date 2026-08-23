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
await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
await page.waitForTimeout(900);

const box = await page.locator('.pn-canvas').boundingBox();

/** Screen position of the halo's close button, from the live world state. */
const target = await page.evaluate(() => {
  const workspace = globalThis.__panorama;
  const id = workspace.core.world.order[0];
  const entity = workspace.core.world.entities.get(id);
  return { x: entity.transform.x + entity.transform.width - 11, y: entity.transform.y - 19 };
});

const before = await page.evaluate(() => globalThis.__panorama.openTableCount);

/**
 * Derives the screen-to-world mapping from live session state rather than
 * assuming a camera position: hovering reports the pointer's world coordinates,
 * so two samples give both the scale and the offset.
 */
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const pointer = globalThis.__panorama.core.session.pointer;
    return pointer === null ? null : { x: pointer.world.x, y: pointer.world.y };
  });
};

const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
const worldA = await probe(centre.x, centre.y);
const worldB = await probe(centre.x + 100, centre.y + 100);
const scale = 100 / (worldB.x - worldA.x);
const screen = {
  x: centre.x + (target.x - worldA.x) * scale,
  y: centre.y + (target.y - worldA.y) * scale,
};

// Back onto the body so the table is activated before reaching for the halo.
await page.mouse.move(centre.x, centre.y);
await page.waitForTimeout(150);
await page.mouse.move(screen.x, screen.y);
await page.waitForTimeout(250);
const hoveredAction = await page.evaluate(
  () => globalThis.__panorama.core.session.hoveredAction?.action ?? null,
);
await page.screenshot({ path: 'scripts/shots/halo-hover.png' });

await page.mouse.down();
await page.waitForTimeout(120);
const pressedAction = await page.evaluate(
  () => globalThis.__panorama.core.session.pressedAction?.action ?? null,
);
await page.screenshot({ path: 'scripts/shots/halo-pressed.png' });
await page.mouse.up();
await page.waitForTimeout(600);

const after = await page.evaluate(() => globalThis.__panorama.openTableCount);
const entities = await page.evaluate(() => globalThis.__panorama.core.world.entities.size);
await page.screenshot({ path: 'scripts/shots/halo-closed.png' });

console.log(JSON.stringify({ before, hoveredAction, pressedAction, after, entities }, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
