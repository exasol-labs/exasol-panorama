import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 620, height: 200 } });
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    console.log(`[${message.type()}]`, message.text());
  }
});
await page.goto('http://localhost:5200/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('names:', (await page.evaluate(() => globalThis.__probe.names)).join(' | '));
console.log(
  'opaque atlas pixels:',
  await page.evaluate(() => globalThis.__atlasProbe?.() ?? 'n/a'),
);
await page.screenshot({ path: 'scripts/probe/probe.png' });
await browser.close();
