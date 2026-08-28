import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from '@panorama/ui';

const HEALTH = {
  attached: 1,
  calls: 3,
  lastCallAt: Date.now() - 4_000,
  mcpUrl: 'http://localhost:5173/agent/mcp',
  tools: ['overview', 'entities'],
};

const CLAUDE = {
  platform: 'darwin',
  cli: { found: true, path: '/usr/local/bin/claude', paired: false },
  desktop: { found: false, configPath: '/config.json', paired: false },
  canOpenTerminal: true,
  mcpUrl: HEALTH.mcpUrl,
};

const enabled = (name: string): boolean =>
  !(screen.getByRole('button', { name }) as HTMLButtonElement).disabled;

const panel = (
  options: {
    readonly health?: unknown;
    readonly claude?: unknown;
    readonly answer?: unknown;
    readonly open?: boolean;
    readonly version?: string;
  } = {},
): {
  load: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn>;
  copied: string[];
  toggles: number;
} => {
  const load = vi.fn(async (path: string) =>
    path === '/agent/health'
      ? options.health === undefined
        ? HEALTH
        : options.health
      : options.claude === undefined
        ? CLAUDE
        : options.claude,
  );
  // `in` rather than a fallback, so a test can say "the request went nowhere"
  // with an explicit null and not be given the default instead.
  const doIt = vi.fn(async () =>
    'answer' in options ? options.answer : { outcomes: [{ detail: 'Added it.' }] },
  );
  const copied: string[] = [];
  let toggles = 0;
  render(
    <SettingsPanel
      open={options.open ?? true}
      onToggle={() => {
        toggles += 1;
      }}
      load={load as never}
      act={doIt as never}
      onCopy={(text) => copied.push(text)}
      {...(options.version === undefined ? {} : { version: options.version })}
    />,
  );
  return {
    load,
    act: doIt,
    copied,
    get toggles() {
      return toggles;
    },
  };
};

describe('SettingsPanel', () => {
  it('is a title row until it is opened', () => {
    const handles = panel({ open: false });
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.queryByText('Agent endpoint')).toBeNull();
    // Nothing is asked of the machine while nobody is looking.
    expect(handles.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show settings' }));
    expect(handles.toggles).toBe(1);
  });

  it('reports the endpoint, what is on the machine, and whether anything is talking', async () => {
    panel();
    await waitFor(() => expect(screen.getByText('http://localhost:5173/agent/mcp')).toBeDefined());
    expect(screen.getByText(/2 tools/u).textContent).toContain('attached');
    // Paired is one thing; paired and talking is another.
    expect(screen.getByText(/3 calls, last 4s ago/u)).toBeDefined();
    expect(screen.getByText('found, not paired')).toBeDefined();
    expect(screen.getByText('not on this machine')).toBeDefined();
  });

  it('copies the endpoint, because the next thing to do with it is paste it', async () => {
    const handles = panel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(handles.copied).toEqual(['http://localhost:5173/agent/mcp']);
  });

  it('pairs, and says what the machine said', async () => {
    const handles = panel({
      answer: {
        outcomes: [{ detail: 'Added "panorama" to Claude Code.' }, { detail: 'Wrote it.' }],
      },
    });
    await waitFor(() => expect(enabled('Pair with Claude')).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pair with Claude' }));
    });
    expect(handles.act).toHaveBeenCalledWith('/agent/claude/pair', {});
    expect(screen.getByText('Added "panorama" to Claude Code.')).toBeDefined();
    expect(screen.getByText('Wrote it.')).toBeDefined();
  });

  it('opens Claude, and says which one', async () => {
    const handles = panel({
      answer: { opened: 'cli', detail: 'Opened Claude Code in a Terminal.' },
    });
    await waitFor(() => expect(enabled('Open Claude Code')).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Claude Code' }));
    });
    expect(handles.act).toHaveBeenCalledWith('/agent/claude/open', {});
    expect(screen.getByText('Opened Claude Code in a Terminal.')).toBeDefined();
  });

  it('offers nothing to press when there is no Claude to press it on', async () => {
    panel({
      claude: {
        ...CLAUDE,
        cli: { found: false, paired: false },
        desktop: { found: false, configPath: '', paired: false },
      },
    });
    await waitFor(() => expect(enabled('Pair with Claude')).toBe(false));
    expect(enabled('Open Claude Code')).toBe(false);
  });

  it('says the interface is not there rather than looking broken', async () => {
    panel({ health: null, claude: null });
    // A built page has no development server behind it, and so no routes.
    await waitFor(() => expect(screen.getByText(/part of the development server/u)).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Pair with Claude' })).toBeNull();
  });

  it('passes on a request that went nowhere', async () => {
    panel({ answer: null });
    await waitFor(() => expect(enabled('Open Claude Code')).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Claude Code' }));
    });
    expect(screen.getByText('The development server did not answer.')).toBeDefined();
  });

  it('shows an error the machine reported', async () => {
    panel({ answer: { error: 'osascript is not available' } });
    await waitFor(() => expect(enabled('Open Claude Code')).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Claude Code' }));
    });
    expect(screen.getByText('osascript is not available')).toBeDefined();
  });

  it('keeps asking while it is open, because the answer changes on its own', async () => {
    vi.useFakeTimers();
    try {
      const handles = panel();
      await vi.advanceTimersByTimeAsync(10);
      const first = handles.load.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_100);
      expect(handles.load.mock.calls.length).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how long ago in the roughest terms that are still true', async () => {
    panel({ health: { ...HEALTH, lastCallAt: Date.now() - 500 } });
    await waitFor(() => expect(screen.getByText(/last just now/u)).toBeDefined());
  });

  it('counts one call as one call', async () => {
    panel({ health: { ...HEALTH, calls: 1, lastCallAt: Date.now() - 200_000 } });
    await waitFor(() => expect(screen.getByText(/1 call, last 3m ago/u)).toBeDefined());
  });

  it('says when nothing has asked for anything yet', async () => {
    panel({ health: { ...HEALTH, calls: 0, lastCallAt: null, attached: 0 } });
    await waitFor(() => expect(screen.getByText(/nothing has asked yet/u)).toBeDefined());
    expect(screen.getByText(/not attached/u)).toBeDefined();
  });

  it('rounds a long silence to hours, and says nothing certain about none', async () => {
    panel({ health: { ...HEALTH, lastCallAt: Date.now() - 3 * 60 * 60 * 1000 } });
    await waitFor(() => expect(screen.getByText(/last 3h ago/u)).toBeDefined());
  });

  it('falls back to a plain "done" when the machine said nothing in particular', async () => {
    panel({ answer: {} });
    await waitFor(() => expect(enabled('Open Claude Code')).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Claude Code' }));
    });
    expect(screen.getByText('Done.')).toBeDefined();
  });

  it('finds the desktop application without a pairing', async () => {
    panel({
      claude: {
        ...CLAUDE,
        cli: { found: false, paired: false },
        desktop: { found: true, configPath: '/c.json', paired: false },
      },
    });
    await waitFor(() => expect(screen.getByText('found, not paired')).toBeDefined());
    // There is something to pair, even with no command on the PATH.
    expect(enabled('Pair with Claude')).toBe(true);
  });

  it('says which Claude the button will open', async () => {
    panel({
      claude: {
        ...CLAUDE,
        desktop: { found: true, configPath: '/c.json', paired: false },
      },
    });
    // Both installed: the app is what "open Claude" means, so the button says so.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open Claude app' })).toBeDefined(),
    );
  });

  /**
   * Which Panorama am I running — the question somebody asks the moment they are
   * told a newer one is ready. Shown whether or not the agent interface is there,
   * because it is as true in a build as in development.
   */
  it('says which version this is', async () => {
    panel({ version: '0.1.0' });
    await waitFor(() => expect(screen.getByText('Version')).toBeDefined());
    expect(screen.getByText('0.1.0')).toBeDefined();
  });

  /** Nothing said is a missing row, not a row saying nothing. */
  it('says nothing about a version it was not given', async () => {
    panel({});
    await waitFor(() => expect(screen.getByText('Agent endpoint')).toBeDefined());
    expect(screen.queryByText('Version')).toBeNull();
  });

  it('reports a pairing that is already done', async () => {
    panel({
      claude: {
        ...CLAUDE,
        cli: { found: true, paired: true },
        desktop: { found: true, configPath: '/c.json', paired: true },
      },
    });
    await waitFor(() => expect(screen.getAllByText('paired')).toHaveLength(2));
  });
});
