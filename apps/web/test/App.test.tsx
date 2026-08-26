import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CameraController } from '@panorama/renderer';
import { App } from '../src/App.js';
import { createAppHarness } from './harness.js';

/**
 * The canvas needs a GPU, so the shell is tested with it stubbed out. What is
 * being verified here is the React side: connection, explorer, error routing
 * and the instrumentation overlay.
 */
/** What the stubbed renderer reports from `enterXR`; null means "did not enter". */
let xrSession: unknown = null;
let lastAction: ((entityId: string, action: string) => void) | null = null;
let lastFollow: ((follow: unknown) => void) | null = null;

vi.mock('../src/panorama/PanoramaCanvas.js', () => ({
  PanoramaCanvas: ({
    onReady,
    onAction,
    onFollowForeignKey,
  }: {
    onReady?: (renderer: unknown, backend: string) => void;
    onAction?: (entityId: string, action: string) => void;
    onFollowForeignKey?: (follow: unknown) => void;
  }) => {
    // Stands in for a real renderer, so it has to answer everything the shell
    // asks of one — the SQL overlay reads the camera and the drawn transform
    // every frame.
    onReady?.(
      {
        enterXR: async (): Promise<unknown> => xrSession,
        prepareXR: async (): Promise<boolean> => true,
        revealEntity: (): void => {},
        camera: new CameraController(),
        drawnEntity: (entity: unknown) => entity,
      },
      'null',
    );
    lastAction = onAction ?? null;
    lastFollow = onFollowForeignKey ?? null;
    return <div data-testid="canvas" />;
  },
}));

/** Scopes a query to the explorer, which shares table names with the samples. */
const inTables = (): ReturnType<typeof within> =>
  within(screen.getByRole('list', { name: 'Relations in PANORAMA_TEST' }));

/** Opens a schema in the explorer tree, the way a pointer would. */
const openSchema = async (name = 'PANORAMA_TEST'): Promise<void> => {
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(name, 'u') })));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'u') }));
};

const connect = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText('Database URL'), {
    target: { value: 'wss://exasol.test:8563' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'exasol' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  // The form goes when it is answered, and the explorer's indicator takes over
  // saying which database this is — so that is what "connected" looks like now.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Disconnect from/u })).toBeDefined(),
  );
};

describe('App', () => {
  it('connects and reveals the explorer', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);

    expect(screen.queryByRole('list', { name: 'Schemas' })).toBeNull();
    await connect();

    expect(harness.connections[0]?.url).toBe('wss://exasol.test:8563');
    expect(screen.getByRole('list', { name: 'Schemas' })).toBeDefined();
    // The schemas are listed closed: a tree, not a dropdown.
    const schema = await waitFor(() => screen.getByRole('button', { name: /PANORAMA_TEST/u }));
    expect(schema.getAttribute('aria-expanded')).toBe('false');
    // Nothing inside it yet — and the sample panel's own SALES is why this asks
    // about the schema's list rather than about the name.
    expect(screen.queryByRole('list', { name: 'Relations in PANORAMA_TEST' })).toBeNull();
  });

  it('puts the connection form away once it has been answered', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    expect(screen.getByLabelText('Database URL')).toBeDefined();
    await connect();

    // Nothing left to ask, so nothing left to show: every field in that form was
    // disabled from the moment it succeeded.
    expect(screen.queryByLabelText('Database URL')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    // What survives of it is the indicator: which database, and the way back.
    expect(screen.getByText('exasol.test:8563')).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: 'Disconnect from exasol.test:8563' })
        .getAttribute('title'),
    ).toBe('Disconnect from wss://exasol.test:8563');
  });

  it('lists tables and opens one onto the canvas', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();

    await openSchema();
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());
    // Tables before views, each with its own mark, and the table carrying the
    // row count the catalogue reported.
    expect(
      inTables()
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.pn-tree__name')?.textContent),
    ).toEqual(['SALES', 'SALES_V']);
    expect(inTables().getByText('2.83B')).toBeDefined();
    // The view has none, because the catalogue has none for a view.
    expect(inTables().getAllByRole('listitem')[1]?.querySelector('.pn-tree__count')).toBeNull();

    fireEvent.click(inTables().getByText('SALES'));
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));
    expect(harness.workspace.core.world.entities.size).toBe(1);
  });

  it('lists a schema once, however often it is folded open', async () => {
    const harness = createAppHarness();
    const listTables = vi.spyOn(harness.workspace, 'listTables');
    render(<App workspace={harness.workspace} />);
    await connect();

    await openSchema();
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());
    // Closed and opened again: already listed, so no second query.
    fireEvent.click(screen.getByRole('button', { name: /PANORAMA_TEST/u, expanded: true }));
    await openSchema();
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());
    expect(listTables).toHaveBeenCalledTimes(1);
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
    await openSchema();
    await waitFor(() => expect(inTables().getByText('SALES')).toBeDefined());

    fireEvent.click(inTables().getByText('SALES'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Simulated failure'),
    );
    // The rest of the workspace survives one table failing.
    expect(screen.getByRole('list', { name: 'Schemas' })).toBeDefined();
  });

  it('reports a failure listing tables', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();
    vi.spyOn(harness.workspace, 'listTables').mockRejectedValue(new Error('permission denied'));

    await openSchema();
    // Reported inside the schema that failed, so the others are still usable.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('permission denied'));
    expect(screen.getByRole('list', { name: 'Schemas' })).toBeDefined();
  });

  it('disconnects and tears the session down', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: /^Disconnect from/u }));
    // The form comes back, empty of the secret it was given.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined());
    expect(screen.queryByRole('list', { name: 'Schemas' })).toBeNull();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('opens the settings panel and pairs through the development server', async () => {
    const harness = createAppHarness();
    const asked: string[] = [];
    const posted: { url: string; body: unknown }[] = [];
    const copied: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body ?? '{}') });
        return Promise.resolve(
          new Response(JSON.stringify({ outcomes: [{ detail: 'Added "panorama".' }] })),
        );
      }
      asked.push(url);
      const body =
        url === '/agent/health'
          ? {
              attached: 1,
              calls: 0,
              lastCallAt: null,
              mcpUrl: 'http://localhost:5173/agent/mcp',
              tools: ['overview'],
            }
          : {
              platform: 'darwin',
              cli: { found: true, paired: false },
              desktop: { found: false, configPath: '', paired: false },
              canOpenTerminal: true,
              mcpUrl: 'http://localhost:5173/agent/mcp',
            };
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: (text: string) => copied.push(text) },
    });
    try {
      render(<App workspace={harness.workspace} />);
      fireEvent.click(screen.getByRole('button', { name: 'Show settings' }));
      await waitFor(() => expect(asked).toContain('/agent/claude'));
      await waitFor(() =>
        expect(screen.getByText('http://localhost:5173/agent/mcp')).toBeDefined(),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(copied).toEqual(['http://localhost:5173/agent/mcp']);

      fireEvent.click(screen.getByRole('button', { name: 'Pair with Claude' }));
      await waitFor(() => expect(screen.getByText('Added "panorama".')).toBeDefined());
      expect(posted[0]?.url).toBe('/agent/claude/pair');

      // And a request that goes nowhere is an answer, not an unhandled failure.
      // Once the server has gone the panel says that instead, which is the more
      // useful of the two things to be told.
      vi.stubGlobal('fetch', () => Promise.reject(new Error('gone')));
      fireEvent.click(screen.getByRole('button', { name: 'Open Claude Code' }));
      await waitFor(() =>
        expect(screen.getByText(/part of the development server/u)).toBeDefined(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says the agent interface is absent rather than looking broken', async () => {
    // Which is what a built page gets: the routes are the dev server's.
    const harness = createAppHarness();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no such route')));
    try {
      render(<App workspace={harness.workspace} />);
      fireEvent.click(screen.getByRole('button', { name: 'Show settings' }));
      await waitFor(() =>
        expect(screen.getByText(/part of the development server/u)).toBeDefined(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('says nothing at all when the headset is entered', async () => {
    xrSession = { baseExperience: {} };
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter XR' }));
    // A successful entry is not an event worth interrupting the user for.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    xrSession = null;
  });

  it('reports a session that will not start', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);
    // The button only appears once the headset probe has answered.
    const button = await screen.findByRole('button', { name: 'Enter XR' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'WebXR could not start a session in this browser.',
      ),
    );
  });

  it('names the real obstacle when the page is not secure', async () => {
    const harness = createAppHarness();
    // WebXR is refused outright on an insecure origin, which is what a Quest
    // sees when the dev server is reached over plain http on a LAN address.
    vi.stubGlobal('isSecureContext', false);
    render(<App workspace={harness.workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter XR' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('needs a secure page'),
    );
    vi.unstubAllGlobals();
  });

  it('connects with details supplied before the page opened', async () => {
    const harness = createAppHarness();
    render(
      <App
        workspace={harness.workspace}
        startup={{
          url: 'wss://db:8563',
          username: 'analyst',
          credentials: { kind: 'password', username: 'analyst', password: 'hunter2' },
          autoConnect: true,
        }}
      />,
    );
    // Straight to the explorer, naming the database it was told to open: a
    // headset has nobody to fill a form in, so the form should not be there.
    await waitFor(() => expect(screen.getByText('db:8563')).toBeDefined());
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect from db:8563' })).toBeDefined();
  });

  it('opens the table it was told to, so a headset needs no interaction', async () => {
    const harness = createAppHarness();
    render(
      <App
        workspace={harness.workspace}
        startup={{
          url: 'wss://db:8563',
          credentials: { kind: 'token', token: 't' },
          autoConnect: true,
          open: { schema: 'PANORAMA_TEST', table: 'SALES' },
        }}
      />,
    );
    await waitFor(() => expect(harness.workspace.core.world.order).toHaveLength(1));
  });

  it('reports a table named at startup that cannot be opened', async () => {
    const harness = createAppHarness({ failDescribe: true });
    render(
      <App
        workspace={harness.workspace}
        startup={{
          url: 'wss://db:8563',
          credentials: { kind: 'token', token: 't' },
          autoConnect: true,
          open: { schema: 'PANORAMA_TEST', table: 'GONE' },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(harness.workspace.core.world.order).toHaveLength(0);
  });

  it('prefills without connecting when no secret was supplied', async () => {
    const harness = createAppHarness();
    render(
      <App
        workspace={harness.workspace}
        startup={{ url: 'wss://db:8563', username: 'analyst', autoConnect: false }}
      />,
    );
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).value).toBe('wss://db:8563');
    // Still waiting to be told to connect.
    await waitFor(() => expect(screen.getByText('disconnected')).toBeDefined());
  });

  it('does not open a table when the connection was refused', async () => {
    const harness = createAppHarness();
    vi.spyOn(harness.workspace, 'connect').mockRejectedValue(new Error('bad password'));
    render(
      <App
        workspace={harness.workspace}
        startup={{
          url: 'wss://db:8563',
          credentials: { kind: 'password', username: 'sys', password: 'wrong' },
          autoConnect: true,
          open: { schema: 'PANORAMA_TEST', table: 'SALES' },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText('bad password')).toBeDefined());
    expect(harness.workspace.core.world.order).toHaveLength(0);
    vi.restoreAllMocks();
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

  it('mirrors a running export, and stops it when told to', async () => {
    // A destination that only finishes when the test says so, so the export can
    // be watched — and stopped — while it is still going.
    let release: (() => void) | null = null;
    const harness = createAppHarness({
      rowCount: 200_000,
      openExportSink: async () => ({
        position: 0,
        async write(): Promise<void> {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        async close(): Promise<void> {
          /* Never reached. */
        },
      }),
    });
    render(<App workspace={harness.workspace} />);
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Sample tables' })).getByText('SAMPLE_100'),
    );
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));
    const id = harness.workspace.core.world.order[0];
    if (id === undefined || lastAction === null) throw new Error('expected an open table');

    act(() => {
      lastAction?.(id, 'export-csv');
    });
    // The panel appears because there is now an export to watch.
    const row = await waitFor(() => screen.getByText('PANORAMA_DEMO.SAMPLE_100.csv'));
    expect(row).toBeTruthy();
    expect(screen.getByText('CSV')).toBeTruthy();
    // The harness's fetches are hand-driven, so the export is walked forward
    // until it is inside a write.
    for (let round = 0; round < 100 && release === null; round += 1) {
      await act(async () => {
        await harness.pump(1);
      });
    }
    expect(release).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByText('Stopped')).toBeTruthy());
    // And it can be cleared away again.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('PANORAMA_DEMO.SAMPLE_100.csv')).toBeNull());
    release?.();
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

  it('follows a foreign key reported by the canvas', async () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} />);

    fireEvent.click(
      within(screen.getByRole('list', { name: 'Sample tables' })).getByText('SAMPLE_100'),
    );
    await waitFor(() => expect(harness.workspace.openTableCount).toBe(1));

    const source = harness.workspace.core.world.order[0];
    const entity = harness.workspace.core.world.entities.get(source as never);
    const column = entity?.columns.find((entry) => entry.sourceColumn.name === 'COUNTRY');
    if (column === undefined || lastFollow === null) throw new Error('expected a linked column');

    act(() => {
      lastFollow?.({
        tableId: source,
        columnId: column.id,
        row: 0,
        sourceColumn: 'COUNTRY',
        reference: column.sourceColumn.foreignKey,
        value: 'Germany',
      });
    });

    await waitFor(() => expect(harness.workspace.openTableCount).toBe(2));
    expect(harness.workspace.core.world.bindings.size).toBe(1);
  });

  it('reports a foreign key that cannot be followed', async () => {
    const harness = createAppHarness();
    vi.spyOn(harness.workspace, 'followForeignKey').mockRejectedValue(new Error('no such table'));
    render(<App workspace={harness.workspace} />);
    if (lastFollow === null) throw new Error('expected a follow handler');

    act(() => {
      lastFollow?.({ tableId: 'table:x', columnId: 'column:y', row: 0 });
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('no such table'));
  });

  it('accepts a default database URL', () => {
    const harness = createAppHarness();
    render(<App workspace={harness.workspace} defaultUrl="wss://demo:8563" />);
    expect((screen.getByLabelText('Database URL') as HTMLInputElement).value).toBe(
      'wss://demo:8563',
    );
  });
});
