import { describe, expect, it } from 'vitest';
import { agentEndpointOrigin, databaseSocketUrl, inDesktopShell } from '../src/panorama/shell.js';

/**
 * One build is packaged two ways, so the difference between them is a runtime
 * question. Both answers matter: a browser that is mistaken for the shell loses
 * its offline launch, and a shell that is mistaken for a browser caches its own
 * bundle and starts serving yesterday's.
 */
describe('telling the desktop application from a browser', () => {
  it('is the shell when the shell has announced itself', () => {
    expect(inDesktopShell({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it('is a browser otherwise', () => {
    expect(inDesktopShell({})).toBe(false);
  });

  it('reads the current global when it is not told where to look', () => {
    expect(inDesktopShell()).toBe(false);
  });
});

describe('where the agent endpoint is', () => {
  const browser = {};
  const shell = { __TAURI_INTERNALS__: {} };

  it('is the origin the page came from, in a browser', () => {
    expect(
      agentEndpointOrigin({ protocol: 'https:', origin: 'https://panorama.example' }, browser),
    ).toBe('https://panorama.example');
  });

  /**
   * The endpoint is a development-server route, so a deployed origin answers
   * nothing — which is a stream that never opens, not a page that fails to start.
   */
  it('is the origin even where nothing will answer', () => {
    expect(
      agentEndpointOrigin({ protocol: 'https:', origin: 'https://pages.example' }, browser),
    ).toBe('https://pages.example');
  });

  /**
   * The case this exists for: an event stream against a custom scheme throws
   * where it is constructed, and this runs at module scope.
   */
  it('is nowhere when the desktop application served its own document', () => {
    expect(agentEndpointOrigin({ protocol: 'tauri:', origin: 'tauri://localhost' }, shell)).toBe(
      null,
    );
  });

  it('is the development server when the desktop window was pointed at one', () => {
    expect(agentEndpointOrigin({ protocol: 'http:', origin: 'http://localhost:5173' }, shell)).toBe(
      'http://localhost:5173',
    );
  });
});

describe('the socket a database connection opens', () => {
  it('is the shell’s own, carrying the database it is for', () => {
    expect(
      databaseSocketUrl('ws://127.0.0.1:7356/database?token=abc', 'wss://localhost:8563'),
    ).toBe('ws://127.0.0.1:7356/database?token=abc&target=wss%3A%2F%2Flocalhost%3A8563');
  });

  /**
   * The target is escaped, not concatenated: a URL with a query of its own would
   * otherwise arrive at the shell as several parameters, and the shell would
   * forward to whichever it read last.
   */
  it('escapes the database URL, whatever is in it', () => {
    const composed = databaseSocketUrl(
      'ws://127.0.0.1:7356/database?token=abc',
      'wss://db.internal:8563/?token=stolen&x=1',
    );
    expect(composed.split('target=')[1]).toBe(
      encodeURIComponent('wss://db.internal:8563/?token=stolen&x=1'),
    );
    expect(composed.split('&').length).toBe(2);
  });

  it('opens the query string when the shell gave none', () => {
    expect(databaseSocketUrl('ws://127.0.0.1:7356/database', 'ws://x:1')).toBe(
      'ws://127.0.0.1:7356/database?target=ws%3A%2F%2Fx%3A1',
    );
  });
});
