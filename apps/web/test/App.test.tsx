import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App.js';
import { createAppHarness } from './harness.js';

/**
 * The canvas needs a GPU, so the shell is tested with it stubbed out. What is
 * being verified here is the React side: connection, explorer, error routing
 * and the instrumentation overlay.
 */
let lastAction: ((entityId: string, action: string) => void) | null = null;

vi.mock('../src/panorama/PanoramaCanvas.js', () => ({
  PanoramaCanvas: ({
    onReady,
    onAction,
  }: {
    onReady?: (renderer: unknown, backend: string) => void;
    onAction?: (entityId: string, action: string) => void;
  }) => {
    onReady?.({ enterXR: async (): Promise<null> => null, revealEntity: (): void => {} }, 'null');
    lastAction = onAction ?? null;
    return <div data-testid="canvas" />;
  },
}));

/** Scopes a query to the explorer, which shares table names with the samples. */
const inTables = (): ReturnType<typeof within> =>
  within(screen.getByRole('list', { name: 'Tables' }));

const connect = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText('Database URL'), {
    target: { value: 'wss://exasol.test:8563' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'exasol' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDefined());
};

describe('App', () => {
  it('connects and reveals the explorer', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);

    expect(screen.queryByLabelText('Schema')).toBeNull();
    await connect();

    expect(harness.connections[0]?.url).toBe('wss://exasol.test:8563');
    expect(screen.getByLabelText('Schema')).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'PANORAMA_TEST' })).toBeDefined(),
    );
  });

  it('lists tables and opens one onto the canvas', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();

    fireEvent.change(screen.getByLabelText('Schema'), { target: { value: 'PANORAMA_TEST' } });
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());

    fireEvent.click(inTables().getByText('SALES'));
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));
    expect(harness.workspace.core.world.entities.size).toBe(1);
  });

  it('reports a failed connection', async () => {
    const harness = createAppHarness();
    vi.spyOn(harness.workspace, 'connect').mockRejectedValue(new Error('Authentication failed'));
    render(<App workspace={harness.workspace} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Authentication failed'),
    );
    expect(screen.getByText('failed')).toBeDefined();
  });

  it('reports a table that cannot be opened', async () => {
    const harness = createAppHarness({ failOpen: true });
    render(<App workspace={harness.workspace} />);
    await connect();
    fireEvent.change(screen.getByLabelText('Schema'), { target: { value: 'PANORAMA_TEST' } });
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());

    fireEvent.click(inTables().getByText('SALES'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Simulated failure'),
    );
    // The rest of the workspace survives one table failing.
    expect(screen.getByLabelText('Schema')).toBeDefined();
  });

  it('reports a failure listing tables', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();
    vi.spyOn(harness.workspace, 'listTables').mockRejectedValue(new Error('permission denied'));

    fireEvent.change(screen.getByLabelText('Schema'), { target: { value: 'PANORAMA_TEST' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('permission denied'));
  });

  it('disconnects and tears the session down', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined());
    expect(screen.queryByLabelText('Schema')).toBeNull();
  });

  it('samples the render loop into the overlay without re-rendering the canvas', async () => {
    vi.useFakeTimers();
    try {
      const harness = createAppHarness();
      render(<App workspace={harness.workspace} />);
      expect(screen.getByText('Draw calls')).toBeDefined();
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText('Backend')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses and restores the overlay', () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Draw calls')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /fps/ }));
    expect(screen.getByText('Draw calls')).toBeDefined();
  });

  it('reports when XR is unavailable', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter XR' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('WebXR is not available in this browser.'),
    );
  });

  it('opens a built-in sample table with no connection', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);

    fireEvent.click(
      within(screen.getByRole('list', { name: 'Sample tables' })).getByText('SAMPLE_100'),
    );
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a sample table that cannot be opened', async () => {
    const harness = createAppHarness({ failOpen: true });
    render(<App workspace={harness.workspace} />);
    fireEvent.click(within(screen.getByRole('list', { name: 'Sample tables' })).getByText('SALES'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Simulated'));
  });

  it('performs a halo action reported by the canvas', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);

    fireEvent.click(
      within(screen.getByRole('list', { name: 'Sample tables' })).getByText('SAMPLE_100'),
    );
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));

    const id = harness.workspace.core.world.order[0];
    if (id === undefined || lastAction === null) throw new Error('expected an open table');
    act(() => {
      lastAction?.(id, 'close');
    });
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(0));
  });

  it('reports a failing halo action', async () => {
    const harness = createAppHarness();
    vi.spyOn(harness.workspace, 'performAction').mockRejectedValue(new Error('cannot close'));
    render(<App workspace={harness.workspace} />);
    if (lastAction === null) throw new Error('expected an action handler');

    act(() => {
      lastAction?.('table:x', 'close');
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('cannot close'));
  });

  it('accepts a default database URL', () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} defaultUrl="wss://demo:8563" />);
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).value).toBe(
      'wss://demo:8563',
    );
  });
});
