import { describe, expect, it } from 'vitest';
import {
  connectionLabel,
  formatBytes,
  formatCompactCount,
  formatCount,
  formatMs,
} from '@panorama/ui';

describe('formatCompactCount', () => {
  it('abbreviates at each thousand, keeping two digits of detail below ten', () => {
    expect(formatCompactCount(2_830_000_000)).toBe('2.83B');
    expect(formatCompactCount(10_000_000_000)).toBe('10B');
    expect(formatCompactCount(1_500_000)).toBe('1.50M');
    expect(formatCompactCount(100_000)).toBe('100K');
    expect(formatCompactCount(2_500_000_000_000)).toBe('2.50T');
  });

  it('leaves a figure alone where abbreviating it would buy no room', () => {
    // `1.20K` is exactly as wide as `1,204` and says less.
    expect(formatCompactCount(1_204)).toBe('1,204');
    expect(formatCompactCount(9_999)).toBe('9,999');
    // From ten thousand it does buy room: three characters instead of six.
    expect(formatCompactCount(10_000)).toBe('10K');
  });

  it('spells small counts out in full, including nothing at all', () => {
    expect(formatCompactCount(947)).toBe('947');
    expect(formatCompactCount(1)).toBe('1');
    // A table known to be empty is a fact worth showing.
    expect(formatCompactCount(0)).toBe('0');
  });

  it('refuses to invent a figure from one that is not a number', () => {
    expect(formatCompactCount(Number.NaN)).toBe('—');
    expect(formatCompactCount(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatCompactCount(-1)).toBe('—');
  });
});

describe('the other display helpers', () => {
  it('formats bytes at each binary step', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1_024 * 1_024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('—');
  });

  it('formats milliseconds and counts', () => {
    expect(formatMs(1.234)).toBe('1.2 ms');
    expect(formatMs(250)).toBe('250 ms');
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatCount(2_830_412)).toBe('2,830,412');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('connectionLabel', () => {
  it('names a database by host and port', () => {
    // The port stays: two databases on one machine differ by nothing else.
    expect(connectionLabel('wss://exasol.test:8563')).toBe('exasol.test:8563');
    expect(connectionLabel('wss://exasol.test:8563/path')).toBe('exasol.test:8563');
  });

  it('gives back what it was given when that is not a URL', () => {
    // The string the user typed, which they will recognise — an apology in its
    // place would only hide the typo they are looking for.
    expect(connectionLabel('not a url')).toBe('not a url');
    expect(connectionLabel('')).toBe('');
    // Parseable, but with no host to name.
    expect(connectionLabel('file:///tmp/db')).toBe('file:///tmp/db');
  });
});
