import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { parseRequest } from './jsonrpc.js';
import type { AgentHost } from './host.js';
import { handleMcpRequest } from './mcp.js';
import { runOperation } from './operations.js';

/**
 * The whole protocol, answered in the page.
 *
 * The development server answers the handshake and the tool list itself and
 * forwards only the calls (see `http.ts`). That split needs a server with the
 * catalogue compiled into it, which is exactly what an installed application does
 * not have — so where there is no server, the page answers everything: one
 * function, one message in, one message out, and no state.
 *
 * Both halves run the *same* `handleMcpRequest` and the same `runOperation`
 * against the same host. Nothing is reimplemented for the desktop application;
 * the only difference is which process the parsing happens in, and therefore what
 * has to be installed for it to happen at all.
 *
 * `null` for a notification, which has no id and gets no reply.
 */
export const answerProtocol = async (
  host: AgentHost,
  message: string,
  skill: string | undefined,
): Promise<string | null> => {
  const parsed = parseRequest(message);
  // A message that is not a request is already an error response, with the
  // wording the protocol asks for. It goes back as it is.
  if ((parsed as JsonRpcResponse).error !== undefined) return JSON.stringify(parsed);
  const answer = await handleMcpRequest(
    parsed as JsonRpcRequest,
    (name, args) => runOperation(host, name, args),
    skill,
  );
  return answer === null ? null : JSON.stringify(answer);
};
