import { describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '@panorama/exasol';
import { ExasolProtocolClient, SOCKET_OPEN, unreachableMessage } from '@panorama/exasol';
import { FakeSocket } from './fake-exasol.js';

const manual = (): { client: ExasolProtocolClient; sockets: FakeSocket[] } => {
  const sockets: FakeSocket[] = [];
  const client = new ExasolProtocolClient({
    url: 'wss://exasol.test:8563',
    connectTimeoutMs: 50,
    socketFactory: (url): SocketLike => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
};

const socketOf = (sockets: FakeSocket[]): FakeSocket => {
  const socket = sockets[0];
  if (socket === undefined) throw new Error('no socket');
  return socket;
};

describe('ExasolProtocolClient', () => {
  it('resolves connect when the socket opens', async () => {
    const { client, sockets } = manual();
    expect(client.state).toBe('idle');
    const connected = client.connect();
    expect(client.state).toBe('connecting');
    socketOf(sockets).acceptConnection();
    await connected;
    expect(client.state).toBe('open');
    // Connecting again is a no-op.
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('rejects a second concurrent connect', async () => {
    const { client, sockets } = manual();
    const first = client.connect();
    await expect(client.connect()).rejects.toMatchObject({ code: 'connection-failed' });
    socketOf(sockets).acceptConnection();
    await first;
  });

  it('explains the self-signed certificate trap for secure sockets', () => {
    const message = unreachableMessage('wss://localhost:8563');
    expect(message).toContain('Cannot reach wss://localhost:8563');
    expect(message).toContain('https://localhost:8563');
    expect(message).toContain('self-signed');
    // A browser treats these as different hosts, which surprises everyone once.
    expect(message).toContain('127.0.0.1');
  });

  it('keeps the message plain for insecure or malformed urls', () => {
    expect(unreachableMessage('ws://localhost:8563')).toBe('Cannot reach ws://localhost:8563');
    expect(unreachableMessage('wss://not a url')).toBe('Cannot reach wss://not a url');
  });

  it('surfaces the certificate hint when a connection fails', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    socketOf(sockets).failConnection();
    await expect(connected).rejects.toThrow(/self-signed/);
  });

  it('rejects when the socket errors', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    socketOf(sockets).failConnection();
    await expect(connected).rejects.toMatchObject({ code: 'connection-failed' });
    expect(client.state).toBe('closed');
  });

  it('rejects when the socket closes before opening', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    socketOf(sockets).serverClose(1006, 'refused');
    await expect(connected).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('times out a connection attempt', async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = manual();
      const connected = client.connect();
      vi.advanceTimersByTime(60);
      await expect(connected).rejects.toThrow(/Timed out/);
      expect(socketOf(sockets).closedWith).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late open after a timeout', async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = manual();
      const connected = client.connect();
      vi.advanceTimersByTime(60);
      await expect(connected).rejects.toThrow();
      expect(() => socketOf(sockets).acceptConnection()).not.toThrow();
      expect(() => socketOf(sockets).failConnection()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends one request at a time and resolves responseData in order', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;

    const first = client.request<{ value: number }>({ command: 'execute', sqlText: 'A' });
    const second = client.request<{ value: number }>({ command: 'execute', sqlText: 'B' });
    expect(socket.sent).toHaveLength(1);

    socket.deliver({ status: 'ok', responseData: { value: 1 } });
    await expect(first).resolves.toEqual({ value: 1 });
    expect(socket.sent).toHaveLength(2);

    socket.deliver({ status: 'ok', responseData: { value: 2 } });
    await expect(second).resolves.toEqual({ value: 2 });
  });

  it('rejects with a classified error for error responses', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;

    const request = client.request({ command: 'execute', sqlText: 'A' });
    socket.deliver({ status: 'error', exception: { text: 'insufficient privileges' } });
    await expect(request).rejects.toMatchObject({ code: 'permission-denied' });

    const second = client.request({ command: 'execute', sqlText: 'B' });
    socket.deliver({ status: 'error' });
    await expect(second).rejects.toMatchObject({ code: 'fetch-failed' });
  });

  it('rejects malformed frames', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;

    const request = client.request({ command: 'execute', sqlText: 'A' });
    socket.deliverRaw('<<not json>>');
    await expect(request).rejects.toMatchObject({ code: 'protocol-error' });
  });

  it('ignores unsolicited frames', async () => {
    const { client, sockets } = manual();
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;
    expect(() => socket.deliver({ status: 'ok' })).not.toThrow();
  });

  it('refuses requests when not connected', async () => {
    const { client } = manual();
    await expect(client.request({ command: 'disconnect' })).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });

  it('fails pending requests and reports an unexpected close', async () => {
    const onUnexpectedClose = vi.fn();
    const sockets: FakeSocket[] = [];
    const client = new ExasolProtocolClient({
      url: 'wss://exasol.test:8563',
      socketFactory: (url): SocketLike => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onUnexpectedClose,
    });
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;

    const first = client.request({ command: 'execute', sqlText: 'A' });
    const second = client.request({ command: 'execute', sqlText: 'B' });
    socket.serverClose(1006, 'network down');

    await expect(first).rejects.toMatchObject({ code: 'connection-lost' });
    await expect(second).rejects.toMatchObject({ code: 'connection-lost' });
    expect(onUnexpectedClose).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('closed');
  });

  it('does not report an intentional close as unexpected', async () => {
    const onUnexpectedClose = vi.fn();
    const sockets: FakeSocket[] = [];
    const client = new ExasolProtocolClient({
      url: 'wss://exasol.test:8563',
      socketFactory: (url): SocketLike => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onUnexpectedClose,
    });
    const connected = client.connect();
    const socket = socketOf(sockets);
    socket.acceptConnection();
    await connected;

    const pending = client.request({ command: 'execute', sqlText: 'A' });
    client.close();
    await expect(pending).rejects.toMatchObject({ code: 'session-closed' });
    expect(socket.readyState).not.toBe(SOCKET_OPEN);
    socket.serverClose(1000, 'bye');
    expect(onUnexpectedClose).not.toHaveBeenCalled();

    // Closing twice is harmless.
    expect(() => client.close()).not.toThrow();
  });
});
