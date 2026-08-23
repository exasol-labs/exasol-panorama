import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const workspacePackage = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@panorama/core': workspacePackage('core'),
      '@panorama/table': workspacePackage('table'),
      '@panorama/exasol': workspacePackage('exasol'),
      '@panorama/worker': workspacePackage('worker'),
      '@panorama/renderer': workspacePackage('renderer'),
      '@panorama/ui': workspacePackage('ui'),
      '@panorama/test-support': workspacePackage('test-support'),
    },
  },
  server: { port: 5173 },
  build: { target: 'esnext', sourcemap: true },
  worker: { format: 'es' },
});
