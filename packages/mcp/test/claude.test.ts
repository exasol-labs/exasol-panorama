import { describe, expect, it } from 'vitest';
// The Node half, reached by path: the package's entry is what the page imports,
// and a browser has no machine to look for Claude on.
import type { ClaudeEnvironment } from '../src/claude.js';
import {
  CLAUDE_SERVER_NAME,
  desktopConfigPath,
  inspectClaude,
  openClaude,
  pairClaude,
} from '../src/claude.js';

/**
 * A machine that is not this one.
 *
 * Everything in `claude.ts` looks at somebody's home directory, rewrites a
 * configuration file or starts a program, so it is all reached through this — a
 * machine with whatever is on it that the test says, and a record of what was
 * done to it.
 */
const machine = (
  options: {
    readonly platform?: string;
    readonly cli?: boolean;
    readonly desktopApp?: boolean;
    readonly files?: Record<string, string>;
    readonly cliFails?: boolean;
  } = {},
): ClaudeEnvironment & {
  readonly started: { command: string; args: readonly string[] }[];
  readonly ran: { command: string; args: readonly string[] }[];
  readonly files: Record<string, string>;
} => {
  const files: Record<string, string> = { ...options.files };
  const started: { command: string; args: readonly string[] }[] = [];
  const ran: { command: string; args: readonly string[] }[] = [];
  return {
    started,
    ran,
    files,
    platform: options.platform ?? 'darwin',
    home: '/Users/someone',
    find: (command) =>
      Promise.resolve(
        options.cli === true && command === 'claude' ? '/usr/local/bin/claude' : null,
      ),
    exists: (path) =>
      Promise.resolve(
        (path === '/Applications/Claude.app' && options.desktopApp === true) ||
          files[path] !== undefined,
      ),
    readFile: (path) => Promise.resolve(files[path] ?? null),
    writeFile: (path, contents) => {
      files[path] = contents;
      return Promise.resolve();
    },
    run: (command, args) => {
      ran.push({ command, args });
      return Promise.resolve(
        options.cliFails === true
          ? { code: 1, output: 'error: no such transport' }
          : { code: 0, output: 'Added stdio MCP server' },
      );
    },
    start: (command, args) => {
      started.push({ command, args });
      return Promise.resolve();
    },
  };
};

const DESKTOP_CONFIG =
  '/Users/someone/Library/Application Support/Claude/claude_desktop_config.json';
const PAIRING = { url: 'http://localhost:5173/agent/mcp', bridgeScript: '/repo/bin/agent.mjs' };

describe('what is on this machine', () => {
  it('finds nothing on a machine with nothing', async () => {
    const status = await inspectClaude(machine());
    expect(status.cli).toEqual({ found: false, paired: false });
    expect(status.desktop.found).toBe(false);
    expect(status.canOpenTerminal).toBe(true);
  });

  it('finds the command, and says whether it already knows about this session', async () => {
    const withoutPairing = await inspectClaude(machine({ cli: true }));
    expect(withoutPairing.cli).toEqual({
      found: true,
      path: '/usr/local/bin/claude',
      paired: false,
    });
    const paired = await inspectClaude(
      machine({
        cli: true,
        files: {
          '/Users/someone/.claude.json': JSON.stringify({
            mcpServers: { [CLAUDE_SERVER_NAME]: { type: 'http' } },
          }),
        },
      }),
    );
    expect(paired.cli.paired).toBe(true);
  });

  it('finds the desktop application by its own configuration as well as by the app', async () => {
    expect((await inspectClaude(machine({ desktopApp: true }))).desktop.found).toBe(true);
    const byConfig = await inspectClaude(machine({ files: { [DESKTOP_CONFIG]: '{}' } }));
    expect(byConfig.desktop.found).toBe(true);
    expect(byConfig.desktop.paired).toBe(false);
  });

  it('knows where the configuration lives, and where there is none', () => {
    expect(desktopConfigPath({ platform: 'darwin', home: '/h' })).toContain('Application Support');
    expect(desktopConfigPath({ platform: 'win32', home: '/h' })).toContain('AppData');
    expect(desktopConfigPath({ platform: 'linux', home: '/h' })).toBe('');
    // Nothing to look for, so nothing is claimed.
    expect(desktopConfigPath({ platform: 'freebsd', home: '/h' })).toBe('');
  });

  it('does not take a broken configuration file as an answer', async () => {
    const status = await inspectClaude(machine({ files: { [DESKTOP_CONFIG]: '{oh dear' } }));
    // It exists, so the application is here; what it says is unreadable, so
    // nothing is claimed about pairing.
    expect(status.desktop.found).toBe(true);
    expect(status.desktop.paired).toBe(false);
  });
});

describe('pairing', () => {
  it('asks Claude Code to add the server itself', async () => {
    const box = machine({ cli: true });
    const [outcome] = await pairClaude(box, PAIRING, 'cli');
    expect(box.ran[0]?.args).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'panorama',
      PAIRING.url,
    ]);
    expect(outcome?.done).toBe(true);
    expect(outcome?.detail).toContain('every project');
  });

  it('passes on what Claude Code said when it refuses', async () => {
    const [outcome] = await pairClaude(machine({ cli: true, cliFails: true }), PAIRING, 'cli');
    expect(outcome).toMatchObject({ done: false });
    expect(outcome?.detail).toContain('no such transport');
  });

  it('says so rather than guessing when the command is not there', async () => {
    const [outcome] = await pairClaude(machine(), PAIRING, 'cli');
    expect(outcome?.done).toBe(false);
    expect(outcome?.detail).toContain('not on the PATH');
  });

  it('writes the desktop entry, keeping whatever else was in the file', async () => {
    const box = machine({
      desktopApp: true,
      files: {
        [DESKTOP_CONFIG]: JSON.stringify({
          theme: 'dark',
          mcpServers: { somethingElse: { command: 'other' } },
        }),
      },
    });
    const [outcome] = await pairClaude(box, PAIRING, 'desktop');
    expect(outcome?.done).toBe(true);
    const written = JSON.parse(box.files[DESKTOP_CONFIG] ?? '{}') as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    // It is the user's file: what was there is still there.
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.mcpServers)).toEqual(['somethingElse', 'panorama']);
    expect(written.mcpServers['panorama']).toEqual({
      command: 'node',
      args: [PAIRING.bridgeScript],
      env: { PANORAMA_AGENT_URL: PAIRING.url },
    });
    expect(outcome?.detail).toContain('Restart Claude');
  });

  it('starts a configuration file where there was none', async () => {
    const box = machine({ desktopApp: true });
    await pairClaude(box, PAIRING, 'desktop');
    expect(JSON.parse(box.files[DESKTOP_CONFIG] ?? '{}')).toEqual({
      mcpServers: {
        panorama: {
          command: 'node',
          args: [PAIRING.bridgeScript],
          env: { PANORAMA_AGENT_URL: PAIRING.url },
        },
      },
    });
    // An empty file is the same as no file, and not a parse error.
    const blank = machine({ desktopApp: true, files: { [DESKTOP_CONFIG]: '  ' } });
    expect((await pairClaude(blank, PAIRING, 'desktop'))[0]?.done).toBe(true);
  });

  it('refuses to rewrite a file it cannot read', async () => {
    const box = machine({ files: { [DESKTOP_CONFIG]: 'not json at all' } });
    const [outcome] = await pairClaude(box, PAIRING, 'desktop');
    expect(outcome?.done).toBe(false);
    expect(outcome?.detail).toContain('not valid JSON');
    // Left exactly as it was.
    expect(box.files[DESKTOP_CONFIG]).toBe('not json at all');
  });

  it('says there is no desktop application to pair on this platform', async () => {
    const [outcome] = await pairClaude(machine({ platform: 'linux' }), PAIRING, 'desktop');
    expect(outcome?.detail).toContain('no Claude desktop application on linux');
  });

  it('does both when it is not told which', async () => {
    const outcomes = await pairClaude(machine({ cli: true, desktopApp: true }), PAIRING);
    expect(outcomes.map((outcome) => outcome.target)).toEqual(['cli', 'desktop']);
    expect(outcomes.every((outcome) => outcome.done)).toBe(true);
  });
});

describe('opening', () => {
  it('opens the application when there is one, not the command line', async () => {
    // Somebody who has installed the app means the app by "open Claude"; being
    // put in a terminal they did not ask for is not the same thing.
    const box = machine({ cli: true, desktopApp: true });
    const outcome = await openClaude(box, { cwd: '/repo' });
    expect(outcome.opened).toBe('desktop');
    expect(box.started).toEqual([{ command: 'open', args: ['-a', 'Claude'] }]);
  });

  it('opens the command line when that is asked for, application or not', async () => {
    const box = machine({ cli: true, desktopApp: true });
    const outcome = await openClaude(box, { cwd: '/repo', prefer: 'cli' });
    expect(outcome.opened).toBe('cli');
    expect(box.started[0]?.command).toBe('osascript');
  });

  it('opens whatever there is when what was asked for is not there', async () => {
    // Asked for the app, has only the command line.
    const noApp = machine({ cli: true });
    expect((await openClaude(noApp, { cwd: '/repo', prefer: 'desktop' })).opened).toBe('cli');
    // Asked for the command line, has only the app.
    const noCli = machine({ desktopApp: true });
    expect((await openClaude(noCli, { cwd: '/repo', prefer: 'cli' })).opened).toBe('desktop');
  });

  it('opens Claude Code in a terminal, in the project it is meant to help with', async () => {
    const box = machine({ cli: true });
    const outcome = await openClaude(box, { cwd: '/repo/exasol-panorama' });
    expect(outcome.opened).toBe('cli');
    expect(box.started[0]?.command).toBe('osascript');
    expect(box.started[0]?.args[1]).toContain('cd /repo/exasol-panorama && claude');
    expect(box.started[0]?.args[1]).toContain('activate');
  });

  it('opens the desktop application when that is what was asked for', async () => {
    const box = machine({ cli: true, desktopApp: true });
    const outcome = await openClaude(box, { cwd: '/repo', prefer: 'desktop' });
    expect(outcome.opened).toBe('desktop');
    expect(box.started[0]).toEqual({ command: 'open', args: ['-a', 'Claude'] });
  });

  it('falls back to the desktop application where there is no command', async () => {
    const box = machine({ desktopApp: true });
    expect((await openClaude(box, { cwd: '/repo' })).opened).toBe('desktop');
  });

  it('opens the desktop application on Windows its own way', async () => {
    const box = machine({
      platform: 'win32',
      files: { '/Users/someone/AppData/Roaming/Claude/claude_desktop_config.json': '{}' },
    });
    const outcome = await openClaude(box, { cwd: 'C:/repo' });
    expect(outcome.opened).toBe('desktop');
    expect(box.started[0]?.command).toBe('cmd');
  });

  it('says what to do instead when it cannot open a terminal', async () => {
    const box = machine({ platform: 'linux', cli: true });
    const outcome = await openClaude(box, { cwd: '/repo' });
    expect(outcome.opened).toBeNull();
    expect(outcome.detail).toContain('only implemented on macOS');
    expect(outcome.detail).toContain('/repo');
    expect(box.started).toEqual([]);
  });

  it('says plainly when there is no Claude at all', async () => {
    const outcome = await openClaude(machine(), { cwd: '/repo' });
    expect(outcome).toEqual({ opened: null, detail: 'Claude was not found on this machine.' });
  });
});
