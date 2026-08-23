import { describe, expect, it } from 'vitest';
import { TableDataError, columnIndexByName, isRetryable, isTableDataError } from '@panorama/table';
import { testSchema } from './fixtures.js';

describe('columnIndexByName', () => {
  it('finds columns by name', () => {
    expect(columnIndexByName(testSchema, 'COUNTRY')).toBe(1);
    expect(columnIndexByName(testSchema, 'MISSING')).toBe(-1);
  });
});

describe('TableDataError', () => {
  it('carries a machine-readable code and cause', () => {
    const cause = new Error('socket closed');
    const error = new TableDataError('connection-lost', 'Connection lost', cause);
    expect(error.name).toBe('TableDataError');
    expect(error.code).toBe('connection-lost');
    expect(error.cause).toBe(cause);
    expect(isTableDataError(error)).toBe(true);
    expect(isTableDataError(cause)).toBe(false);
  });

  it('classifies retryable failures', () => {
    expect(isRetryable(new TableDataError('fetch-failed', 'x'))).toBe(true);
    expect(isRetryable(new TableDataError('connection-lost', 'x'))).toBe(true);
    expect(isRetryable(new TableDataError('permission-denied', 'x'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});
