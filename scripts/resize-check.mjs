/**
 * Resizes the window and checks that the picture does not move.
 *
 * Several separate things go wrong when a window is resized, and they all look
 * identical to the person dragging the corner — the picture "goes weird" — so
 * this measures them apart:
 *
 *  - *Reallocating*: the root cause of the rest. Assigning `canvas.width` throws
 *    the drawing buffer away and takes a new, empty one, which the compositor can
 *    see before anything has drawn into it, and which is slow enough that a live
 *    resize on macOS gives up waiting and shows the last frame scaled. The
 *    application avoids it entirely: the canvas is drawn as large as the display
 *    could ever need and the window clips it, so a resize changes a clip and
 *    nothing else. Checked by a second resize observer, registered after the
 *    application's and therefore called after it in the same broadcast: the
 *    buffer it sees must be the one that was there before the drag started.
 *  - *Uncovering*: the clipped canvas must stay at least as large as the window
 *    and pinned to its top-left corner, or a resize reveals the page behind it.
 *  - *Moving*: the camera is centre-anchored, so a viewport 200px wider puts
 *    everything 100px further right without the camera having moved. Caught by
 *    comparing a fixed region of the canvas, in page coordinates, before and
 *    after: it must come back byte-identical.
 *  - *Stretching*: the drawing buffer's shape disagreeing with the box it is
 *    displayed in, which the browser resolves by scaling the last frame.
 *  - *Resampling*: a buffer that is not exactly the box in device pixels, which
 *    costs the text its crispness even when nothing is stretched.
 *
 * A region with nothing in it would pass the first check by accident, so the
 * region's own size is asserted first: a blank 560×460 PNG is about 700 bytes,
 * and a table's worth of text is a hundred times that.
 */
import { chromium } from 'playwright';

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// At two device pixels per CSS pixel, because that is what the application ships
// on and because half the ways a drawing buffer can be the wrong size — anything
// that measures in CSS pixels and assigns the result — are invisible at one.
//
// The screen is declared larger than any viewport below, as a real one is: the
// canvas is allocated to cover the display, so a window that stays within it
// never needs another allocation. A screen the size of the window would be a
// window that cannot be dragged bigger, which is not the case being tested.
const page = await browser.newPage({
  viewport: { width: 1200, height: 800 },
  screen: { width: 2560, height: 1440 },
  deviceScaleFactor: 2,
});
const problems = [];
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);
// Something on the canvas, so there is something that could move.
await page.locator('[aria-label="Sample tables"] button').first().click();
await page.waitForTimeout(1500);

const box = await page.locator('canvas').boundingBox();
// Page coordinates, which do not move when the window grows: the header's height
// and the sidebar's width are fixed, so this rectangle stays over the same part
// of the canvas no matter what the window does.
const clip = { x: Math.round(box.x), y: Math.round(box.y), width: 560, height: 460 };
const region = () => page.screenshot({ clip });

/** The buffer against the box it is shown in, and that box against the window. */
const geometry = () =>
  page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const canvas = document.querySelector('canvas');
    const host = canvas.parentElement.getBoundingClientRect();
    const shown = canvas.getBoundingClientRect();
    const ratio = Math.min(2, devicePixelRatio || 1);
    return {
      buffer: [canvas.width, canvas.height],
      resample: Number((canvas.width / (shown.width * ratio)).toFixed(4)),
      stretch: Number((canvas.width / canvas.height / (shown.width / shown.height)).toFixed(4)),
      // Covering the window from its top-left corner, with a pixel of slack for
      // the fractional layout a window of an odd size produces.
      covers:
        shown.width >= host.width - 1 &&
        shown.height >= host.height - 1 &&
        Math.abs(shown.x - host.x) < 1 &&
        Math.abs(shown.y - host.y) < 1,
    };
  });

// Registered after the application's observer, so it is called after it within
// the same broadcast — before the frame is painted, and before any animation
// frame the application might have deferred the work to. What it records is the
// size of the drawing buffer the application left behind, once per notification.
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const host = canvas.parentElement;
  window.__buffers = [];
  new ResizeObserver(() => {
    window.__buffers.push(`${canvas.width}x${canvas.height}`);
  }).observe(host);
});

const settled = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return `${canvas.width}x${canvas.height}`;
});
const before = await region();
const steps = [];
for (const [width, height] of [
  [1320, 900],
  [1500, 1000],
  [1240, 840],
  [1100, 760],
]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(500);
  const shape = await geometry();
  steps.push({
    size: [width, height],
    moved: Buffer.compare(before, await region()) !== 0,
    ...shape,
  });
}

// The buffer as it stood after each notification the application handled. Every
// one of them has to be the buffer that was already there before the drag.
const buffers = await page.evaluate(() => window.__buffers);

const report = {
  regionBytes: before.length,
  settled,
  steps,
  reallocated: [...new Set(buffers)].filter((size) => size !== settled),
  everMoved: steps.some((step) => step.moved),
  everStretched: steps.some((step) => Math.abs(step.stretch - 1) > 0.005),
  everResampled: steps.some((step) => Math.abs(step.resample - 1) > 0.005),
  everUncovered: steps.some((step) => !step.covers),
};
console.log(JSON.stringify(report, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();

if (
  report.regionBytes < 5_000 ||
  report.reallocated.length > 0 ||
  report.everMoved ||
  report.everStretched ||
  report.everResampled ||
  report.everUncovered ||
  problems.length > 0
) {
  console.error('the picture did not hold still through a resize');
  process.exitCode = 1;
} else {
  console.log(
    'the picture holds still through a resize: one buffer throughout, covering the window, and not a pixel moved.',
  );
}
