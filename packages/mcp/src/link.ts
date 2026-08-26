/**
 * The wire between the agent's server and the running application.
 *
 * The state an agent asks about only exists in the page: the world, its history
 * and the session live in one `PanoramaCore` in one browser tab, and a second
 * copy in the server process would be a second opinion about what the document
 * is. So the server owns no state at all. It is a pipe: the agent's call goes
 * down it, the page runs it against the live application, and the answer comes
 * back.
 *
 * Two plain HTTP endpoints carry that, because both ends already have them and
 * neither needs a dependency: the page opens an event stream and reads calls off
 * it, and posts each answer back. Bound to the loopback interface only — this is
 * an interface that can edit the document, and it has no business being
 * reachable from the network.
 */

import { isRecord } from './schema.js';

/** The development server's port, which is where the endpoint is mounted. */
export const DEFAULT_AGENT_PORT = 5173;

/** Where an agent speaks Model Context Protocol. */
export const MCP_PATH = '/agent/mcp';

export const EVENTS_PATH = '/agent/events';
export const RESULT_PATH = '/agent/result';
export const HEALTH_PATH = '/agent/health';

/** What Claude there is on this machine, pairing it, and opening it. */
export const CLAUDE_PATH = '/agent/claude';
export const CLAUDE_PAIR_PATH = '/agent/claude/pair';
export const CLAUDE_OPEN_PATH = '/agent/claude/open';

/** A call on its way to the page. */
export interface AgentCall {
  readonly id: number;
  readonly name: string;
  readonly args: unknown;
}

/** And the answer coming back. */
export interface AgentReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/**
 * One server-sent event.
 *
 * The blank line is the frame boundary, and the JSON must not contain a newline
 * of its own — `JSON.stringify` never emits one, which is what makes this safe
 * without an encoder.
 */
export const encodeEvent = (call: AgentCall): string => `data: ${JSON.stringify(call)}\n\n`;

export const parseCall = (data: string): AgentCall | null => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const id = value['id'];
  const name = value['name'];
  if (typeof id !== 'number' || typeof name !== 'string') return null;
  return { id, name, args: value['args'] };
};

export const parseReply = (body: string): AgentReply | null => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'number') return null;
  const ok = value['ok'] === true;
  return {
    id,
    ok,
    ...(ok ? { value: value['value'] } : {}),
    ...(typeof value['error'] === 'string' ? { error: value['error'] } : {}),
  };
};
