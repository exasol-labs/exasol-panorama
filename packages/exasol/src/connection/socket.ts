/**
 * The minimal WebSocket surface Panorama depends on.
 *
 * Declaring it explicitly (rather than depending on `lib.dom`'s `WebSocket`)
 * keeps the driver testable in Node with a scripted fake, which is how the
 * protocol tests run without a database.
 */

export interface SocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface SocketMessageEvent {
  readonly data: unknown;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

export const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;
