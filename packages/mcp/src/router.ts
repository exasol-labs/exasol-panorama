import type { AgentCall, AgentReply } from './link.js';

/**
 * Calls in flight.
 *
 * The one piece of state the server keeps, and it is about the conversation
 * rather than about the document: which calls have gone out and not come back.
 * Transport-free on purpose — it is the part with the awkward cases in it (no
 * page attached, a page that goes away mid-call, an answer to a call that has
 * already timed out), and those are worth testing without a socket in the way.
 */

/** Somewhere to write a call: one attached page. */
export interface CallSink {
  readonly id: number;
  send(call: AgentCall): void;
}

export interface RouterOptions {
  /** How long to wait for the page. Opening a relation talks to a database. */
  readonly timeoutMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: unknown;
}

export class CallRouter {
  readonly #pending = new Map<number, Pending>();
  readonly #sinks: CallSink[] = [];
  readonly #timeoutMs: number;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;
  #nextCall = 0;
  #nextSink = 0;
  #calls = 0;
  #lastCallAt: number | null = null;

  constructor(options: RouterOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#setTimer = options.setTimer ?? ((run, ms): unknown => setTimeout(run, ms));
    this.#clearTimer = options.clearTimer ?? ((handle): void => clearTimeout(handle as number));
    this.#now = options.now ?? ((): number => Date.now());
  }

  /**
   * What the conversation has been like, for a person watching the settings
   * panel: a pairing is only really done once something has asked a question.
   */
  get traffic(): { readonly calls: number; readonly lastCallAt: number | null } {
    return { calls: this.#calls, lastCallAt: this.#lastCallAt };
  }

  get attached(): number {
    return this.#sinks.length;
  }

  /**
   * Attaches a page. Returns the way to detach it again.
   *
   * Several pages may be open, and calls go to the one that arrived last: it is
   * the tab in front of the person asking, and picking any other would be a
   * guess. When it goes away the one before it takes over, which is what makes
   * reloading the page invisible to an agent mid-conversation.
   */
  attach(send: (call: AgentCall) => void): () => void {
    const sink: CallSink = { id: (this.#nextSink += 1), send };
    this.#sinks.push(sink);
    return (): void => {
      const at = this.#sinks.indexOf(sink);
      if (at >= 0) this.#sinks.splice(at, 1);
    };
  }

  /** Sends a call to the page and waits for its answer. */
  call(name: string, args: unknown): Promise<unknown> {
    this.#calls += 1;
    this.#lastCallAt = this.#now();
    const sink = this.#sinks.at(-1);
    if (sink === undefined) {
      return Promise.reject(
        new Error(
          'No Panorama session is attached. Open the application in a browser — it connects to this server on its own — and try again.',
        ),
      );
    }
    const id = (this.#nextCall += 1);
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.#setTimer(() => {
        this.#pending.delete(id);
        reject(new Error(`${name} did not answer within ${Math.round(this.#timeoutMs / 1000)}s`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      sink.send({ id, name, args });
    });
  }

  /**
   * Delivers an answer.
   *
   * An answer to a call that is no longer waiting — it timed out, or the server
   * gave up on it — is dropped rather than treated as an error: the page was
   * doing as it was told, just slowly, and there is nobody left to tell.
   */
  deliver(reply: AgentReply): boolean {
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return false;
    this.#pending.delete(reply.id);
    this.#clearTimer(pending.timer);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new Error(reply.error ?? 'The application did not say what went wrong'));
    return true;
  }

  /** Fails everything in flight, for a server that is shutting down. */
  abandon(reason: string): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      this.#clearTimer(pending.timer);
      pending.reject(new Error(reason));
    }
  }
}
