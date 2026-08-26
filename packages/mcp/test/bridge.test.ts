import { describe, expect, it, vi } from 'vitest';
import { EVENTS_PATH, RESULT_PATH, defaultAgentOrigin, startAgentBridge } from '@panorama/mcp';
import type { EventStreamLike } from '@panorama/mcp';
import { FakeHost, makeTable } from './fixtures.js';

/** A stream the test writes to, standing in for the page's `EventSource`. */
class FakeStream implements EventStreamLike {
  message: ((event: { data: string }) => void) | null = null;
  error: (() => void) | null = null;
  closed = false;

  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.message = listener as unknown as typeof this.message;
    else this.error = listener as unknown as typeof this.error;
  }

  close(): void {
    this.closed = true;
  }
}

const bridged = (
  options: { readonly postFails?: boolean } = {},
): {
  host: FakeHost;
  stream: FakeStream;
  posted: { url: string; body: string }[];
  logs: string[];
  bridge: ReturnType<typeof startAgentBridge>;
  urls: string[];
} => {
  const host = new FakeHost();
  host.add(makeTable(host.ids));
  const stream = new FakeStream();
  const posted: { url: string; body: string }[] = [];
  const logs: string[] = [];
  const urls: string[] = [];
  const bridge = startAgentBridge({
    host,
    origin: 'http://127.0.0.1:5173',
    openStream: (url) => {
      urls.push(url);
      return stream;
    },
    post: async (url, body) => {
      posted.push({ url, body });
      if (options.postFails === true) throw new Error('the server went away');
    },
    onLog: (message) => logs.push(message),
  });
  return { host, stream, posted, logs, bridge, urls };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the bridge in the page', () => {
  it('opens the event stream on the endpoint', () => {
    const { urls } = bridged();
    expect(urls).toEqual([`http://127.0.0.1:5173${EVENTS_PATH}`]);
    expect(defaultAgentOrigin()).toContain('localhost');
  });

  it('runs a call against the live application and posts the answer', async () => {
    const { stream, posted, host } = bridged();
    stream.message?.({ data: JSON.stringify({ id: 4, name: 'overview', args: {} }) });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`http://127.0.0.1:5173${RESULT_PATH}`);
    const reply = JSON.parse(posted[0]?.body ?? '{}') as {
      id: number;
      ok: boolean;
      value: Record<string, unknown>;
    };
    expect(reply).toMatchObject({ id: 4, ok: true });
    expect(reply.value['tables']).toBe(1);
    expect(host.core.history.commits.size).toBe(2);
  });

  it('posts a refusal as an answer, because an exception in a page reaches nobody', async () => {
    const { stream, posted, logs } = bridged();
    stream.message?.({
      data: JSON.stringify({ id: 5, name: 'entity', args: { tableId: 'table:9' } }),
    });
    await settle();
    expect(JSON.parse(posted[0]?.body ?? '{}')).toMatchObject({
      id: 5,
      ok: false,
      error: expect.stringContaining('table:9') as unknown as string,
    });
    expect(logs.some((line) => line.includes('entity refused'))).toBe(true);
  });

  it('ignores a message that is not a call', async () => {
    const { stream, posted, logs } = bridged();
    stream.message?.({ data: 'hello?' });
    await settle();
    expect(posted).toEqual([]);
    expect(logs).toContain('ignored a message that was not a call');
  });

  it('says so when it cannot answer, rather than failing silently', async () => {
    const { stream, logs } = bridged({ postFails: true });
    stream.message?.({ data: JSON.stringify({ id: 6, name: 'overview', args: {} }) });
    await settle();
    await settle();
    expect(logs.some((line) => line.includes('could not answer call 6'))).toBe(true);
  });

  it('treats a broken stream as news, until it is closed on purpose', () => {
    const { stream, logs, bridge } = bridged();
    stream.error?.();
    expect(logs).toContain('agent server unreachable; will keep trying');
    bridge.close();
    expect(stream.closed).toBe(true);
    // Closed on purpose: the failing stream that follows is not worth saying.
    const before = logs.length;
    stream.error?.();
    expect(logs).toHaveLength(before);
  });

  it('runs without being given anywhere to log', async () => {
    const host = new FakeHost();
    const stream = new FakeStream();
    const post = vi.fn(async () => {});
    startAgentBridge({ host, openStream: () => stream, post });
    stream.message?.({ data: 'not a call' });
    stream.error?.();
    stream.message?.({ data: JSON.stringify({ id: 1, name: 'overview', args: {} }) });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
