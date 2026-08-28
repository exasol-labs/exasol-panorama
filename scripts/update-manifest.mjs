/**
 * Builds the `latest.json` an installed Panorama asks whether it is out of date.
 *
 * The updater fetches one file, looks up its own platform in it, and downloads
 * and verifies whatever that names. So this is the whole of the update server:
 * a static file published beside the artifacts it points at.
 *
 * Run over a directory of release assets — the bundles and the `.sig` files the
 * bundler wrote next to them:
 *
 *     node scripts/update-manifest.mjs --version 0.2.0 --dir assets --out latest.json
 *
 * Three things it is careful about, each of which is a way to publish a manifest
 * that looks right and updates nobody:
 *
 * - **A platform with no signature is left out.** The updater cannot skip the
 *   check, so an entry without one is an entry that fails at the last moment,
 *   after the download, on the user's machine. Absent means "no update for you
 *   yet", which is true and harmless.
 * - **macOS is named twice.** The bundle is universal, but the updater looks its
 *   own platform up by an exact key — `darwin-aarch64` or `darwin-x86_64` — and
 *   there is no fallback between them. One file, two entries pointing at it.
 * - **The signature is the file's contents, not its path.** A `.sig` is small and
 *   the manifest carries it inline; a URL there would be a second thing to fetch
 *   and a second thing to get wrong.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined && fallback === undefined) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return value ?? fallback;
};

const version = argument('version');
const directory = argument('dir');
const out = argument('out', 'latest.json');
const repository = argument('repo', process.env.GITHUB_REPOSITORY ?? 'exasol-labs/exasol-panorama');
const notes = argument('notes', `Panorama ${version}`);

/** Where a release asset ends up, which is where the updater will look for it. */
const downloadUrl = (file) =>
  `https://github.com/${repository}/releases/download/v${version}/${file}`;

/**
 * Which platforms a bundle answers for.
 *
 * Ordered, and the order matters on Windows: the NSIS installer is per-user and
 * needs no administrator, so it is the one an application should install for
 * itself. The MSI is there for whoever deploys by policy, and it is not what an
 * update should reach for.
 */
const PLATFORMS = [
  { ends: '.app.tar.gz', targets: ['darwin-aarch64', 'darwin-x86_64'] },
  { ends: '-setup.exe', targets: ['windows-x86_64'] },
  { ends: '.msi', targets: ['windows-x86_64'] },
  { ends: '.AppImage', targets: ['linux-x86_64'] },
];

const files = readdirSync(directory);
const platforms = {};
const skipped = [];

for (const { ends, targets } of PLATFORMS) {
  // `.sig` files end in the bundle's name too, so they are excluded by name
  // rather than by hoping the extension sorts them out.
  const bundle = files.find((file) => file.endsWith(ends) && !file.endsWith('.sig'));
  if (bundle === undefined) continue;
  // Already answered by something earlier in the list — the NSIS installer
  // before the MSI — so this one is a second way to install the same version.
  if (targets.every((target) => platforms[target] !== undefined)) continue;

  const signature = files.find((file) => file === `${bundle}.sig`);
  if (signature === undefined) {
    skipped.push(`${bundle} (no signature beside it)`);
    continue;
  }
  const url = downloadUrl(bundle);
  const contents = readFileSync(join(directory, signature), 'utf8').trim();
  for (const target of targets) platforms[target] = { signature: contents, url };
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `no signed bundles in ${directory}: nothing could update to ${version}, so no manifest was written.`,
  );
  for (const one of skipped) console.error(`  - ${one}`);
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.info(`${out}: ${version} for ${Object.keys(platforms).sort().join(', ')}`);
for (const one of skipped) console.warn(`  left out: ${one}`);
