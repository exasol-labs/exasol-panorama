/**
 * The slice of the Worker/MessagePort API Panorama uses.
 *
 * Declaring it explicitly lets the data worker run in-process — in tests, and
 * as a fallback where Workers are unavailable — with no branching in the code
 * that speaks the protocol.
 */

export interface EndpointMessageEvent {
  readonly data: unknown;
}

export type EndpointListener = (event: EndpointMessageEvent) => void;

export interface WorkerEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: EndpointListener): void;
  removeEventListener(type: 'message', listener: EndpointListener): void;
}

export interface EndpointPair {
  readonly main: WorkerEndpoint;
  readonly worker: WorkerEndpoint;
}

const endpointOver = (own: Set<EndpointListener>, peer: Set<EndpointListener>): WorkerEndpoint => ({
  /**
   * Delivers asynchronously to mirror a real worker. The transfer list is
   * ignored on purpose: detaching buffers a same-process peer still references
   * would corrupt them.
   */
  postMessage: (message): void => {
    queueMicrotask(() => {
      for (const listener of [...peer]) listener({ data: message });
    });
  },
  addEventListener: (_type, listener): void => {
    own.add(listener);
  },
  removeEventListener: (_type, listener): void => {
    own.delete(listener);
  },
});

/** Two endpoints wired to each other, for tests and the no-worker fallback. */
export const createInProcessEndpointPair = (): EndpointPair => {
  const mainListeners = new Set<EndpointListener>();
  const workerListeners = new Set<EndpointListener>();
  return {
    main: endpointOver(mainListeners, workerListeners),
    worker: endpointOver(workerListeners, mainListeners),
  };
};
