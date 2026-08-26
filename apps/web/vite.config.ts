import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { panoramaAgent } from '../../packages/mcp/src/vite-plugin.js';
import { readStartupConnection } from './src/panorama/startup.js';

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

const startupForServing = (): ReturnType<typeof readStartupConnection> => {
  loadEnvFile();
  return readStartupConnection(process.env);
};

export default defineConfig(({ command }) => ({
  /**
   * The agent interface is mounted on the dev server: see `packages/mcp`. It
   * answers from the live session in the page, so it belongs in the process that
   * is serving that page and nowhere near a build.
   */
  plugins: [
    react(),
    panoramaAgent({ port: DEV_PORT, onLog: (message) => console.info(`[agent] ${message}`) }),
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
  },
  build: { target: 'esnext', sourcemap: true },
  worker: { format: 'es' },
}));
