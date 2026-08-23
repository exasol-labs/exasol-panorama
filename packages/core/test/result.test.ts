import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from '@panorama/core';

describe('Result', () => {
  it('wraps successes and failures', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('bad')).toEqual({ ok: false, error: 'bad' });
  });

  it('narrows with the type guards', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err('bad'))).toBe(false);
    expect(isErr(err('bad'))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it('unwraps successes and throws on failures', () => {
    expect(unwrap(ok(42))).toBe(42);
    expect(() => unwrap(err({ code: 'nope' }))).toThrow(/nope/);
  });
});
