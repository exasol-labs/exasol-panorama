import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { INVALID_PARAMS, METHOD_NOT_FOUND, failure, result } from './jsonrpc.js';
import { catalogueStamp, toolDefinitions } from './catalogue.js';
import {
  SKILL_NAME,
  SKILL_PATH,
  SKILL_SUMMARY,
  SKILL_TITLE,
  SKILL_TOOL,
  SKILL_URI,
} from './skill.js';
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
 * exactly wrong for scanning a billion. Where a shorter route to the engine
 * exists, that is the one to compute with — and the routes are not equal, so they
 * are given in order. A local `exasol` command runs on the same machine as the
 * engine and is the shortest route there is; a native protocol server is a
 * process away; this server is a browser tab away.
 *
 * Written as prose rather than as a list of rules because it is read by something
 * that reads prose, and the reasoning is what makes it applicable to the case
 * nobody wrote down.
 */
export const INSTRUCTIONS = [
  `Start by calling the "${SKILL_TOOL}" tool. It is one page covering the whole interface — the boxes, the command and history model, charts and their named data sets, what a picked mark means, cross-filtering, and the feedback that says whether a picture is right — and reading it first will save you several calls. The same text is offered as the prompt "${SKILL_NAME}" and the resource "${SKILL_URI}" for a client that shows those, and it is a document in this repository at ${SKILL_PATH}.`,

  'Panorama is a spatial canvas of database tables, queries and charts, and this server is the way in to a live one. "overview" says what is open and which database is behind it; "entities" and "entity" describe the boxes; "rows" reads cells; "history" is the commit graph, which branches rather than being a stack; "dispatch" applies a document command, which is the same way a pointer changes anything. Answers are terse by default — pass verbose where you need ids, widths and composed statements.',

  'Use the shortest route to the database for the database work, and use this server for the canvas. Anything heavy — scanning, aggregating over a whole relation, counting, profiling, describing a schema, loading or unloading data, DDL — belongs on a route that reaches the engine, in this order of preference. First: if the database is on this machine, use the local `exasol` command-line tool. "overview" reports the URL this session connected to; where that names localhost or 127.0.0.1 it is an Exasol Personal instance running beside you, and an `exasol` CLI on your PATH talks to it with no browser, no socket to a page and no cache in the way. Where it is available it will always be the most performant option, so try it first. Second: a Model Context Protocol server that speaks to Exasol natively — a process away rather than a machine away, and where a semantic layer would be. Third, and only for what the first two cannot answer: this server, which reaches the engine through a browser tab, a worker and a block cache sized for drawing rather than for computing.',

  "The routes are meant to compose. Work out what is true on the shortest one available, then put *that* on the canvas here — open the table, derive the query box, set the chart up — so a person can see it, move it and follow it. A statement that scans a billion rows should be run where the rows are and summarised into a box a person can read; a statement whose result somebody is meant to look at belongs in a box. What is on screen is this server's to answer for; what is in the database is not.",

  'Before trusting another route, establish that it is the same database. A machine may be running several instances, each with its own server and its own CLI configuration, and an answer from the wrong one is worse than no answer. "overview" reports the database this session actually reached — the URL it connected to, and the name, version and session id the server itself gave at login. Compare those against whatever the CLI or the native server says about itself, before you mix their answers, and say which one you used. Where they disagree, or where you cannot tell, the one attached to this canvas is the one whose answers match what the person is looking at.',

  'Use the semantic layer if there is one. Where the database or its native server exposes a semantic model — described metrics, dimensions, synonyms, curated views, column comments — read it before writing SQL, and use its names and definitions rather than inventing your own from column names. A column called AMT is not a metric, and a metric called "net revenue" usually has a definition somebody has already argued about. Panorama\'s own "catalogue" carries what the Exasol catalogue holds, including comments, and a table\'s columns come back with their types; that is the least of it, and a semantic layer is the rest.',
].join('\n\n');

/**
 * The tools this server will actually answer.
 *
 * A tool the server cannot answer is not offered: a build of this package with no
 * document beside it has no skill to read out. Computed in one place because the
 * handshake now reports a fingerprint of it, and a fingerprint of a different list
 * from the one served would be worse than none.
 */
const offeredTools = (skill: string | undefined): readonly Record<string, unknown>[] =>
  toolDefinitions().filter((tool) => skill !== undefined || tool['name'] !== SKILL_TOOL);

/**
 * What a client is looking at, said out loud.
 *
 * An agent cannot tell a server that offers fourteen tools from a client showing
 * fourteen of the sixteen a server offers, and the difference is the whole of a
 * failure that took three rounds to find. So the handshake says the number and
 * the first name, which turns "the skill is not exposed" into one comparison.
 */
const catalogueNote = (offered: readonly Record<string, unknown>[]): string =>
  `This server is answering with ${offered.length} tools, the first of which is "${String(offered[0]?.['name'] ?? '')}", and its catalogue is stamped ${catalogueStamp(offered)} — the same stamp is in serverInfo.version. If your client lists a different number, it is showing a tool list it fetched earlier and kept; ask it to reconnect to this server, and if it will not, restart it. Nothing you call can be newer than the list you are reading from.`;

/** What is said when the document could not be read; see `SKILL_PATH`. */
const NO_SKILL = 'This server has no skill to offer: its document could not be read.';

/** The skill as a prompt: something a client can offer to invoke. */
const skillPrompt = (): Record<string, unknown> => ({
  name: SKILL_NAME,
  title: SKILL_TITLE,
  description: SKILL_SUMMARY,
  // No arguments: it is one text about the whole interface, and a skill that
  // needed filling in first would be a form.
  arguments: [],
});

/** The same, as a resource: something a client can offer to read. */
const skillResource = (): Record<string, unknown> => ({
  uri: SKILL_URI,
  name: SKILL_NAME,
  title: SKILL_TITLE,
  description: SKILL_SUMMARY,
  mimeType: 'text/markdown',
});

const promptName = (params: unknown): string => {
  const asked = isRecord(params) ? params['name'] : undefined;
  return typeof asked === 'string' ? asked : '';
};

const resourceUri = (params: unknown): string => {
  const asked = isRecord(params) ? params['uri'] : undefined;
  return typeof asked === 'string' ? asked : '';
};

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
  /**
   * The skill, as read from its document.
   *
   * Passed in rather than reached for: the text is a file on somebody's computer
   * and this module is bundled for a browser as well. Absent means there is none
   * to offer, and then the handshake does not claim prompts or resources —
   * declaring a capability with nothing under it is worse than not declaring it.
   */
  skill?: string,
): Promise<JsonRpcResponse | null> => {
  const id = request.id;
  if (id === undefined) {
    // `notifications/initialized` is the only one that matters, and what it
    // means is "carry on", which is what ignoring it does.
    return null;
  }
  switch (request.method) {
    case 'initialize': {
      const offered = offeredTools(skill);
      return result(id, {
        protocolVersion: requestedVersion(request.params),
        /**
         * What this server offers, and how the skill is offered.
         *
         * The protocol versions here have prompts and resources and no method
         * called "skills", so the skill is served as both: a client that lists
         * prompts finds something to invoke, and one that browses resources finds
         * something to read. Same text either way — a skill that could drift from
         * the tools it describes would be worse than none.
         */
        capabilities: {
          /**
           * The tool list can change under a client — this is a development
           * server, and the catalogue is source code beside it. Declared so a
           * client knows to expect `notifications/tools/list_changed`, which the
           * stdio pipe sends when it notices the stamp move.
           */
          tools: { listChanged: true },
          ...(skill === undefined
            ? {}
            : {
                prompts: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
              }),
        },
        serverInfo: {
          name: SERVER_NAME,
          version: `${SERVER_VERSION}+${catalogueStamp(offered)}`,
        },
        instructions: `${INSTRUCTIONS}\n\n${catalogueNote(offered)}`,
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: offeredTools(skill) });
    // The skill, by whichever door a client knocks on. Listed so it is found
    // without being told where to look, and answered from one text.
    case 'prompts/list':
      return result(id, { prompts: skill === undefined ? [] : [skillPrompt()] });
    case 'prompts/get': {
      if (skill === undefined) return failure(id, INVALID_PARAMS, NO_SKILL);
      const asked = promptName(request.params);
      return asked === SKILL_NAME
        ? result(id, {
            description: SKILL_SUMMARY,
            messages: [{ role: 'user', content: { type: 'text', text: skill } }],
          })
        : failure(
            id,
            INVALID_PARAMS,
            `There is no prompt called ${asked}; there is ${SKILL_NAME}.`,
          );
    }
    case 'resources/list':
      return result(id, { resources: skill === undefined ? [] : [skillResource()] });
    case 'resources/read': {
      if (skill === undefined) return failure(id, INVALID_PARAMS, NO_SKILL);
      const uri = resourceUri(request.params);
      return uri === SKILL_URI
        ? result(id, { contents: [{ uri: SKILL_URI, mimeType: 'text/markdown', text: skill }] })
        : failure(id, INVALID_PARAMS, `There is no resource at ${uri}; there is ${SKILL_URI}.`);
    }
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : {};
      const name = params['name'];
      if (typeof name !== 'string') {
        return result(id, toolFailure('A tool call needs the name of a tool.'));
      }
      // Answered here rather than forwarded: the skill is a file beside the
      // server, and it is the one thing worth reading before a page is open.
      if (name === SKILL_TOOL) {
        return skill === undefined
          ? result(id, toolFailure(NO_SKILL))
          : result(id, { content: [{ type: 'text', text: skill }] });
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
