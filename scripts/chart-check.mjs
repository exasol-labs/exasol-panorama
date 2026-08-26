/**
 * Drives a chart through the real path in a real browser.
 *
 * Everything about a chart here is drawn by the GPU, so the only way to know it
 * worked is to press the button, fill the form in, and look. What the form does is
 * read back from the DOM; what the canvas did is read back from the geometry the
 * chart actually produced, and then photographed.
 */
import { chromium } from 'playwright';
import { haloCorner, sweepHalo } from './lib/halo-sweep.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';
const EXPORT_DIR = await mkdtemp(join(tmpdir(), 'panorama-chart-'));

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
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Hide' }).click();
await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
await page.waitForTimeout(1000);

const canvas = await page.locator('.pn-canvas').boundingBox();
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

const tableId = await page.evaluate(() => globalThis.__panorama.core.world.order[0]);
const tableRect = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform,
  tableId,
);

const haloButtons = await sweepHalo({ page, rect: tableRect, toScreen });

const chartButton = haloButtons.get('chart') ?? null;
if (chartButton === null) throw new Error('the halo had no charting button to press');
await page.mouse.click(chartButton.x, chartButton.y);
await page.waitForTimeout(1500);

const chartId = await page.evaluate(() => globalThis.__panorama.editingCharts()[0] ?? null);
const setup = await page.evaluate(() => ({
  boxes: document.querySelectorAll('.pn-chart-editor').length,
  groups: [...document.querySelectorAll('.pn-chart-group > summary')].map(
    (node) => node.textContent,
  ),
  // Folded away until wanted: a flat list of every setting is not a form.
  openGroups: [...document.querySelectorAll('.pn-chart-group')].filter((node) => node.open).length,
  controls: [...document.querySelectorAll('.pn-chart-editor select')].map((node) => node.value),
  measures: [...document.querySelectorAll('.pn-chart-value span')].map((node) => node.textContent),
}));

/** Moved somewhere it can be seen, and made big enough to read. */
const CLIP = { x: 900, y: 60, width: 470, height: 340 };
await page.evaluate(
  ({ id, world, size }) => {
    const workspace = globalThis.__panorama;
    workspace.core.dispatch({ type: 'ResizeEntity', id, width: size.width, height: size.height });
    workspace.core.dispatch({
      type: 'MoveEntities',
      ids: [id],
      position: { x: world.x, y: world.y, z: 0 },
    });
  },
  {
    id: chartId,
    world: {
      x: worldA.x + (CLIP.x - centre.x) / scale,
      y: worldA.y + (CLIP.y - centre.y) / scale,
    },
    size: { width: 440, height: 300 },
  },
);
await page.waitForTimeout(600);
await page.screenshot({ path: 'scripts/shots/chart-setup.png', clip: CLIP });

/**
 * The controls take a column and the picture keeps the rest, so the form must be
 * narrower than the box it belongs to. A form covering the whole box would make
 * every setting a guess followed by a reveal.
 */
const split = await page.evaluate((id) => {
  const entity = globalThis.__panorama.core.world.entities.get(id);
  const form = document.querySelector('.pn-chart-editor');
  return {
    boxWidth: entity.transform.width,
    formWidth: Number.parseFloat(form.style.width),
  };
}, chartId);

// Change a control: the picture is expected to follow, without a commit.
const commitsBefore = await page.evaluate(() => globalThis.__panorama.core.history.commits.size);
await page.selectOption('.pn-chart-editor select', { index: 4 });
await page.waitForTimeout(1200);
const afterChoosing = await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const state = workspace.chartState(id);
  return {
    type: workspace.chartDraft(id)?.type ?? null,
    status: state?.status ?? null,
    commits: workspace.core.history.commits.size,
  };
}, chartId);

/**
 * Every setting, one after another, with the picture read back each time.
 *
 * Not for the values it produces — the test suite has those — but because these
 * are the ones that reach a real ECharts through the real adapter, and a setting
 * that quietly produces nothing at all is exactly what a unit test on the option
 * object cannot see.
 */
const settings = [
  ['orientation', { orientation: 'horizontal' }],
  ['stacked', { stacked: true }],
  ['log scale', { scale: 'log' }],
  ['values on', { showValues: true }],
  ['no grid', { showGrid: false }],
  ['legend never', { legend: 'never' }],
  ['by name', { sort: 'name' }],
  ['smooth', { type: 'line', curve: 'smooth' }],
  ['stepped', { type: 'line', curve: 'stepped' }],
  ['no points', { type: 'line', showPoints: false }],
  ['solid pie', { type: 'pie', values: ['REVENUE'], hole: false }],
  ['raw option', { extra: '{"series":[{"itemStyle":{"color":"#e04b3a"}}]}' }],
];
const drawn = [];
for (const [name, patch] of settings) {
  const marks = await page.evaluate(
    ({ id, patch }) => {
      const workspace = globalThis.__panorama;
      const base = {
        type: 'bar',
        category: 'COUNTRY',
        values: ['REVENUE', 'ORDER_ID'],
        aggregate: 'sum',
      };
      workspace.setChartDraft(id, { ...base, ...patch });
      return null;
    },
    { id: chartId, patch },
  );
  void marks;
  await page.waitForTimeout(700);
  const count = await page.evaluate((id) => {
    const workspace = globalThis.__panorama;
    const entity = workspace.core.world.entities.get(id);
    const view = workspace.chartFor(entity, 300, 220, {
      measureText: (text, size) => text.length * size * 0.55,
      fontFamily: 'sans-serif',
    });
    return view?.chart.polygons.length ?? 0;
  }, chartId);
  drawn.push({ setting: name, marks: count });
}

// Back to something plain, then commit it and look at what the canvas drew.
await page.evaluate(
  (id) =>
    globalThis.__panorama.setChartDraft(id, {
      type: 'pie',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    }),
  chartId,
);
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Show chart' }).click();
await page.waitForTimeout(1200);
const shown = await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const entity = workspace.core.world.entities.get(id);
  const view = workspace.chartFor(
    entity,
    entity.transform.width - 20,
    entity.transform.height - 26 - 20 - 16,
    { measureText: (text, size) => text.length * size * 0.55, fontFamily: 'sans-serif' },
  );
  return {
    mode: entity.mode,
    boxes: document.querySelectorAll('.pn-chart-editor').length,
    polygons: view?.chart.polygons.length ?? 0,
    labels: view?.chart.texts.map((run) => run.text) ?? [],
    note: view?.note ?? null,
  };
}, chartId);
await page.mouse.move(centre.x, centre.y + 380);
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/shots/chart-shown.png', clip: CLIP });

/**
 * Pointing at the picture, and picking parts of it out.
 *
 * Swept with a real pointer, because that is the only way to know that the
 * geometry the canvas drew and the geometry the hit test reads are the same
 * geometry — a mismatch there is a chart that looks right and cannot be touched.
 */
const chartRect = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform,
  chartId,
);
const marksFound = [];
for (let dx = 30; dx < chartRect.width - 20; dx += 6) {
  const point = toScreen({ x: chartRect.x + dx, y: chartRect.y + chartRect.height * 0.55 });
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(40);
  const state = await page.evaluate(() => ({
    mark: globalThis.__panorama.core.session.hoveredMark,
    cursor: document.querySelector('.pn-canvas').style.cursor,
  }));
  if (state.mark !== null) marksFound.push({ dx, data: state.mark.data, cursor: state.cursor });
}
const firstOfEach = [];
for (const entry of marksFound) {
  if (!firstOfEach.some((seen) => seen.data === entry.data)) firstOfEach.push(entry);
}

// Pick two out, then look at what the canvas drew.
for (const entry of firstOfEach.slice(0, 2)) {
  const point = toScreen({
    x: chartRect.x + entry.dx + 2,
    y: chartRect.y + chartRect.height * 0.55,
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
}
const picked = await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const entity = workspace.core.world.entities.get(id);
  const view = workspace.chartFor(entity, 300, 200, {
    measureText: (text, size) => text.length * size * 0.55,
    fontFamily: 'sans-serif',
  });
  const marks = view.chart.polygons.filter((polygon) => polygon.mark !== undefined);
  return {
    selected: workspace.core.session.selectedMarks.length,
    // Fading the rest is what says "these ones, not those".
    faded: marks.filter((polygon) => polygon.color[3] < 1).length,
    full: marks.filter((polygon) => polygon.color[3] === 1).length,
  };
}, chartId);
await page.mouse.move(centre.x, centre.y + 380);
await page.waitForTimeout(300);

/**
 * The chart's own halo, swept: the rule is that a button which makes a new box
 * sits on the right edge, so `rows` — which opens a table beside the chart — has
 * to be found down there and nowhere else.
 */
const chartHalo = await sweepHalo({ page, rect: chartRect, toScreen });
const chartCorner = haloCorner(chartRect, toScreen);
const haloLines = {
  onTop: [...chartHalo].filter(([, at]) => at.y < chartCorner.y - 4 || at.x < chartCorner.x - 4),
  onSide: [...chartHalo].filter(([, at]) => at.y > chartCorner.y + 4),
  onCorner: [...chartHalo].filter(
    ([, at]) => Math.abs(at.x - chartCorner.x) < 4 && Math.abs(at.y - chartCorner.y) < 4,
  ),
};
await page.screenshot({
  path: 'scripts/shots/chart-halo.png',
  clip: {
    x: Math.max(0, Math.min(1180, chartCorner.x - 180)),
    y: Math.max(0, Math.min(730, chartCorner.y - 24)),
    width: 220,
    height: 120,
  },
});

/**
 * The rows behind the selection.
 *
 * Opened empty and watched filling: the count is read back after each mark is
 * picked, because "empty by default, filling up as you select" is a claim about a
 * sequence and only a sequence can check it.
 */
await page.evaluate(() =>
  globalThis.__panorama.core.dispatchSession({ type: 'SetSelectedMarks', targets: [] }),
);
const rowsId = await page.evaluate((id) => globalThis.__panorama.openChartRows(id), chartId);
await page.waitForTimeout(900);
const drilled = [
  await page.evaluate((id) => globalThis.__panorama.viewOfTable(id)?.rowCount ?? null, rowsId),
];
for (const entry of firstOfEach.slice(0, 2)) {
  const point = toScreen({
    x: chartRect.x + entry.dx + 2,
    y: chartRect.y + chartRect.height * 0.55,
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(700);
  drilled.push(
    await page.evaluate((id) => globalThis.__panorama.viewOfTable(id)?.rowCount ?? null, rowsId),
  );
}
// And let them all go again: the table empties as readily as it filled.
await page.evaluate(() =>
  globalThis.__panorama.core.dispatchSession({ type: 'SetSelectedMarks', targets: [] }),
);
await page.waitForTimeout(700);
drilled.push(
  await page.evaluate((id) => globalThis.__panorama.viewOfTable(id)?.rowCount ?? null, rowsId),
);
// Back to two picked out, for the export below to be of something.
for (const entry of firstOfEach.slice(0, 2)) {
  const point = toScreen({
    x: chartRect.x + entry.dx + 2,
    y: chartRect.y + chartRect.height * 0.55,
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(250);
}

/**
 * The three picture formats, written for real and caught as real downloads.
 *
 * The file picker is removed first so the download path is taken, which is the
 * one this cannot otherwise reach: `showSaveFilePicker` opens a dialog no script
 * can answer.
 */
await page.evaluate(() => {
  delete window.showSaveFilePicker;
});
const files = [];
for (const format of ['svg', 'png', 'pdf']) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.evaluate(({ id, format }) => globalThis.__panorama.exportChart(id, format), {
      id: chartId,
      format,
    }),
  ]);
  const path = `${EXPORT_DIR}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  const bytes = await readFile(path);
  files.push({
    format,
    name: download.suggestedFilename(),
    bytes: bytes.length,
    // Enough of each to know it is the format it claims to be.
    signature:
      format === 'png'
        ? [...bytes.subarray(0, 4)].map((byte) => byte.toString(16)).join('')
        : bytes.subarray(0, 8).toString('latin1'),
  });
}

console.log(
  JSON.stringify(
    {
      haloOffersCharting: haloButtons.has('chart'),
      // Where each of the chart's buttons turned out to be, by the rule: the
      // ones that make a new box on the right, the ones that act on this one
      // along the top, close on the corner between them.
      chartHaloAlongTheTop: haloLines.onTop.map(([action]) => action),
      chartHaloDownTheSide: haloLines.onSide.map(([action]) => action),
      chartHaloOnTheCorner: haloLines.onCorner.map(([action]) => action),
      marksUnderThePointer: firstOfEach.map((entry) => entry.data),
      cursorSaidPickable: firstOfEach.every((entry) => entry.cursor === 'pointer'),
      picking: picked,
      rowsBehindTheSelection: drilled,
      emptyUntilSomethingIsPicked: drilled[0] === 0,
      filledAsMarksWerePicked: drilled[1] > 0 && drilled[2] > drilled[1] && drilled.at(-1) === 0,
      exported: files,
      setup,
      formIsNarrowerThanTheBox: split.formWidth > 0 && split.formWidth < split.boxWidth,
      choosingRedrewWithoutACommit:
        afterChoosing.status === 'ready' && afterChoosing.commits === commitsBefore,
      chosenType: afterChoosing.type,
      everySettingDrewSomething: drawn.every((entry) => entry.marks > 0),
      drawn,
      shown,
      problems,
    },
    null,
    2,
  ),
);
await browser.close();
