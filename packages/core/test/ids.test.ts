import { describe, expect, it } from 'vitest';
import { MAX_ULID_TIME, createIdFactory, createUlidFactory, idNamespace } from '@panorama/core';
import { seededRandom } from './fixtures.js';

describe('createUlidFactory', () => {
  it('produces 26-character Crockford base32 ids', () => {
    const ulid = createUlidFactory({ now: () => 1_700_000_000_000, random: seededRandom() });
    const value = ulid();
    expect(value).toHaveLength(26);
    expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically by creation time', () => {
    let time = 1_000;
    const ulid = createUlidFactory({ now: () => (time += 1_000), random: seededRandom() });
    const values = [ulid(), ulid(), ulid()];
    expect([...values].sort()).toEqual(values);
  });

  it('stays monotonic within a single millisecond', () => {
    const ulid = createUlidFactory({ now: () => 42, random: () => 0 });
    const first = ulid();
    const second = ulid();
    const third = ulid();
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
  });

  it('carries across base32 digits when incrementing', () => {
    // random() === 1 clamps to the last alphabet character, forcing a full carry.
    const ulid = createUlidFactory({ now: () => 7, random: () => 1 });
    expect(ulid().slice(10)).toBe('Z'.repeat(16));
    expect(ulid().slice(10)).toBe('0'.repeat(16));
  });

  it('rejects timestamps outside the 48-bit range', () => {
    expect(() => createUlidFactory({ now: () => -1 })()).toThrow(RangeError);
    expect(() => createUlidFactory({ now: () => MAX_ULID_TIME + 1 })()).toThrow(RangeError);
    expect(() => createUlidFactory({ now: () => 1.5 })()).toThrow(RangeError);
  });

  it('defaults to the real clock and Math.random', () => {
    const before = Date.now();
    const value = createUlidFactory()();
    expect(value).toHaveLength(26);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });
});

describe('createIdFactory', () => {
  it('namespaces identifiers by object kind', () => {
    const ids = createIdFactory({ now: () => 1, random: seededRandom() });
    expect(ids.entity('table')).toMatch(/^table:[0-9A-Z]{26}$/);
    expect(ids.entity('column')).toMatch(/^column:/);
    expect(ids.connection()).toMatch(/^connection:/);
    expect(ids.commit()).toMatch(/^commit:/);
  });

  it('defaults its ULID source', () => {
    expect(createIdFactory().entity('table')).toMatch(/^table:/);
  });
});

describe('idNamespace', () => {
  it('extracts the prefix', () => {
    expect(idNamespace('table:01J')).toBe('table');
  });

  it('returns null for unprefixed values', () => {
    expect(idNamespace('01J')).toBeNull();
    expect(idNamespace(':leading')).toBeNull();
  });
});
