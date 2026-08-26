import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_OPEN_PATH,
  CLAUDE_PAIR_PATH,
  CLAUDE_PATH,
  EVENTS_PATH,
  HEALTH_PATH,
  MCP_PATH,
  RESULT_PATH,
  startAgentBridge,
} from '@panorama/mcp';
import type { ClaudeEnvironment } from '../src/claude.js';
import type { EventStreamLike } from '@panorama/mcp';
// Reached by path rather than through the package, because the package's entry
// is what the *page* imports: these two are the Node half, and a browser bundle
// has no business following them.
import type { AgentEndpoint } from '../src/http.js';
import { createAgentEndpoint } from '../src/http.js';
import { panoramaAgent } from '../src/vite-plugin.js';
import { FakeHost, makeTable } from './fixtures.js';

/**
 * The endpoint over a real socket.
 *
 * A real HTTP server, because the awkward parts here are HTTP's: a response that
 * never ends, a request body that arrives in pieces, a client that hangs up. A
 * stubbed request and response would prove the routing and none of that.
 */
let server: Server;
let endpoint: AgentEndpoint;
let logs: string[] = [];
let origin = '';

const listening = (): Promise<void> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

beforeEach(async () => {
  logs = [];
  endpoint = createAgentEndpoint({ onLog: (message) => logs.push(message) });
  server = createServer((request, response) => {
    endpoint.handle(request, response, () => {
      response.writeHead(418);
      response.end('passed through');
    });
  });
  await listening();
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterEach(async () => {
  endpoint.router.abandon('test over');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * An event stream read off the wire.
 *
 * Written out rather than using a built-in, so what is being proved is the frame
 * format the page will actually be sent: `data:` lines, blank line between,
 * comments ignored.
 */
const openEventStream = (url: string): EventStreamLike & { ready: Promise<void> } => {
  const listeners: ((event: { data: string }) => void)[] = [];
  const controller = new AbortController();
  let opened = (): void => {};
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  void fetch(url, { signal: controller.signal }).then(async (response) => {
    opened();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done === true) return;
      pending += decoder.decode(chunk.value as Uint8Array, { stream: true });
      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((part) => part.startsWith('data: '));
        if (line !== undefined) {
          for (const listener of listeners) listener({ data: line.slice('data: '.length) });
        }
      }
    }
  });
  return {
    ready,
    addEventListener: (type: 'message' | 'error', listener: never): void => {
      if (type === 'message')
        listeners.push(listener as unknown as (event: { data: string }) => void);
    },
    close: (): void => controller.abort(),
  };
};

const rpc = async (body: unknown): Promise<{ status: number; body: string }> => {
  const response = await fetch(`${origin}${MCP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
};

/** A machine with Claude on it, and a record of what was asked of it. */
const fakeMachine = (): ClaudeEnvironment & { readonly started: string[] } => {
  const started: string[] = [];
  return {
    started,
    platform: 'darwin',
    home: '/Users/someone',
    find: () => Promise.resolve('/usr/local/bin/claude'),
    exists: () => Promise.resolve(true),
    readFile: () => Promise.resolve('{}'),
    writeFile: () => Promise.resolve(),
    run: () => Promise.resolve({ code: 0, output: 'added' }),
    start: (command) => {
      started.push(command);
      return Promise.resolve();
    },
  };
};

describe('the Claude routes', () => {
  let machine: ReturnType<typeof fakeMachine>;
  let withMachine: AgentEndpoint;
  let machineServer: Server;
  let machineOrigin = '';

  beforeEach(async () => {
    machine = fakeMachine();
    withMachine = createAgentEndpoint({
      machine,
      mcpUrl: () => 'http://localhost:5199/agent/mcp',
      bridgeScript: '/repo/bin/agent.mjs',
      projectPath: '/repo',
    });
    machineServer = createServer((request, response) => {
      withMachine.handle(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    await new Promise<void>((resolve) => machineServer.listen(0, '127.0.0.1', () => resolve()));
    const address = machineServer.address();
    machineOrigin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => machineServer.close(() => resolve()));
  });

  const post = (path: string, body: unknown, contentType = 'application/json'): Promise<Response> =>
    fetch(`${machineOrigin}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: JSON.stringify(body),
    });

  it('says what is on the machine, and where an agent should point', async () => {
    const status = (await (await fetch(`${machineOrigin}${CLAUDE_PATH}`)).json()) as Record<
      string,
      unknown
    >;
    expect(status['mcpUrl']).toBe('http://localhost:5199/agent/mcp');
    expect(status['bridgeScript']).toBe('/repo/bin/agent.mjs');
    expect((status['cli'] as Record<string, unknown>)['found']).toBe(true);
  });

  it('pairs, and reports what it did', async () => {
    const answer = (await (await post(CLAUDE_PAIR_PATH, {})).json()) as {
      outcomes: { target: string; done: boolean }[];
    };
    expect(answer.outcomes.map((outcome) => outcome.target)).toEqual(['cli', 'desktop']);
    expect(answer.outcomes.every((outcome) => outcome.done)).toBe(true);
    expect(logs.some((line) => line.includes('pairing cli'))).toBe(false);
  });

  it('pairs only what it was asked to', async () => {
    const answer = (await (await post(CLAUDE_PAIR_PATH, { target: 'cli' })).json()) as {
      outcomes: { target: string }[];
    };
    expect(answer.outcomes.map((outcome) => outcome.target)).toEqual(['cli']);
  });

  it('opens Claude — the application, on a machine that has one', async () => {
    const answer = (await (await post(CLAUDE_OPEN_PATH, {})).json()) as { opened: string };
    expect(answer.opened).toBe('desktop');
    expect(machine.started).toEqual(['open']);
  });

  it('opens the command line when the request says so', async () => {
    const answer = (await (await post(CLAUDE_OPEN_PATH, { prefer: 'cli' })).json()) as {
      opened: string;
    };
    expect(answer.opened).toBe('cli');
    expect(machine.started).toEqual(['osascript']);
  });

  it('refuses a request that a page on another origin could have sent', async () => {
    // A form post crosses origins without the browser asking first; JSON does
    // not. So the routes that start a program insist on JSON.
    const refused = await post(CLAUDE_OPEN_PATH, {}, 'application/x-www-form-urlencoded');
    expect(refused.status).toBe(415);
    expect(machine.started).toEqual([]);
    const asGet = await fetch(`${machineOrigin}${CLAUDE_PAIR_PATH}`);
    expect(asGet.status).toBe(415);
  });

  it('accepts a request with no body at all', async () => {
    const answer = await fetch(`${machineOrigin}${CLAUDE_OPEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(answer.status).toBe(200);
  });

  it('answers with a failure when the body is not JSON', async () => {
    const broken = await fetch(`${machineOrigin}${CLAUDE_PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oh dear',
    });
    expect(broken.status).toBe(500);
  });

  it('says the machine is out of reach where it was given none', async () => {
    // Which is what a page served by anything but the development server gets.
    const answer = await fetch(`${origin}${CLAUDE_PATH}`);
    expect(answer.status).toBe(501);
    expect(((await answer.json()) as Record<string, string>)['error']).toContain('without access');
  });
});

describe('the agent endpoint', () => {
  it('reports its health, and what it can do', async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['server']).toBe('panorama-agent');
    expect(body['attached']).toBe(0);
    expect(body['tools']).toContain('history');
  });

  it('leaves anything that is not its own to the rest of the server', async () => {
    const response = await fetch(`${origin}/index.html`);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe('passed through');
  });

  it('speaks the protocol over HTTP', async () => {
    const answer = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'panorama' } },
    });
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(JSON.parse(tools.body).result.tools.length).toBeGreaterThan(10);
  });

  it('accepts a notification without answering it', async () => {
    const answer = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(answer.status).toBe(202);
    expect(answer.body).toBe('');
  });

  it('rejects a body that is not a message', async () => {
    const answer = await rpc('{oh dear');
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error.message).toBe('Not JSON');
  });

  it('offers nothing to stream, because it never starts a conversation', async () => {
    const response = await fetch(`${origin}${MCP_PATH}`);
    expect(response.status).toBe(405);
    expect(((await response.json()) as Record<string, string>)['error']).toContain('POST');
  });

  it('answers a tool call from the attached page, end to end', async () => {
    const host = new FakeHost();
    host.add(makeTable(host.ids));
    const stream = openEventStream(`${origin}${EVENTS_PATH}`);
    const bridge = startAgentBridge({
      host,
      origin,
      openStream: () => stream,
      post: async (url, body) => {
        await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      },
    });
    // The stream has to be open before a call can be routed to it.
    await stream.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(endpoint.router.attached).toBe(1);
    expect(logs.some((line) => line.includes('attached'))).toBe(true);

    const answer = await rpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'entities' },
    });
    const content = JSON.parse(answer.body).result.content[0].text as string;
    expect(JSON.parse(content)[0].name).toBe('SALES.ORDERS');

    // And an edit, which is the other half of the point.
    const table = [...host.core.world.entities.keys()][0] as string;
    const moved = await rpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'dispatch',
        arguments: {
          command: { type: 'MoveEntities', ids: [table], position: { x: 7, y: 8, z: 0 } },
        },
      },
    });
    expect(JSON.parse(moved.body).result.isError).toBeUndefined();
    expect(host.core.world.entities.get(table as never)?.transform.x).toBe(7);

    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(endpoint.router.attached).toBe(0);
    expect(logs.some((line) => line.includes('detached'))).toBe(true);
  });

  it('keeps an idle stream alive, because a silent response gets tidied away', async () => {
    const beating = createAgentEndpoint({ heartbeatMs: 5 });
    const server = createServer((request, response) => {
      beating.handle(request, response, () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const at = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    const response = await fetch(`${at}${EVENTS_PATH}`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes(': beat')) {
      const chunk = await reader.read();
      seen += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
    }
    expect(seen).toContain(': attached');
    expect(seen).toContain(': beat');
    await reader.cancel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('says there is nobody to ask when no page is attached', async () => {
    const answer = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'overview' },
    });
    const result = JSON.parse(answer.body).result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No Panorama session is attached');
  });

  it('refuses an answer that is not one, and drops one nobody is waiting for', async () => {
    const bad = await fetch(`${origin}${RESULT_PATH}`, { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
    const orphan = await fetch(`${origin}${RESULT_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ id: 99, ok: true, value: 1 }),
    });
    expect(((await orphan.json()) as Record<string, boolean>)['delivered']).toBe(false);
  });
});

/** A request whose body never arrives, because the client hung up. */
const abandonedRequest = (path: string): never =>
  ({
    url: path,
    method: 'POST',
    on: (): void => {},
    [Symbol.asyncIterator]: (): AsyncIterator<Buffer> => ({
      next: (): Promise<IteratorResult<Buffer>> => Promise.reject(new Error('socket hung up')),
    }),
  }) as never;

/** A POST of one JSON body, as the middleware sees it. */
const jsonRequest = (path: string, body: unknown): never =>
  ({
    url: path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on: (): void => {},
    [Symbol.asyncIterator]: async function* (): AsyncIterator<Buffer> {
      yield Buffer.from(JSON.stringify(body));
    },
  }) as never;

const recordingResponse = (): { written: unknown[]; response: never } => {
  const written: unknown[] = [];
  return {
    written,
    response: {
      writeHead: (status: number): void => {
        written.push(status);
      },
      end: (body?: string): void => {
        written.push(body);
      },
      write: (): boolean => true,
    } as never,
  };
};

describe('the dev-server plugin', () => {
  it('mounts the endpoint as middleware, and the middleware is the endpoint', () => {
    const used: ((request: never, response: never, next: () => void) => void)[] = [];
    const plugin = panoramaAgent();
    expect(plugin.name).toBe('panorama-agent');
    // Development only: an interface that can edit the document has no business
    // in a build.
    expect(plugin.apply).toBe('serve');
    plugin.configureServer({ middlewares: { use: (handler) => used.push(handler as never) } });
    expect(used).toHaveLength(1);
    const { written, response } = recordingResponse();
    used[0]?.({ url: HEALTH_PATH, method: 'GET' } as never, response, () => {
      throw new Error('should have been handled');
    });
    expect(written[0]).toBe(200);
  });

  it('points a paired client at the port that was actually bound', async () => {
    // `configureServer` runs before the server listens, and `--port` on the
    // command line beats anything the configuration said.
    type Middleware = (request: never, response: never, next: () => void) => void;
    const answers: Middleware[] = [];
    let bound: { port: number } | string | null = null;
    panoramaAgent({ port: 4_000 }).configureServer({
      middlewares: { use: (handler: Middleware): void => void answers.push(handler) },
      httpServer: { address: (): { port: number } | string | null => bound },
    });
    const paired = async (): Promise<string> => {
      const { written, response } = recordingResponse();
      answers[0]?.({ url: CLAUDE_PATH, method: 'GET' } as never, response, () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      return JSON.stringify(written);
    };
    // Nothing bound yet: the configured port.
    expect(await paired()).toContain('4000');
    bound = { port: 5_199 };
    expect(await paired()).toContain('5199');
    // A socket path rather than a port falls back to what was configured.
    bound = '/tmp/somewhere.sock';
    expect(await paired()).toContain('4000');
  });

  it('serves the skill it found beside it', async () => {
    // The document is part of the repository, so the plugin reads it at startup
    // and hands it to the endpoint; there is no copy of it in the code.
    const used: ((request: never, response: never, next: () => void) => void)[] = [];
    panoramaAgent().configureServer({
      middlewares: {
        use: (handler: (request: never, response: never, next: () => void) => void): void =>
          void used.push(handler),
      },
    });
    const { written, response } = recordingResponse();
    const request = jsonRequest(MCP_PATH, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'panorama://skill' },
    });
    used[0]?.(request as never, response, () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(written)).toContain('Driving Panorama');
  });

  it('answers with a failure when the request itself falls apart', async () => {
    // The body arrives in pieces, and a client can stop halfway through sending
    // it. What must not happen is a rejection nobody is holding.
    const { written, response } = recordingResponse();
    endpoint.handle(abandonedRequest(MCP_PATH), response, () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(written[0]).toBe(500);
    expect(String(written[1])).toContain('socket hung up');
  });

  it('refuses an answer whose body never arrives', async () => {
    const { written, response } = recordingResponse();
    endpoint.handle(abandonedRequest(RESULT_PATH), response, () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing was written, because the failure is the request's own doing and
    // there is nothing left to write to — but it is said out loud, and it is not
    // left as a rejection nobody is holding.
    expect(written).toEqual([]);
    expect(logs.some((line) => line.includes('an answer did not arrive'))).toBe(true);
  });
});
