/**
 * Data worker entry point.
 *
 * Everything below this line runs off the render thread: the Exasol WebSocket
 * client, protocol decoding, result-set lifecycle and fetch scheduling.
 */
import type { WorkerEndpoint } from '@panorama/worker';
import { startDataWorker } from './panorama/start-data-worker.js';

startDataWorker(self as unknown as WorkerEndpoint);
