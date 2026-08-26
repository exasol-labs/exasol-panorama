/** Small display helpers shared by the shell. */

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] as string}`;
};

export const formatMs = (milliseconds: number): string =>
  Number.isFinite(milliseconds) ? `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)} ms` : '—';

export const formatCount = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString('en-US') : '—';

/** Below this an abbreviation is no shorter than the figure it replaces. */
const ABBREVIATE_FROM = 10_000;

/** Units above a thousand. Thousands need no entry: see below. */
const COUNT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
];

/** Two significant decimals below ten, none above: `2.83B`, then `10B`. */
const abbreviate = (scaled: number, suffix: string): string =>
  `${scaled.toFixed(scaled >= 10 ? 0 : 2)}${suffix}`;

/**
 * A count short enough to sit at the end of a row: `2.83B`, `250K`, `1,204`.
 *
 * Two significant decimals below ten and none above, so a column of these lines
 * up at a glance without any of them being longer than the name beside it.
 *
 * Nothing under ten thousand is abbreviated. `1.20K` is exactly as wide as
 * `1,204` and says less, and the whole point of shortening a number is to buy
 * room — a trade that stops paying once there is no room to buy.
 */
export const formatCompactCount = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '—';
  const rounded = Math.round(value);
  if (rounded < ABBREVIATE_FROM) return rounded.toLocaleString('en-US');
  for (const [size, suffix] of COUNT_UNITS) {
    if (rounded >= size) return abbreviate(rounded / size, suffix);
  }
  // Whatever is left is at least ten thousand and under a million, so thousands
  // is the only unit it can land in — no test for it, and no branch either.
  return abbreviate(rounded / 1e3, 'K');
};

/**
 * How a connection is named in the explorer: the host it is to.
 *
 * Host and port rather than the whole URL: what a person needs from a connection
 * indicator is *which database*, and `wss://` is the part that is the same on
 * every connection anyone makes to one. The port stays, because two databases on
 * one machine differ by nothing else. The full URL is still worth having, so the
 * indicator keeps it as the tooltip.
 *
 * A URL that cannot be parsed comes back whole rather than as an apology: it is
 * the string the user typed, and they will recognise it.
 */
export const connectionLabel = (url: string): string => {
  try {
    const host = new URL(url).host;
    return host === '' ? url : host;
  } catch {
    return url;
  }
};
