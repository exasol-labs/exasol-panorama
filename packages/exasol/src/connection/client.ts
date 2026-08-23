import { TableDataError } from '@panorama/table';
import type { ExasolResponseBase } from '../protocol/messages.js';
import { exasolError } from './errors.js';
import type { SocketFactory, SocketLike } from './socket.js';
import { SOCKET_OPEN, defaultSocketFactory } from './socket.js';

/**
 * Low-level request/response transport.
 *
 * The Exasol protocol carries no correlation ids: responses arrive in request
 * order, so requests are issued one at a time and matched against a FIFO
 * queue. Everything above this class deals in typed commands, never packets.
 */

export type ClientState = 'idle' | 'connecting' | 'open' | 'closed';

export interface ExasolClientOptions {
  readonly url: string;
  readonly socketFactory?: SocketFactory;
  readonly connectTimeoutMs?: number;
  /** Called when the socket closes without `close()` having been requested. */
  readonly onUnexpectedClose?: (error: TableDataError) => void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly payload: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * A browser refuses a `wss://` handshake to a host with an untrusted
 * certificate and — unlike a page navigation — never offers to make an
 * exception, reporting only a generic failure. Development instances almost
 * always use a self-signed certificate, so say so rather than leaving the user
 * to guess at firewalls and ports.
 */
export const unreachableMessage = (url: string): string => {
  const base = `Cannot reach ${url}`;
  if (!url.startsWith('wss://')) return base;
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return base;
  }
  return (
    `${base}. If the database uses a self-signed certificate, open ` +
    `https://${host} in a browser tab and accept the warning first, then ` +
    `reconnect. The host must match the certificate exactly — "localhost" and ` +
    `"127.0.0.1" are different hosts to a browser.`
  );
};

export class ExasolProtocolClient {
  readonly #options: ExasolClientOptions;
  readonly #factory: SocketFactory;
  readonly #queue: PendingRequest[] = [];
  #socket: SocketLike | null = null;
  #state: ClientState = 'idle';
  #inFlight: PendingRequest | null = null;
  #closingIntentionally = false;

  constructor(options: ExasolClientOptions) {
    this.#options = options;
    this.#factory = options.socketFactory ?? defaultSocketFactory;
  }

  get state(): ClientState {
    return this.#state;
  }

  connect(): Promise<void> {
    if (this.#state === 'open') return Promise.resolve();
    if (this.#state !== 'idle') {
      return Promise.reject(
        new TableDataError('connection-failed', `Cannot connect while ${this.#state}`),
      );
    }
    this.#state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Built before the timer: a factory that throws must not leave one armed.
      const socket = this.#factory(this.#options.url);
      this.#socket = socket;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#state = 'closed';
        socket.close();
        reject(new TableDataError('connection-failed', 'Timed out connecting to Exasol'));
      }, this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      socket.onopen = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#state = 'open';
        resolve();
      };
      socket.onerror = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#state = 'closed';
        reject(new TableDataError('connection-failed', unreachableMessage(this.#options.url)));
      };
      socket.onmessage = (event): void => {
        this.#handleMessage(event.data);
      };
      socket.onclose = (event): void => {
        clearTimeout(timeout);
        this.#handleClose(event.code, event.reason);
        if (settled) return;
        settled = true;
        reject(new TableDataError('connection-failed', unreachableMessage(this.#options.url)));
      };
    });
  }

  /** Sends a command and resolves with its `responseData`. */
  request<TResponse>(message: object): Promise<TResponse> {
    if (this.#state !== 'open' || this.#socket === null) {
      return Promise.reject(new TableDataError('connection-lost', 'Not connected to Exasol'));
    }
    return new Promise<TResponse>((resolve, reject) => {
      this.#queue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        payload: JSON.stringify(message),
      });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#inFlight !== null || this.#socket === null) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    this.#inFlight = next;
    this.#socket.send(next.payload);
  }

  #handleMessage(data: unknown): void {
    const pending = this.#inFlight;
    this.#inFlight = null;
    if (pending === null) return; // Unsolicited frame; nothing is waiting for it.

    let response: ExasolResponseBase;
    try {
      response = JSON.parse(typeof data === 'string' ? data : String(data)) as ExasolResponseBase;
    } catch (cause) {
      pending.reject(new TableDataError('protocol-error', 'Malformed response from Exasol', cause));
      this.#pump();
      return;
    }

    if (response.status === 'error') {
      pending.reject(exasolError(response.exception ?? { text: 'Unknown Exasol error' }));
    } else {
      pending.resolve(response.responseData);
    }
    this.#pump();
  }

  #handleClose(code: number, reason: string): void {
    const wasOpen = this.#state === 'open' || this.#state === 'connecting';
    this.#state = 'closed';
    this.#socket = null;
    const error = new TableDataError(
      'connection-lost',
      `Exasol connection closed (${code}${reason === '' ? '' : `: ${reason}`})`,
    );
    const pending = [this.#inFlight, ...this.#queue].filter(
      (entry): entry is PendingRequest => entry !== null,
    );
    this.#inFlight = null;
    this.#queue.length = 0;
    for (const entry of pending) entry.reject(error);
    if (wasOpen && !this.#closingIntentionally) this.#options.onUnexpectedClose?.(error);
  }

  close(): void {
    this.#closingIntentionally = true;
    const socket = this.#socket;
    this.#state = 'closed';
    this.#socket = null;
    const pending = [this.#inFlight, ...this.#queue].filter(
      (entry): entry is PendingRequest => entry !== null,
    );
    this.#inFlight = null;
    this.#queue.length = 0;
    for (const entry of pending) {
      entry.reject(new TableDataError('session-closed', 'Connection closed'));
    }
    if (socket !== null && socket.readyState === SOCKET_OPEN) socket.close();
  }
}
