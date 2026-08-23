import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PerformanceMetrics } from '@panorama/ui';
import { PerformanceOverlay, formatBytes, formatCount, formatMs } from '@panorama/ui';

const metrics: PerformanceMetrics = {
  fps: 59.8,
  cpuMs: 2.4,
  averageCpuMs: 2.1,
  worstCpuMs: 6.2,
  drawCalls: 2,
  tables: 1,
  visibleRows: 34,
  renderedRows: 46,
  visibleColumns: 8,
  glyphs: 1_820,
  placeholderCells: 0,
  cacheBlocks: 12,
  cacheBytes: 3_145_728,
  cacheEvictions: 4,
  fetchesPending: 1,
  fetchesCompleted: 87,
  lastFetchMs: 34,
  averageFetchMs: 41.5,
  backend: 'webgpu',
};

describe('PerformanceOverlay', () => {
  it('shows every Stage 1 metric when open', () => {
    render(<PerformanceOverlay metrics={metrics} visible onToggle={() => {}} />);
    for (const label of [
      'FPS',
      'Frame CPU',
      'Draw calls',
      'Backend',
      'Visible rows',
      'Rendered rows',
      'Visible columns',
      'Glyphs',
      'Cache blocks',
      'Cache bytes',
      'Fetches pending',
      'Last fetch',
      'Average fetch',
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText('59.8')).toBeDefined();
    expect(screen.getByText('3.0 MB')).toBeDefined();
    expect(screen.getByText('webgpu')).toBeDefined();
  });

  it('collapses to an FPS badge', () => {
    const onToggle = vi.fn();
    render(<PerformanceOverlay metrics={metrics} visible={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: '60 fps' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Draw calls')).toBeNull();
  });

  it('can be hidden again', () => {
    const onToggle = vi.fn();
    render(<PerformanceOverlay metrics={metrics} visible onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('highlights budget overruns', () => {
    const { container } = render(
      <PerformanceOverlay
        metrics={{ ...metrics, fps: 24, cpuMs: 30, worstCpuMs: 90, placeholderCells: 12 }}
        visible
        onToggle={() => {}}
        cpuBudgetMs={8}
      />,
    );
    expect(container.querySelectorAll('.pn-overlay__row--warn')).toHaveLength(4);
  });

  it('does not warn about a zero FPS reading before the first window closes', () => {
    const { container } = render(
      <PerformanceOverlay metrics={{ ...metrics, fps: 0 }} visible onToggle={() => {}} />,
    );
    expect(container.querySelectorAll('.pn-overlay__row--warn')).toHaveLength(0);
  });
});

describe('formatters', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(150 * 1_024)).toBe('150 KB');
    expect(formatBytes(5 * 1_024 * 1_024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1_024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(5 * 1_024 ** 4)).toBe('5120 GB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('formats milliseconds and counts', () => {
    expect(formatMs(2.44)).toBe('2.4 ms');
    expect(formatMs(120.6)).toBe('121 ms');
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatCount(1_234_567)).toBe('1,234,567');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
