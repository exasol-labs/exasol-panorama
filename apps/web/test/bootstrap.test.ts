import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendOverride, createWorkerEndpoint, createWorkspace } from '../src/bootstrap.js';
import { startDataWorker } from '../src/panorama/start-data-worker.js';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDataWorker', () => {
  it('attaches a data worker to an endpoint', () => {
    const listeners: unknown[] = [];
    const worker = startDataWorker({
      postMessage: () => {},
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: () => {},
    });
    expect(worker.openTableCount).toBe(0);
    expect(listeners).toHaveLength(1);
  });
});

describe('the Exasol connection factory', () => {
  it('builds a real connection and reports a failure to reach the server', async () => {
    const { createInProcessEndpointPair, DataWorkerClient } = await import('@panorama/worker');
    const pair = createInProcessEndpointPair();
    startDataWorker(pair.worker);
    const client = new DataWorkerClient(pair.main);

    // No socket implementation in jsdom, so opening fails — but the factory ran.
    await expect(
      client.connect('wss://unreachable.invalid:8563', { kind: 'token', token: 't' }),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('createWorkerEndpoint', () => {
  it('runs the data worker in-process when asked', async () => {
    const endpoint = createWorkerEndpoint({ useWorker: false });
    const received: unknown[] = [];
    endpoint.addEventListener('message', (event) => received.push(event.data));

    endpoint.postMessage({ type: 'listSchemas', requestId: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The worker is live and answers, even without a connection.
    expect(received).toEqual([
      {
        type: 'result',
        requestId: 1,
        ok: false,
        error: expect.objectContaining({ code: 'connection-lost' }),
      },
    ]);
  });

  it('falls back in-process where Workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createWorkerEndpoint()).toBeDefined();
  });

  it('spawns a real Worker when one is available', () => {
    const constructed: Array<{ url: URL; options: unknown }> = [];
    class StubWorker {
      constructor(url: URL, options: unknown) {
        constructed.push({ url, options });
      }
    }
    vi.stubGlobal('Worker', StubWorker);
    const endpoint = createWorkerEndpoint();
    expect(endpoint).toBeInstanceOf(StubWorker);
    expect(constructed[0]?.options).toMatchObject({ type: 'module', name: 'panorama-data' });
    expect(String(constructed[0]?.url)).toContain('data-worker');
  });
});

describe('createWorkspace', () => {
  it('builds a workspace on an in-process worker', () => {
    const workspace = createWorkspace({ useWorker: false });
    expect(workspace.openTableCount).toBe(0);
    expect(workspace.core.world.entities.size).toBe(0);
  });

  it('resolves demo schemas without a database', async () => {
    const workspace = createWorkspace({ useWorker: false, demoLatencyMs: 0 });
    // No connection: this only works because the demo schema is resolved locally.
    const id = await workspace.openTable({ schema: DEMO_SCHEMA, table: 'SAMPLE_100' });
    expect(workspace.core.world.entities.get(id)?.source.table).toBe('SAMPLE_100');
    await expect(workspace.openTable({ schema: 'SOMEWHERE_ELSE', table: 'X' })).rejects.toThrow();
  });
});

describe('backendOverride', () => {
  it('reads a backend from the query string', () => {
    expect(backendOverride('?backend=webgl')).toBe(false);
    expect(backendOverride('?backend=webgpu')).toBe(true);
  });

  it('leaves the choice to the renderer when unspecified', () => {
    expect(backendOverride('')).toBeUndefined();
    expect(backendOverride('?other=1')).toBeUndefined();
    expect(backendOverride('?backend=metal')).toBeUndefined();
  });
});
