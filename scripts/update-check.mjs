/**
 * Builds one version, updates it to another, and proves the second one runs.
 *
 * Every other test of the updater covers a part of it: that a schedule is late
 * and rare, that a manifest names both macOS architectures, that a notice says
 * the right sentence. None of them would notice the mechanism rotting — a
 * signature that stopped matching, an endpoint shape that changed, an install
 * that unpacks somewhere the next launch does not look. Those only show up when
 * an application actually replaces itself, so that is what this does:
 *
 *   1. Generate a throwaway signing keypair, so the probe needs no secret and
 *      cannot accidentally sign anything real.
 *   2. Build **0.0.2** with it, which produces the `.app.tar.gz` an update is.
 *   3. Build **0.0.1** pointed at a local update server and trusting that key.
 *   4. Copy 0.0.1 somewhere of its own and run it. It should stage the update.
 *   5. Quit it, the way a person does. It should install while it goes.
 *   6. Run it again — the same path — and it should be 0.0.2.
 *
 * macOS only, for now: it drives the quit with `osascript`, and the artifact it
 * installs is an `.app`. What it proves is not platform-specific, and neither is
 * anything it tests except the last mile.
 *
 *     npm run update-check
 *
 * Slow — two release builds — and run by hand rather than in CI, which is the
 * same bargain as `install-check` before it earned its place.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.PANORAMA_UPDATE_PORT ?? 4190);
const FROM = '0.0.1';
const TO = '0.0.2';
const APP = 'Exasol Panorama.app';
const BUNDLE_ID = 'com.exasol.panorama';

const problems = [];
const note = (message) => problems.push(message);
const say = (message) => console.info(message);

if (process.platform !== 'darwin') {
  console.error('update-check drives a macOS `.app`; run it there.');
  process.exit(1);
}

/**
 * Somewhere to work, with the symlinks resolved out of it.
 *
 * `realpathSync` is not tidiness. The updater refuses to act on an executable
 * whose path contains a symlink — it will not replace something it cannot be
 * sure of the identity of — and on macOS the temporary directory is under
 * `/var`, which is a symlink to `/private/var`. Without this the application
 * says `found current_exe() that contains a symlink on a non-allowed platform`
 * and stages nothing, which reads exactly like a broken updater.
 */
const work = realpathSync(mkdtempSync(join(tmpdir(), 'panorama-update-')));
const serving = join(work, 'serving');
mkdirSync(serving);

/** Runs something and gives up loudly: every step here is a precondition. */
const run = (command, args, options = {}) => {
  const done = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (done.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed (${done.status}).`);
    process.exit(1);
  }
  return done;
};

const quietly = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', ...options });

/** The version a built bundle says it is, read from the bundle rather than assumed. */
const versionOf = (app) => {
  const plist = quietly('defaults', [
    'read',
    join(app, 'Contents/Info'),
    'CFBundleShortVersionString',
  ]);
  return plist.stdout?.trim() ?? '';
};

const manifest = join('package.json');
const original = readFileSync(manifest, 'utf8');
const setVersion = (version) => {
  const parsed = JSON.parse(original);
  parsed.version = version;
  writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
};

const bundleDir = 'apps/desktop/src-tauri/target/release/bundle/macos';

let server;
try {
  // 1. A keypair of this probe's own. Nothing real is signed with it, and the
  //    application it builds trusts nothing else.
  say('generating a throwaway signing key...');
  const keyPath = join(work, 'probe.key');
  run('npx', ['tauri', 'signer', 'generate', '--ci', '-w', keyPath, '-p', ''], {
    cwd: 'apps/desktop',
    stdio: 'ignore',
  });
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const signing = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  };

  // 2. The version being updated *to*, built first so its bundle is what the
  //    server hands out.
  say(`building ${TO}, the version to update to...`);
  setVersion(TO);
  run(
    'npm',
    [
      'run',
      'build',
      '--workspace',
      '@panorama/desktop',
      '--',
      '--config',
      JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
    ],
    { env: signing },
  );

  const tarball = quietly('sh', [
    '-c',
    `ls "${bundleDir}"/*.app.tar.gz 2>/dev/null | head -1`,
  ]).stdout.trim();
  if (tarball === '') {
    console.error('no .app.tar.gz was produced: createUpdaterArtifacts did not run.');
    process.exit(1);
  }
  cpSync(tarball, join(serving, basename(tarball)));
  cpSync(`${tarball}.sig`, join(serving, `${basename(tarball)}.sig`));

  writeFileSync(
    join(serving, 'latest.json'),
    `${JSON.stringify(
      {
        version: TO,
        notes: 'the probe',
        pub_date: new Date().toISOString(),
        platforms: {
          'darwin-aarch64': {
            signature: readFileSync(`${tarball}.sig`, 'utf8').trim(),
            url: `http://localhost:${PORT}/${basename(tarball)}`,
          },
          'darwin-x86_64': {
            signature: readFileSync(`${tarball}.sig`, 'utf8').trim(),
            url: `http://localhost:${PORT}/${basename(tarball)}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  // 3. The version being updated *from*, pointed at the server above. Plain HTTP
  //    on loopback, which the updater refuses unless told: the alternative is a
  //    certificate this probe would have to make and the application would have
  //    to be talked into trusting, to prove something about updates.
  say(`building ${FROM}, the version to update from...`);
  setVersion(FROM);
  run('npm', [
    'run',
    'build',
    '--workspace',
    '@panorama/desktop',
    '--',
    '--config',
    JSON.stringify({
      plugins: {
        updater: {
          pubkey: publicKey,
          endpoints: [`http://localhost:${PORT}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }),
  ]);

  // 4. Its own copy, so the probe replaces that rather than the bundle somebody
  //    might have in their Dock.
  const installed = join(work, APP);
  cpSync(join(bundleDir, APP), installed, { recursive: true });
  const before = versionOf(installed);
  if (before !== FROM) note(`the copy says it is ${before}, not ${FROM}`);

  server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').slice(1));
    try {
      response.writeHead(200).end(readFileSync(join(serving, name)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const log = join(work, 'run.log');

  /**
   * Runs the application until a line shows up in its log, or time runs out.
   *
   * Through `open` rather than by running the executable inside the bundle, and
   * that matters for the step after this one: a binary started directly is a
   * process, but only an application *launched* is one that can be addressed by
   * name — and `quit` is addressed to a name. Started the other way, the quit
   * went nowhere, nothing installed, and it read exactly like a broken updater.
   * `--stdout`/`--stderr` are what keep the log that made that visible.
   */
  const launch = async (until, limitMs) => {
    writeFileSync(log, '');
    run('open', [
      '-n',
      '--stdout',
      log,
      '--stderr',
      log,
      '--env',
      'PANORAMA_UPDATE_FIRST_LOOK_MS=1500',
      installed,
    ]);
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      const seen = readFileSync(log, 'utf8');
      if (until.test(seen)) return { log: seen };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { log: readFileSync(log, 'utf8'), timedOut: true };
  };

  /** Whether the copy this probe is driving is still running. */
  const stillRunning = () =>
    quietly('pgrep', ['-f', join(installed, 'Contents/MacOS')]).status === 0;

  say(`running ${FROM}, waiting for it to stage ${TO}...`);
  const staged = await launch(/downloaded and staged/u, 90_000);
  if (staged.timedOut) {
    note(`${FROM} never staged an update`);
    console.error(
      staged.log
        .split('\n')
        .filter((line) => line.includes('update'))
        .join('\n'),
    );
  }

  // 5. Quit it the way somebody does — an application quit, not a window close.
  //    The two are different events, and on macOS this is the usual one.
  say('quitting it, the way a person does...');
  const quit = quietly('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
  if (quit.status !== 0) note(`could not ask it to quit: ${quit.stderr?.trim()}`);
  const goneBy = Date.now() + 60_000;
  while (Date.now() < goneBy && stillRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (stillRunning()) note('it never went away after being asked to quit');
  const closingLog = readFileSync(log, 'utf8');
  if (!/installed; it starts next time/u.test(closingLog)) {
    note('it did not install anything while closing');
    console.error(
      closingLog
        .split('\n')
        .filter((line) => line.includes('panorama'))
        .join('\n'),
    );
  }

  // 6. The bundle on disk, and then the application it starts.
  const after = versionOf(installed);
  if (after !== TO) note(`after updating, the bundle says ${after} rather than ${TO}`);

  say('running it again...');
  const again = await launch(
    new RegExp(`Exasol Panorama ${TO.replace(/\./gu, '\\.')} running`, 'u'),
    60_000,
  );
  if (again.timedOut) {
    note(`the application that came up did not say it was ${TO}`);
    console.error(again.log.split('\n').slice(0, 6).join('\n'));
  }
  quietly('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);

  console.info(
    `\n${JSON.stringify({ before, afterInstall: after, ranAgain: !again.timedOut }, null, 2)}`,
  );
} finally {
  writeFileSync(manifest, original);
  server?.close();
  // Kept when something went wrong: the bundle, the manifest it was offered and
  // the log it wrote are the whole of the evidence, and they are gone the moment
  // this returns otherwise.
  if (problems.length === 0) {
    rmSync(work, { recursive: true, force: true });
  } else {
    console.error(`\nleft behind for inspection: ${work}`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.info(
  `\nan installed ${FROM} updated itself to ${TO} on the way out, and came back as ${TO}.`,
);
process.exit(0);
