import { describe, expect, it, vi } from 'vitest';
import {
  INSTRUCTIONS,
  INVALID_REQUEST,
  LATEST_PROTOCOL,
  LineReader,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  encode,
  encodeEvent,
  handleMcpRequest,
  isResponse,
  parseCall,
  parseReply,
  parseRequest,
} from '@panorama/mcp';
import type { JsonRpcRequest, JsonRpcResponse } from '@panorama/mcp';

/** `id: null` makes a notification — a message the protocol expects no reply to. */
const request = (method: string, params?: unknown, id: number | null = 1): JsonRpcRequest => ({
  jsonrpc: '2.0',
  method,
  ...(id === null ? {} : { id }),
  ...(params === undefined ? {} : { params }),
});

describe('the JSON-RPC frame', () => {
  it('reads a request', () => {
    expect(parseRequest('{"jsonrpc":"2.0","id":7,"method":"ping"}')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'ping',
    });
    // A notification has no id, and by the protocol gets no reply at all.
    expect(parseRequest('{"method":"notifications/initialized"}')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  it('answers a line that cannot be a request with the error to send back', () => {
    const broken = parseRequest('{oops');
    expect(isResponse(broken)).toBe(true);
    expect((broken as JsonRpcResponse).error?.code).toBe(PARSE_ERROR);
    expect(((parseRequest('{"id":1}') as JsonRpcResponse).error ?? {}).code).toBe(INVALID_REQUEST);
    // An id that is neither a string nor a number is no id at all.
    expect(parseRequest('{"method":"ping","id":{}}')).toEqual({ jsonrpc: '2.0', method: 'ping' });
  });

  it('writes one line per message', () => {
    expect(encode({ jsonrpc: '2.0', id: 1, result: {} })).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
    );
  });

  it('reassembles messages split across chunks', () => {
    // A stream arrives in whatever chunks the pipe felt like, which is not the
    // same as whatever the sender wrote.
    const reader = new LineReader();
    expect(reader.push('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(reader.push('":2}\n')).toEqual(['{"b":2}']);
    expect(reader.push('\n  \n')).toEqual([]);
  });
});

describe('the MCP methods', () => {
  const call = vi.fn(async (name: string, args: unknown) => ({ ran: name, with: args }));

  it('answers the handshake with a version the client asked for', async () => {
    const answer = await handleMcpRequest(
      request('initialize', { protocolVersion: '2024-11-05' }),
      call,
    );
    const result = answer?.result as Record<string, Record<string, unknown>>;
    expect(result['protocolVersion']).toBe('2024-11-05');
    expect(result['serverInfo']?.['name']).toBe(SERVER_NAME);
    expect(result['capabilities']?.['tools']).toEqual({ listChanged: false });
    // The one place to say something before the agent starts choosing tools.
    const instructions = String(result['instructions']);
    expect(instructions).toContain('commit graph');
    // Compose with a native connection, and check it is the same database.
    expect(instructions).toMatch(/natively/u);
    expect(instructions).toMatch(/same database/u);
    expect(instructions).toMatch(/semantic/u);
    expect(PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL);
  });

  it('offers its own newest version when the client asks for one it has not heard of', async () => {
    for (const params of [{ protocolVersion: '1999-01-01' }, {}, undefined, 'nonsense']) {
      const answer = await handleMcpRequest(request('initialize', params), call);
      expect((answer?.result as Record<string, unknown>)['protocolVersion']).toBe(LATEST_PROTOCOL);
    }
  });

  it('lists the tools', async () => {
    const answer = await handleMcpRequest(request('tools/list'), call);
    const tools = (answer?.result as { tools: Record<string, unknown>[] }).tools;
    expect(tools.map((tool) => tool['name'])).toContain('history');
  });

  it('calls a tool and returns its answer as text a model can read', async () => {
    const answer = await handleMcpRequest(
      request('tools/call', { name: 'overview', arguments: { a: 1 } }),
      call,
    );
    const content = (answer?.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({ ran: 'overview', with: { a: 1 } });
  });

  it('reports a refusal as a result to read, not as a broken conversation', async () => {
    // A tool that refused is something the agent should act on; a JSON-RPC error
    // is the client's problem, and the agent would never see the reason.
    const failing = vi.fn(() => Promise.reject(new Error('there is no entity table:9')));
    const answer = await handleMcpRequest(request('tools/call', { name: 'entity' }), failing);
    expect(answer?.result).toEqual({
      content: [{ type: 'text', text: 'there is no entity table:9' }],
      isError: true,
    });
    const thrown = vi.fn(() => Promise.reject('a bare string'));
    expect(
      (
        (await handleMcpRequest(request('tools/call', { name: 'entity' }), thrown))?.result as {
          content: { text: string }[];
        }
      ).content[0]?.text,
    ).toBe('a bare string');
    expect(
      (await handleMcpRequest(request('tools/call', { nothing: true }), call))?.result,
    ).toMatchObject({ isError: true });
  });

  it('says nothing at all to a notification', async () => {
    expect(
      await handleMcpRequest(request('notifications/initialized', undefined, null), call),
    ).toBeNull();
  });

  it('answers a ping, and refuses what it does not do', async () => {
    expect((await handleMcpRequest(request('ping'), call))?.result).toEqual({});
    const answer = await handleMcpRequest(request('resources/list'), call);
    expect(answer?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(answer?.error?.message).toContain('resources/list');
  });
});

describe('the link to the page', () => {
  it('frames a call as one event', () => {
    expect(encodeEvent({ id: 3, name: 'entities', args: {} })).toBe(
      'data: {"id":3,"name":"entities","args":{}}\n\n',
    );
  });

  it('reads a call, and refuses anything that is not one', () => {
    expect(parseCall('{"id":1,"name":"overview"}')).toEqual({
      id: 1,
      name: 'overview',
      args: undefined,
    });
    expect(parseCall('nope')).toBeNull();
    expect(parseCall('[]')).toBeNull();
    expect(parseCall('{"id":"1","name":"overview"}')).toBeNull();
    expect(parseCall('{"id":1}')).toBeNull();
  });

  it('reads an answer, including one that failed', () => {
    expect(parseReply('{"id":2,"ok":true,"value":{"tables":1}}')).toEqual({
      id: 2,
      ok: true,
      value: { tables: 1 },
    });
    expect(parseReply('{"id":2,"ok":false,"error":"no such table"}')).toEqual({
      id: 2,
      ok: false,
      error: 'no such table',
    });
    expect(parseReply('{')).toBeNull();
    expect(parseReply('7')).toBeNull();
    expect(parseReply('{"ok":true}')).toBeNull();
  });
});

describe('what an agent is told before it chooses a tool', () => {
  it('says what this server is for, and what to use instead', () => {
    // A canvas session reaches Exasol through a browser, a worker and a cache
    // sized for drawing: right for a hundred thousand rows on screen, wrong for
    // scanning a billion.
    expect(INSTRUCTIONS).toContain('canvas');
    expect(INSTRUCTIONS).toMatch(/Anything heavy/u);
    expect(INSTRUCTIONS).toMatch(/meant to compose/u);
  });

  it('puts the local command-line tool first where the engine is on this machine', () => {
    // The order is about how far the rows have to travel: the CLI runs beside the
    // engine, a native protocol server is a process away, and this server is a
    // browser tab away. Said in the handshake because it decides which tool an
    // agent reaches for before it has called anything.
    expect(INSTRUCTIONS).toMatch(/local `exasol` command-line tool/u);
    expect(INSTRUCTIONS).toMatch(/localhost or 127\.0\.0\.1/u);
    expect(INSTRUCTIONS).toMatch(/Exasol Personal instance/u);
    expect(INSTRUCTIONS).toMatch(/always be the most performant option/u);
    // And in an order, rather than as two claims that each say "use me".
    expect(INSTRUCTIONS.indexOf('First:')).toBeLessThan(INSTRUCTIONS.indexOf('Second:'));
    expect(INSTRUCTIONS.indexOf('Second:')).toBeLessThan(INSTRUCTIONS.indexOf('Third,'));
  });

  it('says to establish that another route is the same database', () => {
    // A machine may be running several, each with its own server and its own CLI
    // configuration, and an answer from the wrong one is worse than no answer.
    expect(INSTRUCTIONS).toMatch(/running several/u);
    expect(INSTRUCTIONS).toMatch(/the CLI or the native server says about itself/u);
    expect(INSTRUCTIONS).toContain('"overview" reports the database this session actually reached');
    expect(INSTRUCTIONS).toMatch(/say which one you used/u);
  });

  it('says to read the semantic layer before writing SQL', () => {
    expect(INSTRUCTIONS).toMatch(/semantic model/u);
    expect(INSTRUCTIONS).toMatch(/rather than inventing your own/u);
  });
});
