import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionDialog } from '@panorama/ui';

const noop = (): void => {};

describe('ConnectionDialog', () => {
  it('submits a password connection request', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="disconnected" onConnect={onConnect} onDisconnect={noop} />);

    fireEvent.change(screen.getByLabelText('Database URL'), {
      target: { value: 'wss://exasol.example:8563' },
    });
    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'analyst' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnect).toHaveBeenCalledWith({
      url: 'wss://exasol.example:8563',
      credentials: { kind: 'password', username: 'analyst', password: 's3cret' },
    });
  });

  it('clears the secret from its own state once submitted', () => {
    render(<ConnectionDialog status="disconnected" onConnect={noop} onDisconnect={noop} />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(password.value).toBe('');
  });

  it('submits a personal access token', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="disconnected" onConnect={onConnect} onDisconnect={noop} />);

    fireEvent.click(screen.getByLabelText('Access token'));
    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'pat_abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { kind: 'token', token: 'pat_abc' } }),
    );
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('switches back to password authentication', () => {
    render(<ConnectionDialog status="disconnected" onConnect={noop} onDisconnect={noop} />);
    fireEvent.click(screen.getByLabelText('Access token'));
    fireEvent.click(screen.getByLabelText('User & password'));
    expect(screen.getByLabelText('User')).toBeDefined();
  });

  it('uses the supplied defaults', () => {
    render(
      <ConnectionDialog
        status="disconnected"
        defaultUrl="wss://demo:8563"
        defaultUsername="demo"
        onConnect={noop}
        onDisconnect={noop}
      />,
    );
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).value).toBe(
      'wss://demo:8563',
    );
    expect((screen.getByLabelText('User') as HTMLInputElement).value).toBe('demo');
  });

  it('shows progress and refuses a second submit while connecting', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="connecting" onConnect={onConnect} onDisconnect={noop} />);
    const button = screen.getByRole('button', { name: 'Connecting…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(button);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('offers disconnect once connected', () => {
    const onDisconnect = vi.fn();
    render(<ConnectionDialog status="connected" onConnect={noop} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).disabled).toBe(true);
  });

  it('does not reconnect while already connected', () => {
    const onConnect = vi.fn();
    const { container } = render(
      <ConnectionDialog status="connected" onConnect={onConnect} onDisconnect={noop} />,
    );
    const form = container.querySelector('form');
    if (form === null) throw new Error('expected a form');
    fireEvent.submit(form);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows connection errors', () => {
    render(
      <ConnectionDialog
        status="failed"
        error="Authentication failed"
        onConnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Authentication failed');
  });

  it('hides the error region when there is nothing to report', () => {
    render(
      <ConnectionDialog status="disconnected" error="" onConnect={noop} onDisconnect={noop} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
