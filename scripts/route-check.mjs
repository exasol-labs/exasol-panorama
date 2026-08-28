/**
 * Checks that a connector goes round a table rather than through it.
 *
 * The line is drawn behind tables, so a line crossing one is not visible as a
 * crossing — it is visible as a line that stops and starts again somewhere else,
 * which is exactly why it is worth avoiding and exactly why pixels cannot judge
 * it. What can be judged is where the line's marker ended up: the marker sits at
 * the middle of the path that was drawn, and hit testing finds it by hovering. So
 * the pointer sweeps the gap until the marker reveals, and that tells us where the
 * line actually went — and proves that drawing and picking agree about it, which
 * is the thing most likely to drift.
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
for (const name of ['SAMPLE_100', 'LARGE_STRINGS', 'COUNTRIES']) {
  await openTable(page, name);
  await page.waitForTimeout(800);
}

const canvas = await page.locator('.pn-canvas-host').boundingBox();
const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
const probe = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(110);
  return page.evaluate(() => globalThis.__panorama.core.session.pointer?.world ?? null);
};
const worldA = await probe(centre.x, centre.y);
const worldB = await probe(centre.x + 100, centre.y + 100);
const scale = 100 / (worldB.x - worldA.x);
const toScreen = (world) => ({
  x: centre.x + (world.x - worldA.x) * scale,
  y: centre.y + (world.y - worldA.y) * scale,
});

/** Two tables well apart, a third squarely between them, and a line across. */
const layout = await page.evaluate((view) => {
  const workspace = globalThis.__panorama;
  const [left, middle, right] = workspace.core.world.order;
  const apply = (command) => {
    const result = workspace.core.dispatch(command);
    if (!result.ok) throw new Error(result.error.message);
  };
  apply({ type: 'ResizeEntity', id: left, width: 220, height: 200 });
  apply({ type: 'ResizeEntity', id: middle, width: 150, height: 190 });
  apply({ type: 'ResizeEntity', id: right, width: 200, height: 170 });
  const x0 = view.x - 320;
  const y0 = view.y - 100;
  apply({ type: 'MoveEntities', ids: [left], position: { x: x0, y: y0, z: 0 } });
  apply({ type: 'MoveEntities', ids: [right], position: { x: x0 + 620, y: y0 + 15, z: 0 } });
  apply({ type: 'MoveEntities', ids: [middle], position: { x: x0 + 290, y: y0 + 5, z: 0 } });
  apply({
    type: 'CreateBinding',
    binding: {
      id: workspace.core.ids.binding(),
      kind: 'connector',
      fromId: left,
      toId: right,
      from: { mode: 'auto' },
      to: { mode: 'auto' },
      directed: true,
      label: 'COUNTRY → COUNTRIES.CODE',
      meta: { kind: 'foreign-key' },
    },
  });
  const rect = (id) => workspace.core.world.entities.get(id).transform;
  return { left: rect(left), middle: rect(middle), right: rect(right), ids: { middle } };
}, worldA);
await page.waitForTimeout(500);

/** The straight line between the two ends, in world coordinates. */
const chord = {
  from: { x: layout.left.x + layout.left.width, y: layout.left.y + layout.left.height / 2 },
  to: { x: layout.right.x, y: layout.right.y + layout.right.height / 2 },
};
const chordY = (chord.from.y + chord.to.y) / 2;

/**
 * Finds the marker by hovering, and reports where it was in world units.
 *
 * A grid rather than a line, because the whole point is that the marker may not
 * be on the straight line any more.
 */
const findMarker = async () => {
  for (let dy = 0; dy <= 300; dy += 8) {
    for (const sign of dy === 0 ? [1] : [1, -1]) {
      const y = chordY + sign * dy;
      for (let t = 0.2; t <= 0.8; t += 0.04) {
        const world = { x: chord.from.x + (chord.to.x - chord.from.x) * t, y };
        const screen = toScreen(world);
        if (screen.x < canvas.x || screen.x > canvas.x + canvas.width) continue;
        if (screen.y < canvas.y || screen.y > canvas.y + canvas.height) continue;
        await page.mouse.move(screen.x, screen.y);
        const hit = await page.evaluate(
          () => globalThis.__panorama.core.session.hoveredBinding ?? null,
        );
        if (hit !== null) return { world, offsetFromChord: Math.round(y - chordY) };
      }
    }
  }
  return null;
};

const detoured = await findMarker();
await page.mouse.move(centre.x, centre.y - 380);
await page.waitForTimeout(200);
await page.screenshot({ path: 'scripts/shots/route-around.png' });

// The obstacle out of the way: the line has no reason to bend any more.
await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const transform = workspace.core.world.entities.get(id).transform;
  workspace.core.dispatch({
    type: 'MoveEntities',
    ids: [id],
    position: { x: transform.x, y: transform.y + 900, z: 0 },
  });
}, layout.ids.middle);
await page.waitForTimeout(500);
const direct = await findMarker();
await page.mouse.move(centre.x, centre.y - 380);
await page.waitForTimeout(200);
await page.screenshot({ path: 'scripts/shots/route-direct.png' });

console.log(
  JSON.stringify(
    {
      // The middle table spans this much either side of the straight line.
      obstacleHalfHeight: Math.round(layout.middle.height / 2),
      markerWithObstacle: detoured,
      markerWithoutObstacle: direct,
      wentRoundIt: detoured !== null && Math.abs(detoured.offsetFromChord) > 60,
      cameBackStraight: direct !== null && Math.abs(direct.offsetFromChord) <= 8,
      problems,
    },
    null,
    2,
  ),
);
await browser.close();
