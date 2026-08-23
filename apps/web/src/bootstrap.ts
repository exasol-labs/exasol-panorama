import { DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { WorkerEndpoint } from '@panorama/worker';
import { Workspace } from './panorama/workspace.js';
import { DEMO_SCHEMA, demoSchema } from './panorama/demo.js';
import { startDataWorker } from './panorama/start-data-worker.js';

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
