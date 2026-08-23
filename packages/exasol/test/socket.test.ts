import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOCKET_CLOSED,
  SOCKET_CLOSING,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  defaultSocketFactory,
} from '@panorama/exasol';

describe('socket constants', () => {
  it('match the WebSocket readyState values', () => {
    expect([SOCKET_CONNECTING, SOCKET_OPEN, SOCKET_CLOSING, SOCKET_CLOSED]).toEqual([0, 1, 2, 3]);
  });
});

describe('defaultSocketFactory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs a platform WebSocket for the given url', () => {
    const constructed: string[] = [];
    class StubWebSocket {
      constructor(url: string) {
        constructed.push(url);
      }
    }
    vi.stubGlobal('WebSocket', StubWebSocket);
    const socket = defaultSocketFactory('wss://exasol.test:8563');
    expect(constructed).toEqual(['wss://exasol.test:8563']);
    expect(socket).toBeInstanceOf(StubWebSocket);
  });
});
