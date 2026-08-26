import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseRequest } from './jsonrpc.js';
import type { JsonRpcResponse } from './jsonrpc.js';
import type { AgentCall } from './link.js';
import {
  CLAUDE_OPEN_PATH,
  CLAUDE_PAIR_PATH,
  CLAUDE_PATH,
  EVENTS_PATH,
  HEALTH_PATH,
  MCP_PATH,
  RESULT_PATH,
  encodeEvent,
  parseReply,
} from './link.js';
import { AGENT_TOOLS } from './catalogue.js';
import type { ClaudeEnvironment } from './claude.js';
import { inspectClaude, openClaude, pairClaude } from './claude.js';
import { handleMcpRequest } from './mcp.js';
import { CallRouter } from './router.js';

/**
 * The agent interface, as four routes.
 *
 * Mounted on the development server rather than run as a server of its own,
 * because there is nothing for it to do without the application: every answer it
 * gives comes from the live session in the page. One process to start, one
 * origin for the page to talk to, and no port to agree on.
 *
 * Two of the routes face the agent — a Model Context Protocol endpoint and a
 * health check — and two face the page: an event stream carrying calls to it, and
 * somewhere to post the answers. The router in the middle knows about neither.
 */

/** How long an idle event stream waits before a comment keeps it alive. */
export const HEARTBEAT_MS = 20_000;

export interface AgentEndpointOptions {
  readonly router?: CallRouter;
  /** Progress for whoever is watching the dev server's output. */
  readonly onLog?: (message: string) => void;
  /**
   * The machine, for finding and starting Claude. Left out, the routes that
   * would touch it say they are not available — which is what a build of this
   * package with no Node behind it should say.
   */
  readonly machine?: ClaudeEnvironment;
  /**
   * Where an agent should point: this is the URL that gets paired.
   *
   * A function is allowed because a development server's port is not settled
   * until it has bound one, and a client paired with the wrong number fails
   * later, somewhere else.
   */
  readonly mcpUrl?: string | (() => string);
  /** Absolute path of the stdio pipe, for a client that speaks only that. */
  readonly bridgeScript?: string;
  /** What a terminal should open in. */
  readonly projectPath?: string;
  /**
   * How often to write a comment down an idle stream. A stream is a response
   * that never ends, and something in the middle will tidy one away that says
   * nothing for long enough.
   */
  readonly heartbeatMs?: number;
}

export interface AgentEndpoint {
  readonly router: CallRouter;
  /** Connect-style middleware: passes anything that is not ours to `next`. */
  handle(request: IncomingMessage, response: ServerResponse, next: () => void): void;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * The one guard on the routes that can start a program or write a file.
 *
 * A cross-origin form post arrives without a preflight, so a page on another
 * origin could otherwise ask this machine to open Claude. Requiring JSON means
 * the browser asks permission first, and this endpoint grants none.
 */
const fromThisApp = (request: IncomingMessage): boolean =>
  request.method === 'POST' &&
  (request.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json';

export const createAgentEndpoint = (options: AgentEndpointOptions = {}): AgentEndpoint => {
  const router = options.router ?? new CallRouter();
  const log = options.onLog ?? ((): void => {});
  const machine = options.machine;
  const askedUrl = options.mcpUrl ?? `http://localhost:5173${MCP_PATH}`;
  const mcpUrl = (): string => (typeof askedUrl === 'function' ? askedUrl() : askedUrl);
  const bridgeScript = options.bridgeScript ?? '';
  const projectPath = options.projectPath ?? '.';
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  /** The Claude routes, which are the only ones that reach the machine. */
  const claude = async (
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (machine === undefined) {
      json(response, 501, { error: 'This endpoint was created without access to the machine.' });
      return;
    }
    if (path === CLAUDE_PATH) {
      json(response, 200, { ...(await inspectClaude(machine)), mcpUrl: mcpUrl(), bridgeScript });
      return;
    }
    if (!fromThisApp(request)) {
      json(response, 415, { error: 'Send this as a POST of application/json.' });
      return;
    }
    const body = await readBody(request);
    const asked = body.trim() === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
    if (path === CLAUDE_PAIR_PATH) {
      const target = asked['target'];
      const outcomes = await pairClaude(
        machine,
        { url: mcpUrl(), bridgeScript },
        target === 'cli' || target === 'desktop' ? target : 'both',
      );
      for (const outcome of outcomes) log(`pairing ${outcome.target}: ${outcome.detail}`);
      json(response, 200, { outcomes });
      return;
    }
    const prefer = asked['prefer'];
    const outcome = await openClaude(machine, {
      cwd: projectPath,
      ...(prefer === 'cli' || prefer === 'desktop' ? { prefer } : {}),
    });
    log(`opening Claude: ${outcome.detail}`);
    json(response, 200, outcome);
  };

  /**
   * The page attaches by opening the stream, and stays attached until the tab
   * goes away. The first comment flushes the headers, so the page knows it is
   * connected now rather than whenever the first call happens to arrive.
   */
  const attach = (request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(': attached\n\n');
    const beat = setInterval(() => response.write(': beat\n\n'), heartbeatMs);
    const detach = router.attach((call: AgentCall) => response.write(encodeEvent(call)));
    log(`a Panorama session attached (${router.attached} now)`);
    request.on('close', () => {
      clearInterval(beat);
      detach();
      log(`a session detached (${router.attached} left)`);
    });
  };

  /**
   * One MCP message in, one answer out.
   *
   * A notification has no id and gets no reply, which over HTTP is a 202 with
   * nothing in it. Everything else is answered as JSON: this server never pushes
   * anything of its own, so it needs none of the streaming the transport allows.
   */
  const mcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const parsed = parseRequest(await readBody(request));
    if ((parsed as JsonRpcResponse).error !== undefined) {
      json(response, 400, parsed);
      return;
    }
    const answer = await handleMcpRequest(
      parsed as Parameters<typeof handleMcpRequest>[0],
      (name, args) => router.call(name, args),
    );
    if (answer === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    json(response, 200, answer);
  };

  return {
    router,
    handle: (request, response, next): void => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      if (path === HEALTH_PATH) {
        json(response, 200, {
          server: 'panorama-agent',
          attached: router.attached,
          // What an agent has actually asked for, so that "paired" can be told
          // apart from "paired and talking".
          ...router.traffic,
          mcpUrl: mcpUrl(),
          tools: AGENT_TOOLS.map((tool) => tool.name),
        });
        return;
      }
      if (path === CLAUDE_PATH || path === CLAUDE_PAIR_PATH || path === CLAUDE_OPEN_PATH) {
        void claude(path, request, response).catch((error: unknown) => {
          json(response, 500, { error: String(error) });
        });
        return;
      }
      if (path === EVENTS_PATH) {
        attach(request, response);
        return;
      }
      if (path === RESULT_PATH) {
        void readBody(request)
          .then((body) => {
            const reply = parseReply(body);
            if (reply === null) {
              json(response, 400, { error: 'not an answer' });
              return;
            }
            json(response, 200, { delivered: router.deliver(reply) });
          })
          // A page that hung up mid-answer has nowhere to be told about it, and
          // the call it was answering will time out on its own.
          .catch((error: unknown) => log(`an answer did not arrive: ${String(error)}`));
        return;
      }
      if (path === MCP_PATH) {
        if (request.method !== 'POST') {
          // The transport allows a client to open a stream for messages the
          // server starts. This one never does, so there is nothing to stream.
          json(response, 405, { error: 'POST a JSON-RPC message here' });
          return;
        }
        void mcp(request, response).catch((error: unknown) => {
          json(response, 500, { error: String(error) });
        });
        return;
      }
      next();
    },
  };
};
