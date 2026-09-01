import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Workspace package name -> source entry point. Shared by Vitest and the web app. */
export const panoramaAliases: Record<string, string> = {
  '@panorama/core': resolvePath('./packages/core/src/index.ts'),
  '@panorama/json-tables': resolvePath('./packages/json-tables/src/index.ts'),
  '@panorama/table': resolvePath('./packages/table/src/index.ts'),
  '@panorama/chart': resolvePath('./packages/chart/src/index.ts'),
  '@panorama/chart-echarts': resolvePath('./packages/chart-echarts/src/index.ts'),
  '@panorama/exasol': resolvePath('./packages/exasol/src/index.ts'),
  '@panorama/mcp': resolvePath('./packages/mcp/src/index.ts'),
  '@panorama/export': resolvePath('./packages/export/src/index.ts'),
  '@panorama/worker': resolvePath('./packages/worker/src/index.ts'),
  '@panorama/renderer': resolvePath('./packages/renderer/src/index.ts'),
  '@panorama/ui': resolvePath('./packages/ui/src/index.ts'),
  '@panorama/test-support': resolvePath('./packages/test-support/src/index.ts'),
};

const logicPackages = [
  'core',
  'json-tables',
  'table',
  'chart',
  'chart-echarts',
  'exasol',
  'export',
  'mcp',
  'worker',
  'test-support',
  'renderer',
];
const domPackages = ['ui'];

export default defineConfig({
  resolve: { alias: panoramaAliases },
  test: {
    globals: true,
    projects: [
      {
        resolve: { alias: panoramaAliases },
        test: {
          name: 'logic',
          globals: true,
          environment: 'node',
          include: logicPackages.map((pkg) => `packages/${pkg}/test/**/*.test.ts`),
        },
      },
      {
        resolve: { alias: panoramaAliases },
        test: {
          name: 'dom',
          globals: true,
          environment: 'jsdom',
          include: [
            ...domPackages.map((pkg) => `packages/${pkg}/test/**/*.test.{ts,tsx}`),
            'apps/web/test/**/*.test.{ts,tsx}',
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        '**/types.ts',
        // Entry points: a single side-effectful call each, exercised by the
        // functions they delegate to.
        'apps/web/src/main.tsx',
        'apps/web/src/data-worker.ts',
        // Same: it wires three listeners onto a service worker global. The policy
        // it wires them to is `panorama/shell-cache.ts`, which is covered, and the
        // wiring itself is checked in a real browser by `npm run install-check`.
        'apps/web/src/service-worker.ts',
      ],
      // Locked to what the suite currently achieves; the residue is defensive
      // `??` fallbacks and browser-only engine paths.
      thresholds: {
        lines: 100,
        functions: 99,
        branches: 96,
        statements: 99,
      },
    },
  },
});
