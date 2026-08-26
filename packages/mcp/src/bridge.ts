import type { AgentHost } from './host.js';
import type { AgentReply } from './link.js';
import { DEFAULT_AGENT_PORT, EVENTS_PATH, RESULT_PATH, parseCall } from './link.js';
import { runOperation } from './operations.js';

/**
 * The application's half of the agent interface.
 *
 * It runs in the page, next to the live state, and answers whatever the agent's
 * server sends down: read the call, run it against the host, post the answer.
 * Which means the whole semantic layer — what the tools are and what they do —
 * runs *here*, and the server never needs to know. It cannot drift from the
 * application because it is the application.
 *
 * Nothing browser-specific is reached for directly: the stream and the posting
 * are handed in. In the page they are `EventSource` and `fetch`; in a test they
 * are two functions, which is how every branch of this can be exercised without
 * a socket.
 */

export interface EventStreamLike {
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  close(): void;
}

export interface BridgeOptions {
  readonly host: AgentHost;
  /** Where the agent server is. Defaults to the loopback port it binds. */
  readonly origin?: string;
  openStream: (url: string) => EventStreamLike;
  post: (url: string, body: string) => Promise<void>;
  /** Told about attaching, detaching and each call. */
  readonly onLog?: (message: string) => void;
}

export interface AgentBridge {
  close(): void;
}

/**
 * Where the endpoint is when nobody says.
 *
 * The page is served by the same server that hosts it, so in the browser this is
 * only ever a fallback — and `localhost` rather than a literal address, because
 * which of the two loopback families the dev server picked is its business.
 */
export const defaultAgentOrigin = (): string => `http://localhost:${DEFAULT_AGENT_PORT}`;

/**
 * Connects the application to the agent server.
 *
 * Failures are answers, not exceptions: a tool that refused because a table does
 * not exist has to reach the agent as words it can act on, and an unhandled
 * rejection in a page would reach nobody at all.
 */
export const startAgentBridge = (options: BridgeOptions): AgentBridge => {
  const origin = options.origin ?? defaultAgentOrigin();
  const log = options.onLog ?? ((): void => {});
  const stream = options.openStream(`${origin}${EVENTS_PATH}`);
  let closed = false;

  const reply = (message: AgentReply): void => {
    void options
      .post(`${origin}${RESULT_PATH}`, JSON.stringify(message))
      .catch((error: unknown) => {
        log(`could not answer call ${message.id}: ${String(error)}`);
      });
  };

  stream.addEventListener('message', (event) => {
    const call = parseCall(event.data);
    if (call === null) {
      log('ignored a message that was not a call');
      return;
    }
    void (async (): Promise<void> => {
      try {
        const value = await runOperation(options.host, call.name, call.args);
        log(`${call.name} answered`);
        reply({ id: call.id, ok: true, value });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${call.name} refused: ${message}`);
        reply({ id: call.id, ok: false, error: message });
      }
    })();
  });

  stream.addEventListener('error', () => {
    // An event stream reconnects on its own, so an error here is news rather
    // than something to act on: the interesting case is the server not being
    // there yet, and it will be picked up when it is.
    if (!closed) log('agent server unreachable; will keep trying');
  });

  return {
    close: (): void => {
      closed = true;
      stream.close();
    },
  };
};
