import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionDialog } from '@panorama/ui';

const noop = (): void => {};

describe('ConnectionDialog', () => {
  it('submits a password connection request', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="disconnected" onConnect={onConnect} />);

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
    render(<ConnectionDialog status="disconnected" onConnect={noop} />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(password.value).toBe('');
  });

  it('submits a personal access token', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="disconnected" onConnect={onConnect} />);

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
    render(<ConnectionDialog status="disconnected" onConnect={noop} />);
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
      />,
    );
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).value).toBe(
      'wss://demo:8563',
    );
    expect((screen.getByLabelText('User') as HTMLInputElement).value).toBe('demo');
  });

  it('shows progress and refuses a second submit while connecting', () => {
    const onConnect = vi.fn();
    render(<ConnectionDialog status="connecting" onConnect={onConnect} />);
    const button = screen.getByRole('button', { name: 'Connecting…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(button);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('shows connection errors', () => {
    render(<ConnectionDialog status="failed" error="Authentication failed" onConnect={noop} />);
    expect(screen.getByRole('alert').textContent).toBe('Authentication failed');
  });

  it('makes the certificate advice clickable rather than something to retype', () => {
    // The driver's wording, which its own test pins; this dialog only renders it.
    const message =
      'Cannot reach wss://localhost:8563. If the database uses a self-signed ' +
      'certificate, open https://localhost:8563 in a browser tab and accept the ' +
      'warning first, then reconnect.';
    render(<ConnectionDialog status="failed" error={message} onConnect={noop} />);
    // The whole message is still there, and the URL in it can be opened.
    expect(screen.getByRole('alert').textContent).toBe(message);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://localhost:8563');
    // Somewhere else, so the tables and the statement being written survive.
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('hides the error region when there is nothing to report', () => {
    render(<ConnectionDialog status="disconnected" error="" onConnect={noop} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
