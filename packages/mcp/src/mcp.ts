import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { METHOD_NOT_FOUND, failure, result } from './jsonrpc.js';
import { toolDefinitions } from './catalogue.js';
import { isRecord } from './schema.js';

/**
 * The Model Context Protocol, server side.
 *
 * Four methods carry the whole of what this server does: a handshake, a list of
 * tools, a call, and a ping. Everything else an MCP server may offer — prompts,
 * resources, sampling — it does not have, and says so by not declaring the
 * capability.
 *
 * The transport is one JSON value per line over stdin and stdout, which is what
 * `claude mcp add` and every other stdio client speaks.
 */

export const SERVER_NAME = 'panorama';
export const SERVER_VERSION = '0.1.0';

/**
 * Protocol versions this server knows how to be.
 *
 * A client names the version it wants; if it is one of these it gets that one
 * back, and otherwise the newest here — which is what the specification asks
 * for, and lets a client decide whether it can live with the answer.
 */
export const PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0] as string;

/**
 * What this server is for, and what it is not for.
 *
 * Sent once, on the handshake, because it is the only place to say something an
 * agent needs *before* it starts choosing tools — and the thing most worth saying
 * is that this is not the only way into the database. A canvas session reaches
 * Exasol through a browser, a worker and a block cache, which is exactly right
 * for putting a hundred thousand rows on screen at sixty frames a second and
 * exactly wrong for scanning a billion. Where a native connection exists, that is
 * the one to compute with.
 *
 * Written as prose rather than as a list of rules because it is read by something
 * that reads prose, and the reasoning is what makes it applicable to the case
 * nobody wrote down.
 */
export const INSTRUCTIONS = [
  'Panorama is a spatial canvas of database tables, queries and charts, and this server is the way in to a live one. "overview" says what is open and which database is behind it; "entities" and "entity" describe the boxes; "rows" reads cells; "history" is the commit graph, which branches rather than being a stack; "dispatch" applies a document command, which is the same way a pointer changes anything. Answers are terse by default — pass verbose where you need ids, widths and composed statements.',

  "Use a direct connection to the database for the database work, and use this server for the canvas. If a Model Context Protocol server that speaks to Exasol natively is available to you, prefer it for anything that is really a query: exploring the catalogue, aggregating, scanning, profiling, counting. It talks to the engine; this server talks to a browser tab that talks to a worker that talks to the engine, and pushes every row through a block cache sized for drawing rather than for computing. The two are meant to compose: work out what is true with the native connection, then put *that* on the canvas here — open the table, derive the query box, set the chart up — so a person can see it, move it, and follow it. What is on screen is this server's to answer for; what is in the database is not.",

  'Before trusting a native server, establish that it is the same database. A machine may be running several, each with its own server, and an answer from the wrong one is worse than no answer. "overview" reports the database this session actually reached — the URL it connected to, and the name, version and session id the server itself gave at login. Compare those against whatever the native connection says about itself before you mix their answers, and say which one you used. Where they disagree, or where you cannot tell, the one attached to this canvas is the one whose answers match what the person is looking at.',

  'Use the semantic layer if there is one. Where the database or its native server exposes a semantic model — described metrics, dimensions, synonyms, curated views, column comments — read it before writing SQL, and use its names and definitions rather than inventing your own from column names. A column called AMT is not a metric, and a metric called "net revenue" usually has a definition somebody has already argued about. Panorama\'s own "catalogue" carries what the Exasol catalogue holds, including comments, and a table\'s columns come back with their types; that is the least of it, and a semantic layer is the rest.',
].join('\n\n');

/** What a tool call has to do: reach the application and come back with JSON. */
export type CallTool = (name: string, args: unknown) => Promise<unknown>;

const requestedVersion = (params: unknown): string => {
  const asked = isRecord(params) ? params['protocolVersion'] : undefined;
  return typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
};

/**
 * A tool's answer.
 *
 * Text, because that is the content type every client renders, and JSON inside
 * it because the caller is a language model reading state: prose about a commit
 * graph would be a summary, and a summary is not something to act on. Failures
 * come back as content with `isError`, not as a JSON-RPC error — a tool that
 * refused is a result the agent should read and try again from, whereas a
 * protocol error is the client's problem.
 */
export const toolContent = (value: unknown): Record<string, unknown> => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

export const toolFailure = (message: string): Record<string, unknown> => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * Answers one message.
 *
 * `null` for a notification — a message with no id, which by the protocol gets
 * no reply at all, not even an empty one.
 */
export const handleMcpRequest = async (
  request: JsonRpcRequest,
  call: CallTool,
): Promise<JsonRpcResponse | null> => {
  const id = request.id;
  if (id === undefined) {
    // `notifications/initialized` is the only one that matters, and what it
    // means is "carry on", which is what ignoring it does.
    return null;
  }
  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: requestedVersion(request.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: toolDefinitions() });
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : {};
      const name = params['name'];
      if (typeof name !== 'string') {
        return result(id, toolFailure('A tool call needs the name of a tool.'));
      }
      try {
        return result(id, toolContent(await call(name, params['arguments'])));
      } catch (error) {
        return result(id, toolFailure(error instanceof Error ? error.message : String(error)));
      }
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `${request.method} is not something this server does`);
  }
};
