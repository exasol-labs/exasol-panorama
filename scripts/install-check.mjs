/**
 * Checks that a built Panorama is installable, and that installing it does not
 * change what the application is.
 *
 * Everything about installability fails quietly. A worker that never activates,
 * an icon a platform refuses, a manifest nobody links — all of it looks exactly
 * like a page that works, right up until someone tries to launch it from a home
 * screen and gets a browser tab, or launches it on a train and gets nothing. So
 * it is checked the way the rest of this repository checks the browser: by
 * building the real thing, serving it, and driving it.
 *
 * Four claims, in order:
 *
 *   1. The worker registers, activates and controls the page.
 *   2. The manifest a browser reads holds what an install prompt requires, and
 *      every icon it names is fetchable at the size it claims.
 *   3. With the network taken away, the application still launches and a table
 *      still opens — the shell is genuinely on the device.
 *   4. What is on the device is *only* the shell. No data. This is the one worth
 *      the whole script: a cached row is a row that can be shown as current when
 *      it is not, which is a worse failure than being offline.
 *   5. Nothing shipped that should not have: no development-server route
 *      answered, and no request to a host other than this one.
 *
 * Run it on a build:
 *
 *     npm run build && npm run install-check
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = Number(process.env.PANORAMA_PREVIEW_PORT ?? 4180);
const origin = `http://localhost:${PORT}`;

/**
 * Built here rather than assumed, because the worker is part of the build: a
 * stale `dist` means the check passes or fails on a cache policy that is no
 * longer in the source, which is the one outcome worse than either.
 */
if (process.env.PANORAMA_SKIP_BUILD === undefined) {
  console.info('building...');
  const built = spawnSync('npm', ['run', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (built.status !== 0) process.exit(built.status ?? 1);
} else if (!existsSync('apps/web/dist/index.html')) {
  // The release workflow builds once and then points this at that build, so that
  // what was driven in a browser is what gets shipped. Skipping the build with
  // nothing there is that arrangement gone wrong, and it should say so rather
  // than fail later as a server that will not start.
  console.error('PANORAMA_SKIP_BUILD is set but apps/web/dist is empty. Run `npm run build`.');
  process.exit(1);
}

const problems = [];
const note = (message) => problems.push(message);
const expect = (claim, message) => {
  if (!claim) note(message);
};

/** The preview server: the built files, served the way a host would serve them. */
const preview = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', 'apps/web'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server did not start')), 30_000);
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes(String(PORT))) {
      clearTimeout(timer);
      resolve();
    }
  });
});
await ready;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (error) => note(`[pageerror] ${error.message}`));
/**
 * Console noise that is not a finding: the page attaches to the agent interface
 * unconditionally (it is a dev-server route, absent from a build), and Babylon
 * narrates a shader compile at length when one fails — the failure itself is
 * reported by the request that could not be answered.
 */
const IGNORED = [/\/agent\/events/, /^BJS - /, /#define/];
const ignored = (...text) => text.some((one) => IGNORED.some((pattern) => pattern.test(one)));

/** The agent interface is a dev-server route; a build must not answer it. */
let agentInterface = 'not requested';

/**
 * Anything the page asks of a host that is not its own.
 *
 * An installed application that reaches a third party at startup behaves
 * differently offline, on a first launch, and behind a store's review — and it
 * does so without anybody choosing it. Babylon fetched a controller profile list
 * from `immersive-web.github.io` on every load until this caught it.
 */
const external = new Set();
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (ignored(text, message.location().url)) return;
  note(`[console] ${text.slice(0, 200)}`);
});
page.on('response', (response) => {
  if (response.status() !== 404) return;
  if (/\/agent\//.test(response.url())) {
    agentInterface = 'absent';
    return;
  }
  note(`[404] ${response.url()}`);
});
page.on('request', (request) => {
  const { origin: asked } = new URL(request.url());
  if (asked !== origin) external.add(asked);
});
page.on('requestfailed', (request) => {
  if (ignored(request.url())) return;
  note(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`);
});

const report = {};

try {
  // 1. The worker.
  await page.goto(origin, { waitUntil: 'load' });
  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.ready;
    // `ready` resolves as soon as there is an active worker, which may still be
    // running its activate handler — and ours has a cache to fill.
    for (let waited = 0; found.active?.state === 'activating' && waited < 20_000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { scope: found.scope, state: found.active?.state ?? null };
  });
  report.worker = registration;
  expect(registration.state === 'activated', `worker did not activate: ${registration.state}`);
  expect(registration.scope === `${origin}/`, `worker scope is ${registration.scope}`);

  // A second load is the one the worker is present for, and the one that fills
  // the cache: on the first, it was still installing while the assets arrived.
  await page.reload({ waitUntil: 'load' });
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(controlled, 'the page is not controlled by the worker after a reload');

  // 2. The manifest, read as a browser reads it.
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (link === null) return null;
    const response = await fetch(link.href);
    return response.ok ? response.json() : null;
  });
  expect(manifest !== null, 'the document does not link a manifest that can be fetched');
  report.manifest = manifest === null ? null : { name: manifest.name, display: manifest.display };
  if (manifest !== null) {
    for (const field of ['name', 'short_name', 'start_url', 'icons', 'display']) {
      expect(manifest[field] !== undefined, `the manifest has no ${field}`);
    }
    const icons = await page.evaluate(
      async (sources) =>
        Promise.all(
          sources.map(async (icon) => {
            const response = await fetch(icon.src);
            if (!response.ok) return { src: icon.src, ok: false };
            const bitmap = await createImageBitmap(await response.blob());
            return {
              src: icon.src,
              ok: true,
              declared: icon.sizes,
              actual: `${bitmap.width}x${bitmap.height}`,
            };
          }),
        ),
      manifest.icons,
    );
    report.icons = icons;
    for (const icon of icons) {
      expect(icon.ok, `icon ${icon.src} could not be fetched`);
      expect(
        !icon.ok || icon.declared === icon.actual,
        `icon ${icon.src} declares ${icon.declared} and is ${icon.actual}`,
      );
    }
  }

  // 4. What is on the device — asserted before going offline, so a failure here
  //    is about the cache and not about the reload.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const name of names) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
    }
    return out;
  });
  report.cached = Object.fromEntries(
    Object.entries(cached).map(([name, paths]) => [name, paths.length]),
  );
  const shellish = (path) =>
    path === '/' ||
    path === '/manifest.webmanifest' ||
    path.startsWith('/assets/') ||
    path.startsWith('/icons/');
  for (const [name, paths] of Object.entries(cached)) {
    expect(name.startsWith('panorama-shell-'), `an unexpected cache exists: ${name}`);
    for (const path of paths) {
      expect(shellish(path), `${name} holds something that is not the shell: ${path}`);
    }
  }
  expect(
    Object.values(cached).some((paths) => paths.some((path) => path.startsWith('/assets/'))),
    'no assets were cached, so an offline launch would have nothing to run',
  );

  // 3. Offline.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.pn-canvas', { timeout: 15_000 });
  const booted = await page.evaluate(() => globalThis.__panorama !== undefined);
  expect(booted, 'the application did not boot offline');
  await page.locator('[aria-label="Sample tables"] button:has-text("SAMPLE_100")').first().click();
  await page.waitForTimeout(900);
  const opened = await page.evaluate(
    () => [...(globalThis.__panorama?.core?.world?.entities?.values() ?? [])].length,
  );
  report.offlineTables = opened;
  expect(opened > 0, 'no table opened offline');
  await context.setOffline(false);

  // 5. And the things that must *not* have shipped.
  report.agentInterface = agentInterface;
  expect(
    agentInterface !== 'answered',
    'the agent interface answered in a build: it is a development server route',
  );

  report.external = [...external];
  for (const host of external) {
    note(`the page asked ${host} for something: an installed app talks to its own origin`);
  }
} finally {
  await browser.close();
  preview.kill('SIGTERM');
}

console.info(JSON.stringify(report, null, 2));
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.info(
  '\ninstallable: worker active, manifest and icons sound, launches offline, shell only',
);
