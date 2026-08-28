import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { panoramaAgent } from '../../packages/mcp/src/vite-plugin.js';
import { SERVICE_WORKER_FILE } from './src/panorama/install.js';
import { readStartupConnection } from './src/panorama/startup.js';
/*
 * The workspace root's manifest, which is where the version lives — the release
 * workflow reads that one to check the tag agrees with it, so it is the number
 * the application has to call itself. Imported rather than read off disk: this
 * file is evaluated by a test as well as by Vite, and `import.meta.url` is not a
 * `file:` URL there.
 */
import workspaceManifest from '../../package.json' with { type: 'json' };

const workspacePackage = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

/**
 * Loads `.env.local` from wherever the command was run, so connection details
 * can live in a file instead of a shell history. Node parses it; there is no
 * reason to write a second parser. The file is ignored by git.
 */
const loadEnvFile = (): void => {
  const file = resolve(process.cwd(), '.env.local');
  if (existsSync(file)) process.loadEnvFile(file);
};

const httpsFromEnvironment = (): { https?: { key: Buffer; cert: Buffer } } => {
  const key = process.env['PANORAMA_HTTPS_KEY'];
  const cert = process.env['PANORAMA_HTTPS_CERT'];
  if (key === undefined || cert === undefined) return {};
  return { https: { key: readFileSync(key), cert: readFileSync(cert) } };
};

/**
 * The port the app is served on, and so the port an agent is pointed at when it
 * is paired. One constant, because a client told the wrong number fails later,
 * somewhere else.
 */
const DEV_PORT = Number(process.env['PANORAMA_PORT'] ?? 5173);

/**
 * The worker's entry name, which becomes its file name, which is the path the
 * page registers. One constant: a mismatch here is an install that silently
 * never happens. `src/panorama/install.ts` holds the other end of it.
 */
const SERVICE_WORKER = 'service-worker';

/**
 * Where this build will be served from — and by default, wherever it is put.
 *
 * `./` rather than `/`, so every address in the build is relative to the document
 * that names it. An origin of its own, a project site under a repository name, a
 * folder on somebody's laptop: all the same build, no configuration, nothing to
 * get wrong. It is what the rest of the design already assumed — the manifest's
 * URLs resolve against the manifest, and the service worker's base is the
 * directory it was served from — so this is the last piece rather than a new idea.
 *
 * The reason it is a default rather than a decision: GitHub serves an
 * access-controlled Pages site from a generated hostname, and whether a project
 * site sits at that host's root or under the repository's name is not something
 * to find out by deploying and hoping. A relative build is right either way.
 *
 * `PANORAMA_BASE` overrides it for a deployment that needs absolute URLs — one
 * behind a rewriting proxy, or serving deep links the application does not have.
 */
const BASE = process.env['PANORAMA_BASE'] ?? './';

/**
 * Writes the list of files the build produced, for the service worker to fetch
 * while installing. See `src/panorama/shell-cache.ts` for why it needs one: the
 * renderer imports its shaders lazily, so "cache what has been used" leaves an
 * installed application unable to draw a table the first time it is offline.
 *
 * Emitted from the bundle rather than by walking the output directory, so it can
 * only ever name files this build actually made. Source maps are left out: they
 * are five times the size of the application and are for a debugger with a
 * network.
 */
/**
 * The three things a build has to tell the shell about itself.
 *
 * One plugin because they are one fact — what this build *is* — expressed three
 * ways, and because two of them are derived from the third.
 *
 * 1. `shell-assets.json`, the list the service worker precaches at install time.
 *    Emitted from the bundle rather than by walking the output directory, so it
 *    can only ever name files this build actually made. Source maps are left out:
 *    they are five times the size of the application and are for a debugger with
 *    a network.
 * 2. `version.json`, so a running page can ask what a *newer* deployment calls
 *    itself. The number is compiled in as well, but a page cannot learn that from
 *    a constant baked into the older build. Kept out of the precache list on
 *    purpose: a cached answer to "what is the new version" is the one answer that
 *    is always wrong.
 * 3. A build stamp appended to `service-worker.js`, and this one is load-bearing
 *    in a way that is easy to miss. **A browser only notices a new worker when
 *    the worker file's bytes change.** This one lists nothing and hashes nothing
 *    — it fetches the asset list at install time — so it was byte-identical
 *    across deployments, and a browser therefore saw no update, never installed
 *    one, never left one waiting, and never gave the page anything to report.
 *    Panorama's whole update story on the web rests on that file changing, so it
 *    is made to change exactly when there is something new to install: when the
 *    set of built assets differs, or when the version does.
 */
const shellFiles = (version: string): Plugin => ({
  name: 'panorama-shell-files',
  apply: 'build',
  generateBundle(_options, bundle) {
    const files = Object.keys(bundle)
      // Relative to the base, because that is what the worker resolves them
      // against — an absolute `/assets/...` is the wrong file under a path.
      .filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
      .sort();
    this.emitFile({
      type: 'asset',
      fileName: 'shell-assets.json',
      source: `${JSON.stringify(files, null, 2)}\n`,
    });
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: `${JSON.stringify({ version }, null, 2)}\n`,
    });

    const worker = bundle[`${SERVICE_WORKER_FILE}`];
    if (worker !== undefined && worker.type === 'chunk') {
      const stamp = createHash('sha256')
        .update(version)
        .update(files.join('\n'))
        .digest('hex')
        .slice(0, 12);
      worker.code += `\n// panorama build ${stamp}\n`;
    }
  },
});

const startupForServing = (): ReturnType<typeof readStartupConnection> => {
  loadEnvFile();
  return readStartupConnection(process.env);
};

export default defineConfig(({ command }) => ({
  base: BASE,
  /**
   * The agent interface is mounted on the dev server: see `packages/mcp`. It
   * answers from the live session in the page, so it belongs in the process that
   * is serving that page and nowhere near a build.
   */
  plugins: [
    react(),
    panoramaAgent({ port: DEV_PORT, onLog: (message) => console.info(`[agent] ${message}`) }),
    shellFiles(workspaceManifest.version),
  ],
  resolve: {
    alias: {
      '@panorama/core': workspacePackage('core'),
      '@panorama/table': workspacePackage('table'),
      '@panorama/exasol': workspacePackage('exasol'),
      '@panorama/export': workspacePackage('export'),
      '@panorama/mcp': workspacePackage('mcp'),
      '@panorama/worker': workspacePackage('worker'),
      '@panorama/renderer': workspacePackage('renderer'),
      '@panorama/ui': workspacePackage('ui'),
      '@panorama/test-support': workspacePackage('test-support'),
    },
  },
  /**
   * HTTPS when `npm run dev:vr` supplies a certificate. WebXR is only offered on
   * a secure page, and a headset reaching this machine over the LAN does not get
   * localhost's exemption.
   */
  server: { port: DEV_PORT, ...httpsFromEnvironment() },
  /**
   * Connection details supplied before the page opens — see `startup.ts`.
   *
   * Read here rather than through `import.meta.env` so the names need no
   * `VITE_` prefix and, more importantly, so nothing is inlined automatically:
   * a build is handed a literal `null`, which is what keeps a password out of a
   * deployable artifact.
   */
  define: {
    __PANORAMA_STARTUP__: JSON.stringify(command === 'serve' ? startupForServing() : null),
    // What this build calls itself, from the one place the version is declared.
    // Inlined rather than imported so that asking costs nothing at runtime and
    // a development page and a build answer the same way.
    __PANORAMA_VERSION__: JSON.stringify(workspaceManifest.version),
  },
  /**
   * Two entry points, because a service worker has to be reachable at a fixed
   * path: its scope is the directory it is served from, so a hashed name under
   * `assets/` could control neither the document nor a client that registered an
   * earlier one. Everything else keeps the hashed names that make it cacheable
   * forever — see `src/panorama/shell-cache.ts`.
   */
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      // Relative to the project root, which is this directory: naming them by
      // absolute path would mean resolving one while the config is merely being
      // read, which is something a test does too.
      input: { index: 'index.html', [SERVICE_WORKER]: 'src/service-worker.ts' },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === SERVICE_WORKER ? '[name].js' : 'assets/[name]-[hash].js',
      },
    },
  },
  worker: { format: 'es' },
}));
