import { describe, expect, it } from 'vitest';
import { injectedStartup, readStartupConnection } from '../src/panorama/startup.js';

describe('reading startup connection details', () => {
  it('reports nothing configured when there is no URL', () => {
    expect(readStartupConnection({})).toBeNull();
    expect(readStartupConnection({ PANORAMA_EXASOL_USER: 'sys' })).toBeNull();
    // A variable exported as an empty string is not a configured one.
    expect(readStartupConnection({ PANORAMA_EXASOL_URL: '   ' })).toBeNull();
  });

  it('prefills the form from a URL alone, without connecting', () => {
    const startup = readStartupConnection({
      PANORAMA_EXASOL_URL: 'wss://db.internal:8563',
      PANORAMA_EXASOL_USER: 'analyst',
    });
    expect(startup).toMatchObject({ url: 'wss://db.internal:8563', username: 'analyst' });
    // Nothing to connect with, so nothing is attempted.
    expect(startup?.autoConnect).toBe(false);
    expect(startup?.credentials).toBeUndefined();
  });

  it('connects straight away once a password is supplied', () => {
    const startup = readStartupConnection({
      PANORAMA_EXASOL_URL: 'wss://db:8563',
      PANORAMA_EXASOL_USER: 'analyst',
      PANORAMA_EXASOL_PASSWORD: 'hunter2',
    });
    expect(startup?.autoConnect).toBe(true);
    expect(startup?.credentials).toEqual({
      kind: 'password',
      username: 'analyst',
      password: 'hunter2',
    });
  });

  it('assumes the conventional user when only a password is given', () => {
    const startup = readStartupConnection({
      PANORAMA_EXASOL_URL: 'wss://db:8563',
      PANORAMA_EXASOL_PASSWORD: 'hunter2',
    });
    expect(startup?.credentials).toEqual({
      kind: 'password',
      username: 'sys',
      password: 'hunter2',
    });
  });

  it('prefers a token, which is the more specific choice', () => {
    const startup = readStartupConnection({
      PANORAMA_EXASOL_URL: 'wss://db:8563',
      PANORAMA_EXASOL_PASSWORD: 'hunter2',
      PANORAMA_EXASOL_TOKEN: 'tok',
    });
    expect(startup?.credentials).toEqual({ kind: 'token', token: 'tok' });
  });

  it('can be told to prefill but not connect', () => {
    for (const off of ['0', 'false', 'FALSE', 'no']) {
      const startup = readStartupConnection({
        PANORAMA_EXASOL_URL: 'wss://db:8563',
        PANORAMA_EXASOL_PASSWORD: 'hunter2',
        PANORAMA_EXASOL_AUTOCONNECT: off,
      });
      expect(startup?.autoConnect).toBe(false);
      // The secret is still there; it simply is not used yet.
      expect(startup?.credentials).toBeDefined();
    }
  });

  it('names a table to open, but only when both halves are given', () => {
    const base = { PANORAMA_EXASOL_URL: 'wss://db:8563' };
    expect(
      readStartupConnection({
        ...base,
        PANORAMA_EXASOL_SCHEMA: 'SALES',
        PANORAMA_EXASOL_TABLE: 'ORDERS',
      })?.open,
    ).toEqual({ schema: 'SALES', table: 'ORDERS' });
    // Half a table name would be a silent surprise; it is ignored.
    expect(
      readStartupConnection({ ...base, PANORAMA_EXASOL_SCHEMA: 'SALES' })?.open,
    ).toBeUndefined();
    expect(
      readStartupConnection({ ...base, PANORAMA_EXASOL_TABLE: 'ORDERS' })?.open,
    ).toBeUndefined();
  });

  it('trims the surrounding whitespace a shell export tends to carry', () => {
    expect(
      readStartupConnection({
        PANORAMA_EXASOL_URL: '  wss://db:8563  ',
        PANORAMA_EXASOL_USER: ' sys ',
      }),
    ).toMatchObject({ url: 'wss://db:8563', username: 'sys' });
  });
});

describe('the injected value', () => {
  it('reads as "nothing configured" when the build replaced it with null', () => {
    // Which is exactly what a production build is given.
    expect(injectedStartup()).toBeNull();
  });
});
