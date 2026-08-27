/**
 * Derives the desktop bundler's icons from the mark.
 *
 * `scripts/make-icons.mjs` draws the mark and writes `source.png`, a 1024-square
 * with an alpha channel; this turns that into the formats each desktop bundler
 * insists on — an `.icns` for macOS, an `.ico` for Windows, and the handful of
 * PNGs named in `tauri.conf.json`. Committed, like the web icons, so that a build
 * never depends on having run this and a reviewer can see what changed.
 *
 * The CLI also writes complete iOS and Android icon sets and the tiles a Windows
 * Store package would need, none of which this project has a target for. They are
 * removed rather than committed: unused generated binaries are something somebody
 * later has to work out the status of. Add a target, regenerate, keep what it asks
 * for.
 *
 *     npm run icons        # the mark, the web icons, and these
 */
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const icons = join(desktop, 'src-tauri/icons');

const generated = spawnSync(
  'npx',
  ['tauri', 'icon', join(icons, 'source.png'), '--output', icons],
  {
    cwd: desktop,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
if (generated.status !== 0) process.exit(generated.status ?? 1);

// No mobile and no Store targets: see above.
for (const platform of ['ios', 'android']) {
  rmSync(join(icons, platform), { recursive: true, force: true });
}
for (const file of readdirSync(icons)) {
  if (/^(Square\d|StoreLogo)/.test(file)) rmSync(join(icons, file));
}
console.info('desktop icons written to apps/desktop/src-tauri/icons');
