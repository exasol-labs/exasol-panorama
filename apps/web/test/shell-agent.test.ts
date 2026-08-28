import { describe, expect, it } from 'vitest';
import type { AgentHost } from '@panorama/mcp';
import {
  AGENT_REQUEST_EVENT,
  shellBridge,
  reportTiming,
  shellDeploymentCredentials,
  shellDeployments,
  shellStagedVersion,
  shellSetting,
  shellSkill,
  startShellAgent,
} from '../src/panorama/shell-agent.js';

/**
 * The transport, not the protocol. What answers a message is `answerProtocol`,
 * proved against a host in `packages/mcp/test/answer.test.ts`; what is left here
 * is the wire to the shell — that a request arriving as an event is answered by an
 * invoke carrying the same id, and that the things which can go wrong on that wire
 * do not take the window down with them.
 */

interface Recorded {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
}

const fakeBridge = (
  options: { rejectReply?: boolean; rejectDetach?: boolean } = {},
): {
  bridge: Parameters<typeof startShellAgent>[0]['bridge'];
  send: (payload: unknown) => void;
  calls: Recorded[];
  unlistened: () => number;
} => {
  const calls: Recorded[] = [];
  let handler: ((message: { payload: unknown }) => void) | null = null;
  let unlistenCount = 0;
  return {
    calls,
    unlistened: () => unlistenCount,
    send: (payload) => handler?.({ payload }),
    bridge: {
      listen: (event, given) => {
        expect(event).toBe(AGENT_REQUEST_EVENT);
        handler = given;
        return Promise.resolve(() => {
          unlistenCount += 1;
        });
      },
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'agent_reply' && options.rejectReply === true) {
          throw new Error('the shell went away');
        }
        if (command === 'agent_detach' && options.rejectDetach === true) {
          throw new Error('already gone');
        }
        return undefined;
      },
    },
  };
};

const host = {} as AgentHost;
const settled = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('the agent endpoint inside the desktop application', () => {
  it('announces itself only once it is listening', async () => {
    const { bridge, calls } = fakeBridge();
    await startShellAgent({ host, bridge, skill: '# skill' });
    expect(calls.map((call) => call.command)).toEqual(['agent_attach']);
  });

  it('answers a request with the same id the shell asked under', async () => {
    const { bridge, send, calls } = fakeBridge();
    await startShellAgent({ host, bridge, skill: '# skill' });
    send({ id: 7, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    await settled();
    const reply = calls.find((call) => call.command === 'agent_reply');
    expect(reply?.args?.['id']).toBe(7);
    expect(String(reply?.args?.['body'])).toContain('"serverInfo"');
  });

  /** A notification has no reply, and the shell has to be told that explicitly. */
  it('replies with nothing to a notification, so the shell stops waiting', async () => {
    const { bridge, send, calls } = fakeBridge();
    await startShellAgent({ host, bridge, skill: '# skill' });
    send({ id: 8, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    await settled();
    expect(calls.find((call) => call.command === 'agent_reply')?.args?.['body']).toBe(null);
  });

  it('drops a request that is not one, with a note', async () => {
    const notes: string[] = [];
    const { bridge, send, calls } = fakeBridge();
    await startShellAgent({ host, bridge, skill: '# skill', onLog: (m) => notes.push(m) });
    send({ id: 'nine', body: 5 });
    await settled();
    expect(calls.some((call) => call.command === 'agent_reply')).toBe(false);
    expect(notes.join(' ')).toContain('not one');
  });

  it('says so on the console when the shell cannot be answered', async () => {
    const notes: string[] = [];
    const { bridge, send } = fakeBridge({ rejectReply: true });
    await startShellAgent({ host, bridge, skill: '# skill', onLog: (m) => notes.push(m) });
    send({ id: 9, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    await settled();
    expect(notes.join(' ')).toContain('could not answer request 9');
  });

  it('detaches on close, and survives a shell that has already gone', async () => {
    const { bridge, calls, unlistened } = fakeBridge({ rejectDetach: true });
    const agent = await startShellAgent({ host, bridge, skill: '# skill' });
    await agent.close();
    expect(unlistened()).toBe(1);
    expect(calls.map((call) => call.command)).toContain('agent_detach');
  });
});

describe('finding the shell', () => {
  it('is nothing in a browser', () => {
    expect(shellBridge({})).toBe(null);
  });

  it('is nothing in a shell that installed no global API', () => {
    expect(shellBridge({ __TAURI__: {} })).toBe(null);
  });

  it('is the shell API where the shell installed one', async () => {
    const listened: string[] = [];
    const bridge = shellBridge({
      __TAURI__: {
        event: {
          listen: async (event) => {
            listened.push(event);
            return () => undefined;
          },
        },
        core: { invoke: async () => 'done' },
      },
    });
    expect(bridge).not.toBe(null);
    const unlisten = await bridge?.listen('x', () => {});
    expect(listened).toEqual(['x']);
    expect(typeof unlisten).toBe('function');
    expect(await bridge?.invoke('agent_attach')).toBe('done');
  });

  it('takes what listen gave back even when it was not a function', async () => {
    const bridge = shellBridge({
      __TAURI__: {
        event: { listen: async () => 'nope' },
        core: { invoke: async () => undefined },
      },
    });
    const unlisten = await bridge?.listen('x', () => {});
    expect(() => unlisten?.()).not.toThrow();
  });
});

describe('the skill in the bundle', () => {
  /**
   * The document is the source and the shell has no file to read, so it is
   * compiled in — and the note at the top of the file, which is addressed to
   * whoever opens it in the repository, is not part of what an agent is told.
   */
  it('is the document, without the note to the reader of the repository', () => {
    const skill = shellSkill();
    expect(skill.startsWith('# Driving Panorama')).toBe(true);
    expect(skill).not.toContain('<!--');
    expect(skill).toContain('## The tools');
  });
});

describe('what the settings panel is told', () => {
  const answering = (
    answers: Record<string, unknown>,
    asked: string[] = [],
  ): Parameters<typeof shellSetting>[1] => ({
    listen: () => () => undefined,
    invoke: async (command) => {
      asked.push(command);
      return answers[command];
    },
  });

  it('is nothing in a browser, so the panel asks the network as before', async () => {
    expect(await shellSetting('/agent/health', null)).toBeUndefined();
  });

  it('is nothing for a route the shell does not answer', async () => {
    const asked: string[] = [];
    expect(await shellSetting('/agent/nonsense', answering({}, asked))).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('is the shell address and the traffic, with the tools the page knows', async () => {
    const health = await shellSetting<{ mcpUrl: string; attached: number; tools: string[] }>(
      '/agent/health',
      answering({
        agent_status: {
          attached: 1,
          calls: 3,
          lastCallAt: 1_700_000_000,
          mcpUrl: 'http://127.0.0.1:7355/agent/mcp',
          port: 7355,
        },
      }),
    );
    expect(health?.mcpUrl).toBe('http://127.0.0.1:7355/agent/mcp');
    expect(health?.attached).toBe(1);
    // Sixteen, and the skill first: the page is what has the catalogue now.
    expect(health?.tools).toHaveLength(16);
    expect(health?.tools[0]).toBe('skill');
  });

  it('is what Claude there is on this machine', async () => {
    const asked: string[] = [];
    const status = await shellSetting<{ cli: { found: boolean } }>(
      '/agent/claude',
      answering(
        { claude_status: { platform: 'macos', cli: { found: true, paired: false } } },
        asked,
      ),
    );
    expect(status?.cli.found).toBe(true);
    expect(asked).toEqual(['claude_status']);
  });

  /**
   * Pairing answers with a list of outcomes, one per client, and the panel reads
   * them under `outcomes` — the shape the development server's route has always
   * returned.
   */
  it('is a list of outcomes when pairing', async () => {
    const paired = await shellSetting<{ outcomes: { detail: string }[] }>(
      '/agent/claude/pair',
      answering({
        claude_pair: [
          { target: 'cli', done: true, detail: 'Added "panorama" to Claude Code.' },
          { target: 'desktop', done: true, detail: 'Wrote "panorama" into the config.' },
        ],
      }),
    );
    expect(paired?.outcomes.map((outcome) => outcome.detail)).toEqual([
      'Added "panorama" to Claude Code.',
      'Wrote "panorama" into the config.',
    ]);
  });

  it('is one outcome when opening Claude', async () => {
    const opened = await shellSetting<{ detail: string }>(
      '/agent/claude/open',
      answering({ claude_open: { opened: 'desktop', detail: 'Opened the Claude application.' } }),
    );
    expect(opened?.detail).toBe('Opened the Claude application.');
  });

  it('is nothing when the shell answered with nothing', async () => {
    expect(await shellSetting('/agent/health', answering({ agent_status: null }))).toBeUndefined();
  });
});

describe('the databases already on this machine', () => {
  const bridgeAnswering = (
    answers: Record<string, unknown>,
  ): Parameters<typeof shellDeployments>[0] => ({
    listen: () => () => undefined,
    invoke: async (command, args) => {
      const answer = answers[command];
      void args;
      return typeof answer === 'function' ? (answer as (given: unknown) => unknown)(args) : answer;
    },
  });

  it('is nothing in a browser, which cannot run a command', async () => {
    expect(await shellDeployments(null)).toBe(null);
  });

  it('says the tool is missing apart from saying there are none', async () => {
    const answer = await shellDeployments(
      bridgeAnswering({ exasol_deployments: { installed: false, deployments: [] } }),
    );
    expect(answer).toEqual({ installed: false, deployments: [] });
  });

  /**
   * Two questions, not one: what they are called, and how they are. The second
   * costs seconds, so the caller decides which it is asking.
   */
  it('asks for as much as it was told to, and no more', async () => {
    const asked: unknown[] = [];
    const bridge = {
      listen: () => () => undefined,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        asked.push(args);
        return { installed: true, deployments: [] };
      },
    };
    await shellDeployments(bridge);
    await shellDeployments(bridge, 'probed');
    await shellDeployments(bridge, 'described');
    expect(asked).toEqual([{ detail: 'names' }, { detail: 'probed' }, { detail: 'described' }]);
  });

  it('lists what the shell found', async () => {
    const answer = await shellDeployments(
      bridgeAnswering({
        exasol_deployments: {
          installed: true,
          deployments: [
            { name: 'default', status: 'running', url: 'wss://127.0.0.1:8563', username: 'sys' },
            { name: 'fuzz', status: 'stopped' },
          ],
        },
      }),
    );
    expect(answer?.installed).toBe(true);
    expect(answer?.deployments.map((deployment) => deployment.name)).toEqual(['default', 'fuzz']);
  });

  it('tolerates a shell that answered without a list', async () => {
    const answer = await shellDeployments(
      bridgeAnswering({ exasol_deployments: { installed: true } }),
    );
    expect(answer).toEqual({ installed: true, deployments: [] });
    expect(await shellDeployments(bridgeAnswering({ exasol_deployments: null }))).toBe(null);
  });

  /**
   * The credentials call is the one that carries a password, so it is made at the
   * click and its answer goes straight into a connection request.
   */
  it('asks for one deployment’s credentials by name', async () => {
    const asked: unknown[] = [];
    const request = await shellDeploymentCredentials(
      'default',
      bridgeAnswering({
        exasol_deployment_credentials: (args: unknown) => {
          asked.push(args);
          return { url: 'wss://127.0.0.1:8563', username: 'sys', password: 'exa' };
        },
      }),
    );
    expect(asked).toEqual([{ name: 'default' }]);
    expect(request).toEqual({
      url: 'wss://127.0.0.1:8563',
      credentials: { kind: 'password', username: 'sys', password: 'exa' },
    });
  });

  it('refuses an answer that is not a way to connect, rather than half of one', async () => {
    await expect(
      shellDeploymentCredentials('default', bridgeAnswering({ exasol_deployment_credentials: {} })),
    ).rejects.toThrow('did not say how to connect');
    await expect(shellDeploymentCredentials('default', null)).rejects.toThrow('no desktop shell');
  });

  /**
   * What the shell has downloaded and is holding until the window closes. `null`
   * is the ordinary answer — most of the time there is nothing waiting — and it
   * is also what a browser gets, where there is no shell to ask.
   */
  it('reads the version the shell is holding for the next quit', async () => {
    expect(await shellStagedVersion(bridgeAnswering({ update_status: '0.3.0' }))).toBe('0.3.0');
    expect(await shellStagedVersion(bridgeAnswering({ update_status: null }))).toBeNull();
    expect(await shellStagedVersion(bridgeAnswering({ update_status: '' }))).toBeNull();
    expect(await shellStagedVersion(null)).toBeNull();
  });
});

describe('reporting how long things took', () => {
  it('tells the shell, when there is one', () => {
    const said: unknown[] = [];
    reportTiming('interface painted', {
      listen: () => () => undefined,
      invoke: async (command, args) => {
        said.push({ command, args });
        return undefined;
      },
    });
    expect(said).toEqual([{ command: 'report_timing', args: { stage: 'interface painted' } }]);
  });

  it('says nothing in a browser, and survives a shell that refuses', () => {
    expect(() => reportTiming('interface painted', null)).not.toThrow();
    expect(() =>
      reportTiming('interface painted', {
        listen: () => () => undefined,
        invoke: async () => {
          throw new Error('gone');
        },
      }),
    ).not.toThrow();
  });
});
