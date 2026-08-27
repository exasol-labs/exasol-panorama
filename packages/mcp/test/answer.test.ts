import { describe, expect, it } from 'vitest';
import { answerProtocol } from '@panorama/mcp';
import { FakeHost } from './fixtures.js';

/**
 * The same four assertions `http.test.ts` makes about the endpoint, made about
 * the page answering for itself. They are the same because it is the same
 * protocol code: what is being checked here is that nothing on the path from a
 * message to an answer needed a server.
 */
const ask = async (host: FakeHost, message: unknown, skill?: string): Promise<unknown> => {
  const answer = await answerProtocol(host, JSON.stringify(message), skill);
  return answer === null ? null : JSON.parse(answer);
};

describe('answering the protocol in the page', () => {
  it('shakes hands, and says what it is', async () => {
    const answer = (await ask(
      new FakeHost(),
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      '# Driving Panorama',
    )) as { result: { serverInfo: { name: string; version: string } } };
    expect(answer.result.serverInfo.name).toBe('panorama');
    // The stamp is the tool count and a hash of them, so a client can tell a
    // cached list from a current one — and it is computed from the same
    // catalogue here as in the server.
    expect(answer.result.serverInfo.version).toMatch(/^0\.1\.0\+16\./u);
  });

  /**
   * The stamp counts what is *offered*, so a shell that could not read the
   * document stamps a different catalogue than one that could. Worth pinning:
   * it is the number a client compares against to notice a stale tool list.
   */
  it('stamps a catalogue of fifteen when it has no skill to offer', async () => {
    const answer = (await ask(new FakeHost(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })) as { result: { serverInfo: { version: string } } };
    expect(answer.result.serverInfo.version).toMatch(/^0\.1\.0\+15\./u);
  });

  it('lists the tools, with the skill first when there is one', async () => {
    const answer = (await ask(
      new FakeHost(),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      '# Driving Panorama',
    )) as { result: { tools: { name: string }[] } };
    expect(answer.result.tools[0]?.name).toBe('skill');
    expect(answer.result.tools).toHaveLength(16);
  });

  /**
   * A build with no document beside it has no skill, and says so by not offering
   * the tool rather than by offering an empty one.
   */
  it('offers no skill when it was given none', async () => {
    const answer = (await ask(new FakeHost(), { jsonrpc: '2.0', id: 3, method: 'tools/list' })) as {
      result: { tools: { name: string }[] };
    };
    expect(answer.result.tools.map((tool) => tool.name)).not.toContain('skill');
  });

  it('runs a tool against the live host', async () => {
    const host = new FakeHost();
    const answer = (await ask(host, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'overview', arguments: {} },
    })) as { result: { content: { text: string }[] } };
    expect(answer.result.content[0]?.text).toContain('history');
  });

  it('reports a refusal as an answer the agent can act on', async () => {
    const answer = (await ask(new FakeHost(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'entity', arguments: { table: 'entity:nope' } },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toBeTruthy();
  });

  it('says nothing back to a notification', async () => {
    expect(await ask(new FakeHost(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(
      null,
    );
  });

  it('answers a message that is not a request with the error the protocol asks for', async () => {
    const answer = (await ask(new FakeHost(), 'not a request')) as { error: { code: number } };
    expect(answer.error.code).toBeLessThan(0);
  });
});
