import { describe, expect, it } from 'vitest';
import { createInProcessEndpointPair } from '@panorama/worker';

describe('createInProcessEndpointPair', () => {
  it('delivers messages asynchronously to the peer', async () => {
    const { main, worker } = createInProcessEndpointPair();
    const seen: unknown[] = [];
    worker.addEventListener('message', (event) => seen.push(event.data));

    main.postMessage({ hello: 'world' });
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([{ hello: 'world' }]);
  });

  it('delivers in both directions and supports several listeners', async () => {
    const { main, worker } = createInProcessEndpointPair();
    const first: unknown[] = [];
    const second: unknown[] = [];
    main.addEventListener('message', (event) => first.push(event.data));
    main.addEventListener('message', (event) => second.push(event.data));

    worker.postMessage('ping');
    await Promise.resolve();
    expect(first).toEqual(['ping']);
    expect(second).toEqual(['ping']);
  });

  it('stops delivering to removed listeners', async () => {
    const { main, worker } = createInProcessEndpointPair();
    const seen: unknown[] = [];
    const listener = (event: { data: unknown }): void => {
      seen.push(event.data);
    };
    main.addEventListener('message', listener);
    main.removeEventListener('message', listener);
    worker.postMessage('ping');
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
