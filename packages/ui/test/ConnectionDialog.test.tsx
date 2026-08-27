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

/**
 * The deployments Exasol Personal manages.
 *
 * The point of the list is that it answers every question the form asks, so what
 * matters here is that one click means one connection — that a deployment which is
 * not running says so rather than failing a moment later, and that a row says
 * *where* it is, because Exasol Personal deploys to a cloud as readily as to this
 * machine.
 */
describe('Exasol Personal deployments', () => {
  const RUNNING = {
    name: 'default',
    status: 'running',
    infrastructure: 'local',
    url: 'wss://127.0.0.1:8563',
    username: 'sys',
  };
  const STOPPED = { name: 'fuzz', status: 'stopped', infrastructure: 'local' };
  const IN_A_CLOUD = {
    name: 'prod-ish',
    status: 'running',
    infrastructure: 'aws',
    url: 'wss://ec2-3-120-8-4.eu-central-1.compute.amazonaws.com:8563',
    username: 'sys',
  };

  const show = (
    deployments: readonly Record<string, unknown>[],
    onOpenDeployment: (name: string) => void = noop,
    status: 'disconnected' | 'connecting' = 'disconnected',
  ): void => {
    render(
      <ConnectionDialog
        status={status}
        onConnect={noop}
        deploymentsAvailable
        deployments={deployments as never}
        onOpenDeployment={onOpenDeployment}
      />,
    );
  };

  it('is not there at all where nothing could look', () => {
    render(<ConnectionDialog status="disconnected" onConnect={noop} />);
    expect(screen.queryByLabelText('Exasol Personal deployments')).toBeNull();
    // And no tabs either: one way in, presented as one way in.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByLabelText('Database URL')).toBeDefined();
  });

  it('opens one by name, in a click', () => {
    const onOpenDeployment = vi.fn();
    show([RUNNING], onOpenDeployment);
    fireEvent.click(screen.getByRole('button', { name: /default/u }));
    expect(onOpenDeployment).toHaveBeenCalledWith('default');
  });

  /**
   * Whether it is running is the difference between a row that works and one that
   * cannot, so it is said twice: in the accessible name, and as a dot.
   */
  it('says whether each one is running, in words and in a dot', () => {
    show([RUNNING, STOPPED]);
    expect(screen.getByRole('button', { name: 'default, running' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'fuzz, stopped' })).toBeDefined();
    const dots = document.querySelectorAll('.pn-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]?.className).toContain('pn-dot--running');
    expect(dots[1]?.className).toContain('pn-dot--idle');
  });

  it('shows the port for one on this machine, which is what tells six apart', () => {
    show([RUNNING, { ...RUNNING, name: 'other', url: 'wss://127.0.0.1:58325' }]);
    expect(screen.getByText('port 8563')).toBeDefined();
    expect(screen.getByText('port 58325')).toBeDefined();
  });

  /**
   * The correction that prompted all this: a deployment managed from here can be
   * running in a cloud, and a port would say nothing about which one it is.
   */
  it('shows the host for one that is not on this machine', () => {
    show([IN_A_CLOUD]);
    expect(screen.getByText('ec2-3-120-8-4.eu-central-1.compute.amazonaws.com')).toBeDefined();
    expect(screen.queryByText(/^port /u)).toBeNull();
    // And where it is deployed is a hover away, with the exact address.
    expect(screen.getByRole('button', { name: /prod-ish/u }).title).toBe(
      'aws · wss://ec2-3-120-8-4.eu-central-1.compute.amazonaws.com:8563',
    );
  });

  it('lists one that is stopped, and will not pretend it can be opened', () => {
    const onOpenDeployment = vi.fn();
    show([STOPPED], onOpenDeployment);
    const row = screen.getByRole('button', { name: /fuzz/u });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('stopped')).toBeDefined();
    fireEvent.click(row);
    expect(onOpenDeployment).not.toHaveBeenCalled();
  });

  /**
   * Installed and empty is a different situation from not installed, and worth a
   * sentence — but not worth landing on, so the tab is offered and the form is
   * what opens.
   */
  it('says so when the tool is here and has nothing installed', () => {
    show([]);
    expect(screen.getByRole('tab', { name: 'Manual', selected: true })).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Personal' }));
    expect(screen.getByText(/No Exasol Personal deployments yet/u)).toBeDefined();
  });

  /** Two connections at once is not a thing to offer while one is in progress. */
  it('cannot be clicked while a connection is being made', () => {
    show([RUNNING], noop, 'connecting');
    expect((screen.getByRole('button', { name: /default/u }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  /**
   * The real answer takes a couple of seconds, so rows arrive named and unasked-
   * about. They have to read as "not yet" rather than as "broken", and they must
   * not be clickable.
   */
  it('shows a row it has not asked about yet, and will not open it', () => {
    const onOpenDeployment = vi.fn();
    show([{ name: 'default', status: 'checking', infrastructure: 'local' }], onOpenDeployment);
    const row = screen.getByRole('button', { name: 'default, checking' });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('checking…')).toBeDefined();
    fireEvent.click(row);
    expect(onOpenDeployment).not.toHaveBeenCalled();
  });

  /**
   * The tool's own vocabulary, made readable rather than reinterpreted: what it
   * says is the truth, and inventing friendlier words for it would be a second
   * opinion about a database nobody here has looked at.
   */
  it('reads out the tool’s own status, without the underscores', () => {
    show([
      { name: 'broken', status: 'database_connection_failed', infrastructure: 'local' },
      { name: 'busy', status: 'operation_in_progress', infrastructure: 'aws' },
      { name: 'ailab', status: 'address_conflict', infrastructure: 'local' },
      { name: 'shadowed', status: 'port_taken', infrastructure: 'local' },
    ]);
    expect(screen.getByText('database connection failed')).toBeDefined();
    expect(screen.getByText('operation in progress')).toBeDefined();
    // Panorama's own words: two deployments claiming one address, and one whose
    // address turned out to belong to the deployment that is actually running.
    expect(screen.getByText('address conflict')).toBeDefined();
    expect(screen.getByText('port taken')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'ailab, address_conflict' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('puts what the tool said in the hover, for one that is not running', () => {
    show([
      {
        name: 'fuzz',
        status: 'stopped',
        infrastructure: 'local',
        message: 'Deployment stopped. Run `start` to restart.',
      },
    ]);
    expect(screen.getByRole('button', { name: /fuzz/u }).title).toBe(
      'local · stopped · Deployment stopped. Run `start` to restart.',
    );
  });

  it('falls back to the status where a running one reported no address it can read', () => {
    show([{ name: 'odd', status: 'running', infrastructure: 'local', url: 'wss://' }]);
    expect(screen.getByRole('button', { name: 'odd, running' })).toBeDefined();
  });
});

/**
 * Two ways in, when there are two.
 *
 * The deployments are the answer to everything the form asks, so they come first —
 * but only when there is something in them, and never at the cost of moving the
 * ground under somebody who has already chosen the form.
 */
describe('choosing how to connect', () => {
  const RUNNING = {
    name: 'default',
    status: 'running',
    infrastructure: 'local',
    url: 'wss://127.0.0.1:8563',
    username: 'sys',
  };

  const withPersonal = (
    deployments: readonly Record<string, unknown>[] = [RUNNING],
  ): ReturnType<typeof render> =>
    render(
      <ConnectionDialog
        status="disconnected"
        onConnect={noop}
        deploymentsAvailable
        deployments={deployments as never}
        onOpenDeployment={noop}
      />,
    );

  it('opens on Personal, with the form put away', () => {
    withPersonal();
    expect(screen.getByRole('tab', { name: 'Personal', selected: true })).toBeDefined();
    expect(screen.getByLabelText('Exasol Personal deployments')).toBeDefined();
    expect(screen.queryByLabelText('Database URL')).toBeNull();
    // Nothing to submit on this tab, so no button offering to.
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('switches to the form, and back', () => {
    withPersonal();
    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
    expect(screen.getByLabelText('Database URL')).toBeDefined();
    expect(screen.queryByLabelText('Exasol Personal deployments')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Personal' }));
    expect(screen.getByLabelText('Exasol Personal deployments')).toBeDefined();
  });

  it('moves between tabs with the arrow keys', () => {
    withPersonal();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Manual', selected: true })).toBeDefined();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Personal', selected: true })).toBeDefined();
    // Anything else is somebody typing, not navigating.
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'a' });
    expect(screen.getByRole('tab', { name: 'Personal', selected: true })).toBeDefined();
  });

  /**
   * The deployments arrive from the shell a couple of seconds after the dialog. A
   * tab that jumps then would take the form away from somebody in the middle of
   * typing an address into it.
   */
  it('stays where it was put when the deployments arrive late', () => {
    const view = render(<ConnectionDialog status="disconnected" onConnect={noop} />);
    expect(screen.getByLabelText('Database URL')).toBeDefined();
    view.rerender(
      <ConnectionDialog
        status="disconnected"
        onConnect={noop}
        deploymentsAvailable
        deployments={[RUNNING] as never}
        onOpenDeployment={noop}
      />,
    );
    // The tabs are there now, and Personal is where it opens by default…
    expect(screen.getByRole('tab', { name: 'Personal', selected: true })).toBeDefined();

    // …but an explicit choice is not overruled by a later answer.
    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
    view.rerender(
      <ConnectionDialog
        status="disconnected"
        onConnect={noop}
        deploymentsAvailable
        deployments={[RUNNING, { ...RUNNING, name: 'other' }] as never}
        onOpenDeployment={noop}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Manual', selected: true })).toBeDefined();
    expect(screen.getByLabelText('Database URL')).toBeDefined();
  });

  it('keeps only the selected tab in the tab order', () => {
    withPersonal();
    expect(screen.getByRole('tab', { name: 'Personal' }).tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Manual' }).tabIndex).toBe(-1);
  });

  it('says what is happening on either tab while a connection is being made', () => {
    render(
      <ConnectionDialog
        status="connecting"
        onConnect={noop}
        deploymentsAvailable
        deployments={[RUNNING] as never}
        onOpenDeployment={noop}
      />,
    );
    expect(screen.getByText('connecting')).toBeDefined();
  });
});
