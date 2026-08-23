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
