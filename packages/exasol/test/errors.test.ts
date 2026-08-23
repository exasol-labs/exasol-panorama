import { describe, expect, it } from 'vitest';
import { classifyExasolException, exasolError } from '@panorama/exasol';

describe('classifyExasolException', () => {
  it.each([
    [{ text: 'x', sqlCode: 'R0001' }, 'result-set-expired'],
    [{ text: 'result set 7 not found' }, 'result-set-expired'],
    [{ text: 'Invalid result set handle' }, 'result-set-expired'],
    [{ text: 'insufficient privileges for SELECT' }, 'permission-denied'],
    [{ text: 'operation not allowed' }, 'permission-denied'],
    [{ text: 'Authentication failed' }, 'authentication-failed'],
    [{ text: 'invalid credentials supplied' }, 'authentication-failed'],
    [{ text: 'object SALES.NOPE not found' }, 'not-found'],
    [{ text: 'something else entirely' }, 'fetch-failed'],
  ])('classifies %j', (exception, expected) => {
    expect(classifyExasolException(exception)).toBe(expected);
  });
});

describe('exasolError', () => {
  it('preserves the SQL code in the message and the exception as the cause', () => {
    const exception = { text: 'boom', sqlCode: '42000' };
    const error = exasolError(exception);
    expect(error.message).toBe('boom [42000]');
    expect(error.code).toBe('fetch-failed');
    expect(error.cause).toBe(exception);
  });

  it('omits an absent SQL code', () => {
    expect(exasolError({ text: 'boom' }).message).toBe('boom');
  });
});
