import { readFileSync } from 'node:fs';
// The plugin is not re-exported from the package: it is the one file that knows it
// is running in a development server, and the page imports the package.
import { readSkill } from '../src/vite-plugin.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_TOOLS,
  INSTRUCTIONS,
  catalogueStamp,
  toolDefinitions,
  DEFAULT_SKILL_PAGE,
  SKILL_PAGES,
  SKILL_TOOL,
  skillPageById,
  skillText,
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
import type { JsonRpcRequest, JsonRpcResponse, SkillTexts } from '@panorama/mcp';

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
    // The catalogue is source code beside a development server, so the list a
    // client is holding can go out of date under it — see the stamp tests below.
    expect(result['capabilities']?.['tools']).toEqual({ listChanged: true });
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
    const answer = await handleMcpRequest(request('sampling/createMessage'), call);
    expect(answer?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(answer?.error?.message).toContain('sampling/createMessage');
  });
});

/**
 * A client fetches the tool list once, on connecting, and then shows what it
 * fetched. So an agent read a fourteen-tool catalogue for days while the server
 * grew two more — and for part of that time no server was running at all, so the
 * list it was showing was a memory of one. Nothing on either side was wrong and
 * nothing on either side could say so.
 *
 * What is asserted here is the ability to *notice*: the handshake carries a stamp
 * of the catalogue it is answering with, and says the number out loud.
 */
describe('saying which catalogue this is', () => {
  const call = vi.fn(async (name: string, args: unknown) => ({ ran: name, with: args }));
  const pages: SkillTexts = { interface: 'the skill', charts: 'the chart skill' };
  const handshake = async (
    skill?: SkillTexts,
  ): Promise<{ version: string; instructions: string; tools: number }> => {
    const answer = await handleMcpRequest(request('initialize'), call, skill);
    const result = answer?.result as Record<string, Record<string, unknown>>;
    const listed = await handleMcpRequest(request('tools/list'), call, skill);
    const tools = (listed?.result as { tools: unknown[] }).tools;
    return {
      version: String(result['serverInfo']?.['version']),
      instructions: String(result['instructions']),
      tools: tools.length,
    };
  };

  it('stamps the handshake with the catalogue it will answer with', async () => {
    const { version, tools } = await handshake(pages);
    expect(tools).toBe(AGENT_TOOLS.length);
    expect(version).toContain(catalogueStamp(toolDefinitions()));
    expect(version).toMatch(/^\d+\.\d+\.\d+\+\d+\.[0-9a-f]{8}$/u);
  });

  it('stamps a server with no skill differently, because it answers differently', async () => {
    const withSkill = await handshake(pages);
    const without = await handshake();
    expect(without.tools).toBe(withSkill.tools - 1);
    expect(without.version).not.toBe(withSkill.version);
  });

  it('says the number and the first name, which is what makes a stale list visible', async () => {
    const { instructions } = await handshake(pages);
    expect(instructions).toContain(`${AGENT_TOOLS.length} tools`);
    expect(instructions).toContain(`the first of which is "${SKILL_TOOL}"`);
    expect(instructions).toMatch(/fetched earlier and kept/u);
  });

  it('changes the stamp when any description changes, not only when a tool is added', () => {
    const one = toolDefinitions();
    const edited = one.map((tool, at) => (at === 0 ? { ...tool, description: 'other' } : tool));
    expect(catalogueStamp(edited)).not.toBe(catalogueStamp(one));
    // The count is the readable half, so it survives a description-only change.
    expect(catalogueStamp(edited).split('.')[0]).toBe(String(one.length));
  });

  it('is stable for the same catalogue, so a comparison means something', () => {
    expect(catalogueStamp(toolDefinitions())).toBe(catalogueStamp(toolDefinitions()));
  });
});

describe('the skill, by whichever door a client knocks on', () => {
  const call = vi.fn(async (name: string) => ({ ran: name }));
  /**
   * The documents themselves, read the way the server reads them.
   *
   * The point of the exercise: there is no copy of this text in the code, so a
   * test that used one would be testing the copy.
   */
  const read = (path: string): string =>
    skillText(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
  const document = read(DEFAULT_SKILL_PAGE.path);
  const charts = read((skillPageById('charts') as { path: string }).path);
  const pages: SkillTexts = { interface: document, charts };
  const skill = async (method: string, params?: unknown): Promise<JsonRpcResponse | null> =>
    handleMcpRequest(request(method, params), call, pages);
  const withoutOne = async (method: string, params?: unknown): Promise<JsonRpcResponse | null> =>
    handleMcpRequest(request(method, params), call);

  it('is offered in the handshake as a prompt and a resource', async () => {
    const answer = await skill('initialize');
    const capabilities = (answer?.result as { capabilities: Record<string, unknown> }).capabilities;
    // Declared, so a client knows to ask. The protocol here has no method called
    // "skills", so the skill goes out as both of the things it does have.
    expect(capabilities['prompts']).toBeDefined();
    expect(capabilities['resources']).toBeDefined();
  });

  it('is a tool, because that is the one thing every client shows', async () => {
    // The gap this closes: it was a prompt and a resource, which is what the
    // protocol has for exactly this — and an agent whose client surfaces only
    // tools could not see it at all. A door nobody can open is not a door.
    const tools = (await skill('tools/list'))?.result as {
      tools: readonly Record<string, unknown>[];
    };
    expect(tools.tools[0]).toMatchObject({ name: SKILL_TOOL });
    const answer = (await skill('tools/call', { name: SKILL_TOOL }))?.result as {
      content: readonly { text: string }[];
    };
    expect(answer.content[0]?.text).toBe(document);
    // Answered by the server, so the page is never asked: it works before
    // anything is open, which is when it is most worth reading.
    expect(call).not.toHaveBeenCalled();
  });

  /**
   * The second page, behind the same door.
   *
   * Nothing filled in is the first page, because that is what a client offering
   * a tool with an optional argument sends and what the handshake tells an agent
   * to start with. A name nothing answers to is refused rather than quietly
   * given the other one — an agent that asked for the chart page, got the
   * interface page and read it would conclude there is no answer.
   */
  it('reads out whichever page was asked for, and refuses one that is not there', async () => {
    const page = async (asked?: string): Promise<{ text: string; failed?: boolean }> => {
      const answer = (
        await skill('tools/call', {
          name: SKILL_TOOL,
          ...(asked === undefined ? {} : { arguments: { page: asked } }),
        })
      )?.result as { content: readonly { text: string }[]; isError?: boolean };
      return {
        text: String(answer.content[0]?.text),
        ...(answer.isError === true ? { failed: true } : {}),
      };
    };
    expect((await page()).text).toBe(document);
    expect((await page('interface')).text).toBe(document);
    expect((await page('charts')).text).toBe(charts);
    const wrong = await page('sankeys');
    expect(wrong.failed).toBe(true);
    expect(wrong.text).toContain('"charts"');
  });

  it('is neither listed nor answered where there is no document', async () => {
    const tools = (await withoutOne('tools/list'))?.result as {
      tools: readonly Record<string, unknown>[];
    };
    expect(tools.tools.some((tool) => tool['name'] === SKILL_TOOL)).toBe(false);
    const refused = (await withoutOne('tools/call', { name: SKILL_TOOL }))?.result as {
      content: readonly { text: string }[];
      isError?: boolean;
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('no skill to offer');
  });

  it('lists itself, so nobody has to be told where it is', async () => {
    const prompts = (await skill('prompts/list'))?.result as {
      prompts: readonly Record<string, unknown>[];
    };
    expect(prompts.prompts.map((prompt) => prompt['name'])).toEqual(
      SKILL_PAGES.map((one) => one.name),
    );
    expect(prompts.prompts[0]).toMatchObject({ name: DEFAULT_SKILL_PAGE.name, arguments: [] });

    const resources = (await skill('resources/list'))?.result as {
      resources: readonly Record<string, unknown>[];
    };
    expect(resources.resources.map((one) => one['uri'])).toEqual(SKILL_PAGES.map((one) => one.uri));
    expect(resources.resources[0]).toMatchObject({ mimeType: 'text/markdown' });
  });

  it('serves the document itself, so an edit to the docs is an edit to the skill', async () => {
    expect(document).toContain('# Driving Panorama');
    // Without the note that explains the file to whoever opens it, which is for a
    // reader of the repository and noise to a reader of the skill.
    expect(document.startsWith('<!--')).toBe(false);
    expect(charts).toContain('# Writing charts in Panorama');
    expect(charts.startsWith('<!--')).toBe(false);
    const asPrompt = (await skill('prompts/get', { name: DEFAULT_SKILL_PAGE.name }))?.result as {
      messages: readonly { content: { text: string } }[];
    };
    expect(asPrompt.messages[0]?.content.text).toBe(document);
  });

  it('offers nothing where there is no document to offer', async () => {
    // A package installed without its docs beside it. Claiming a capability and
    // then having nothing under it is worse than not claiming it.
    const answer = await withoutOne('initialize');
    const capabilities = (answer?.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(capabilities['prompts']).toBeUndefined();
    expect(capabilities['resources']).toBeUndefined();
    expect((await withoutOne('prompts/list'))?.result).toEqual({ prompts: [] });
    expect((await withoutOne('resources/list'))?.result).toEqual({ resources: [] });
    expect(
      (await withoutOne('prompts/get', { name: DEFAULT_SKILL_PAGE.name }))?.error?.message,
    ).toContain('no skill to offer');
    expect(
      (await withoutOne('resources/read', { uri: DEFAULT_SKILL_PAGE.uri }))?.error?.message,
    ).toContain('no skill to offer');
    expect(
      (
        (await withoutOne('tools/call', { name: SKILL_TOOL, arguments: { page: 'charts' } }))
          ?.result as { content: readonly { text: string }[] }
      ).content[0]?.text,
    ).toContain('no skill to offer');
  });

  it('reads the same text either way, for every page', async () => {
    for (const one of SKILL_PAGES) {
      const prompt = (await skill('prompts/get', { name: one.name }))?.result as {
        messages: readonly { content: { text: string } }[];
      };
      const resource = (await skill('resources/read', { uri: one.uri }))?.result as {
        contents: readonly { text: string }[];
      };
      expect(prompt.messages[0]?.content.text).toBe(resource.contents[0]?.text);
    }
    const asPrompt = (await skill('prompts/get', { name: DEFAULT_SKILL_PAGE.name }))?.result as {
      messages: readonly { content: { text: string } }[];
    };
    const asResource = (await skill('resources/read', { uri: DEFAULT_SKILL_PAGE.uri }))?.result as {
      contents: readonly { text: string }[];
    };
    // One text: a skill that could drift from the tools it describes would be
    // worse than none, and two copies of it is how that starts.
    expect(asPrompt.messages[0]?.content.text).toBe(asResource.contents[0]?.text);
  });

  it('is read from the repository, and is nothing where there is nothing to read', () => {
    // What the development server does at startup, and what it does when the
    // document is not beside it.
    expect(readSkill()).toEqual(pages);
    expect(readSkill(new URL('file:///nowhere-in-particular/'))).toBeNull();
  });

  it('covers every tool it could be asked about', async () => {
    // The seam: a tool nobody wrote down is a tool an agent finds by accident,
    // and one written down and removed is a tool it will look for in vain.
    for (const tool of AGENT_TOOLS) {
      expect(document, `${tool.name} is not in the skill`).toContain(`\`${tool.name}\``);
    }
  });

  it('says what it is asked about and nothing else', async () => {
    const wrongPrompt = await skill('prompts/get', { name: 'something-else' });
    expect(wrongPrompt?.error?.message).toContain(DEFAULT_SKILL_PAGE.name);
    const wrongUri = await skill('resources/read', { uri: 'panorama://nothing' });
    expect(wrongUri?.error?.message).toContain(DEFAULT_SKILL_PAGE.uri);
    // And an ask with nothing in it is refused rather than guessed at.
    expect((await skill('prompts/get'))?.error?.code).toBeDefined();
    expect((await skill('resources/read'))?.error?.code).toBeDefined();
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

  it('says there are skills, and where to find each of them', () => {
    // The handshake is what an agent reads first, and a page it never learns
    // exists is a page nobody reads. Both of them, therefore, by name.
    expect(INSTRUCTIONS).toContain('Start by calling the "skill" tool');
    for (const page of SKILL_PAGES) {
      expect(INSTRUCTIONS, `${page.name} is not in the handshake`).toContain(page.name);
      expect(INSTRUCTIONS, `${page.uri} is not in the handshake`).toContain(page.uri);
    }
    // And when to read the longer one, which is the half that saves the calls.
    expect(INSTRUCTIONS).toMatch(/before writing an option and not before/u);
  });

  it('says to read the semantic layer before writing SQL', () => {
    expect(INSTRUCTIONS).toMatch(/semantic model/u);
    expect(INSTRUCTIONS).toMatch(/rather than inventing your own/u);
  });
});
