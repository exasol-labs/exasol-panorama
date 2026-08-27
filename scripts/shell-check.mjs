/**
 * Drives the built page as if it were inside the desktop application.
 *
 * Everything the shell answers — the databases on this machine, the agent
 * endpoint, what Claude there is — reaches the page over an IPC call that a
 * browser does not have. So those parts of the interface are the one place where
 * a unit test can pass while the application is broken, and that is not a
 * hypothesis: the local-deployments list was written, tested, built and shipped
 * *not working*, because the sidebar is a `useMemo` whose dependency list did not
 * name the state the list is drawn from. Every test passed. The panel was empty.
 *
 * This closes that gap by stubbing the shell's global in a real browser and
 * looking at the rendered page. It asserts, and sets a non-zero exit code.
 *
 *     npm run build && npm run shell-check
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = Number(process.env.PANORAMA_SHELL_PORT ?? 4188);
const origin = `http://localhost:${PORT}/`;

if (!existsSync('apps/web/dist/index.html')) {
  console.error('No build at apps/web/dist. Run `npm run build` first.');
  process.exit(1);
}

const problems = [];
const expect = (claim, message) => {
  if (!claim) problems.push(message);
};
const report = {};

/** The shell, as the page reaches it: two functions on a global. */
const shell = (deployments) => `
  window.__TAURI_INTERNALS__ = {};
  window.__calls = [];
  window.__TAURI__ = {
    event: { listen: async () => () => undefined },
    core: {
      invoke: async (command, args) => {
        window.__calls.push({ command, args });
        if (command === 'exasol_deployments') {
          // The real shell answers the names-only call with names alone; only the
          // later ones say which rows can be clicked. The page has to end up
          // showing the fuller answer.
          if (args?.detail === 'names' || args?.detail === undefined) {
            return {
              installed: true,
              deployments: ${JSON.stringify(deployments)}.deployments.map((one) => ({
                name: one.name,
                status: 'checking',
                infrastructure: one.infrastructure,
              })),
            };
          }
          return ${JSON.stringify(deployments)};
        }
        if (command === 'exasol_deployment_credentials') {
          return { url: 'wss://127.0.0.1:8563', username: 'sys', password: 'secret' };
        }
        if (command === 'agent_status') {
          return {
            attached: 1,
            calls: 0,
            lastCallAt: null,
            mcpUrl: 'http://127.0.0.1:7355/agent/mcp',
            port: 7355,
          };
        }
        if (command === 'claude_status') {
          return {
            platform: 'macos',
            cli: { found: true, paired: false },
            desktop: { found: false, configPath: '', paired: false },
            canOpenTerminal: true,
            mcpUrl: 'http://127.0.0.1:7355/agent/mcp',
          };
        }
        return undefined;
      },
    },
  };
`;

const preview = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', 'apps/web'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const ready = new Promise((resolve, reject) => {
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('Local:')) resolve();
  });
  preview.on('error', reject);
  setTimeout(() => reject(new Error('the preview server did not start')), 20_000);
});

let browser = null;
try {
  await ready;
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });

  /** One page, with whatever shell it should think it is in. */
  const open = async (script) => {
    const page = await browser.newPage();
    const said = [];
    page.on('pageerror', (error) => said.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') said.push(`console: ${message.text()}`);
    });
    if (script !== null) await page.addInitScript(script);
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForSelector('.pn-sidebar', { timeout: 20_000 });
    return { page, said };
  };

  // 1. In the application, with two deployments: the list is there, the running
  //    one can be clicked, and the stopped one says why it cannot.
  const inShell = await open(
    shell({
      installed: true,
      deployments: [
        {
          name: 'default',
          status: 'running',
          infrastructure: 'local',
          url: 'wss://127.0.0.1:8563',
          username: 'sys',
        },
        { name: 'fuzz', status: 'stopped', infrastructure: 'local' },
        {
          name: 'in-a-cloud',
          status: 'running',
          infrastructure: 'aws',
          url: 'wss://db.eu-central-1.example:8563',
          username: 'sys',
        },
      ],
    }),
  );
  // Two ways in, and the deployments are the one it opens on.
  await inShell.page.waitForSelector('[role="tab"][aria-selected="true"]', { timeout: 15_000 });
  report.openTab = await inShell.page.locator('[role="tab"][aria-selected="true"]').textContent();
  expect(report.openTab === 'Personal', `the dialog opened on ${report.openTab}`);
  expect(
    (await inShell.page.getByLabel('Database URL').count()) === 0,
    'the manual form is on screen while Personal is the open tab',
  );
  await inShell.page.waitForSelector('[aria-label="Exasol Personal deployments"]', {
    timeout: 15_000,
  });
  // The rows appear before anything is known about them, and none of them is
  // offered as connectable until the checked answer lands.
  await inShell.page.waitForSelector('.pn-dot--running', { timeout: 15_000 });
  report.rows = await inShell.page
    .locator('[aria-label="Exasol Personal deployments"] button')
    .count();
  expect(report.rows === 3, `expected three deployment rows, saw ${report.rows}`);
  expect(
    (await inShell.page.getByText('port 8563').count()) === 1,
    'the running deployment did not show its port, which is what tells two apart',
  );
  const stopped = inShell.page.getByRole('button', { name: /fuzz/u });
  expect(await stopped.isDisabled(), 'a stopped deployment should not look connectable');

  // Whether it is running, as an indicator and as words: two running, one not.
  report.dots = {
    running: await inShell.page.locator('.pn-dot--running').count(),
    idle: await inShell.page.locator('.pn-dot--idle').count(),
  };
  expect(
    report.dots.running === 2 && report.dots.idle === 1,
    `the running indicators are wrong: ${JSON.stringify(report.dots)}`,
  );
  expect(
    (await inShell.page.getByRole('button', { name: 'default, running' }).count()) === 1,
    'a row does not say its status where only a reader would notice',
  );

  // A deployment managed from here but running in a cloud: the host identifies it,
  // and a port would say nothing.
  expect(
    (await inShell.page.getByText('db.eu-central-1.example').count()) === 1,
    'a deployment in a cloud did not show where it is',
  );
  expect(
    (await inShell.page.getByRole('button', { name: /in-a-cloud/u }).getAttribute('title')) ===
      'aws · wss://db.eu-central-1.example:8563',
    'the row does not say where it is deployed on hover',
  );

  await inShell.page.getByRole('button', { name: /default/u }).click();
  await inShell.page.waitForTimeout(500);
  const asked = await inShell.page.evaluate(() => window.__calls.map((call) => call.command));
  report.asked = asked;
  expect(
    asked.includes('exasol_deployment_credentials'),
    `clicking a deployment did not ask for its credentials: ${asked.join(', ')}`,
  );

  // What a click leads to — the explorer naming the connection by its deployment —
  // needs a database to connect to, so it is asserted in `App.test.tsx` against a
  // fake connection rather than here against none.

  // The other tab is the form, and it is still a form.
  await inShell.page.getByRole('tab', { name: 'Manual' }).click();
  expect(
    (await inShell.page.getByLabel('Database URL').count()) === 1,
    'the Manual tab did not show the form',
  );
  expect(
    (await inShell.page.locator('[aria-label="Exasol Personal deployments"]').count()) === 0,
    'the deployment list is still on screen on the Manual tab',
  );
  await inShell.page.getByRole('tab', { name: 'Personal' }).click();

  // 2. The settings panel, fed by the same route: the endpoint the shell owns,
  //    and the Claude it found on this machine.
  await inShell.page.getByRole('button', { name: 'Show settings' }).click();
  await inShell.page.waitForTimeout(500);
  expect(
    (await inShell.page.getByText('http://127.0.0.1:7355/agent/mcp').count()) > 0,
    'the settings panel did not show the endpoint the shell reported',
  );
  expect(
    (await inShell.page.getByText('found, not paired').count()) > 0,
    'the settings panel did not show the Claude the shell found',
  );
  report.pageProblems = inShell.said;
  expect(inShell.said.length === 0, `the page complained: ${inShell.said.join(' | ')}`);

  // 3. And in a browser, where nothing can look: no section, no empty promise of
  //    one.
  const inBrowser = await open(null);
  expect(
    (await inBrowser.page.locator('.pn-connection').count()) === 1,
    'the connection form is missing in a browser',
  );
  expect(
    (await inBrowser.page.locator('.pn-connection__local').count()) === 0,
    'a browser was offered local deployments it cannot have',
  );
  // And no tabs: one way in, presented as one way in.
  expect(
    (await inBrowser.page.locator('[role="tab"]').count()) === 0,
    'a browser was offered a choice it does not have',
  );
  expect(
    (await inBrowser.page.getByLabel('Database URL').count()) === 1,
    'a browser did not get the form',
  );
  // Not asserted, and reported so it is not mistaken for a finding: a page in a
  // browser opens the agent endpoint on its own origin, and a static preview
  // answers 404. That is the documented behaviour of a deployed build.
  report.browserProblems = inBrowser.said;
} catch (error) {
  problems.push(String(error));
} finally {
  if (browser !== null) await browser.close();
  preview.kill('SIGTERM');
}

console.info(JSON.stringify(report, null, 2));
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.info(
  '\nthe shell-fed interface renders: deployments, one-click connect, settings, and nothing in a browser.',
);
