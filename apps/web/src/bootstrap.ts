import { DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { WorkerEndpoint } from '@panorama/worker';
import { Workspace } from './panorama/workspace.js';
import { DEMO_SCHEMA, demoSchema } from './panorama/demo.js';
import { openSaveSink, rasteriseSvg } from './panorama/save-file.js';
import { startDataWorker } from './panorama/start-data-worker.js';
import { EChartsSurface } from '@panorama/chart-echarts';

/**
 * Wiring.
 *
 * A real `Worker` keeps every database operation off the render thread. Where
 * Workers are unavailable the same `DataWorker` runs in-process: identical
 * behaviour, minus the isolation.
 */

export interface BootstrapOptions {
  /** Set to false to run the data worker in-process. */
  readonly useWorker?: boolean;
  readonly demoLatencyMs?: number;
  /**
   * Where database sockets are opened, if not at the database itself. The desktop
   * application answers this with its own; see `panorama/shell.ts`.
   */
  readonly databaseSocket?: () => string | undefined;
}

export const createWorkerEndpoint = (options: BootstrapOptions = {}): WorkerEndpoint => {
  if (options.useWorker === false || typeof Worker === 'undefined') {
    const pair = createInProcessEndpointPair();
    startDataWorker(
      pair.worker,
      options.demoLatencyMs === undefined ? {} : { demoLatencyMs: options.demoLatencyMs },
    );
    return pair.main;
  }
  return new Worker(new URL('./data-worker.ts', import.meta.url), {
    type: 'module',
    name: 'panorama-data',
  }) as unknown as WorkerEndpoint;
};

export const createWorkspace = (options: BootstrapOptions = {}): Workspace =>
  new Workspace({
    client: new DataWorkerClient(createWorkerEndpoint(options)),
    resolveSchema: (schema, table) => (schema === DEMO_SCHEMA ? demoSchema(table) : undefined),
    // Wired here rather than in the shell: choosing where a file goes is a
    // browser dialog, and the workspace should not know that a DOM exists.
    openExportSink: openSaveSink,
    // The chart library enters here and nowhere else. Everything upstream —
    // core, the renderer, the workspace — knows only the interface.
    chartSurface: new EChartsSurface(),
    // Rasterising is the browser's job: it has the fonts and the decoder.
    rasteriseSvg,
    ...(options.databaseSocket === undefined ? {} : { databaseSocket: options.databaseSocket }),
  });

/**
 * Reads `?backend=webgl|webgpu` from the URL.
 *
 * A graphics backend is exactly the kind of thing that needs to be swappable
 * without a rebuild when something looks wrong on unfamiliar hardware.
 */
export const backendOverride = (search: string): boolean | undefined => {
  const backend = new URLSearchParams(search).get('backend');
  if (backend === 'webgl') return false;
  if (backend === 'webgpu') return true;
  return undefined;
};
