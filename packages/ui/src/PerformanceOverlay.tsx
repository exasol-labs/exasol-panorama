import { formatBytes, formatCount, formatMs } from './format.js';
import type { PerformanceMetrics } from './types.js';

/**
 * The development performance overlay.
 *
 * Stage 1 ships with this on purpose: the frame budget is a design constraint,
 * and a number you cannot see is a number nobody defends.
 */

export interface PerformanceOverlayProps {
  readonly metrics: PerformanceMetrics;
  readonly visible: boolean;
  readonly onToggle: () => void;
  /** Frame-time budget in milliseconds; exceeding it is highlighted. */
  readonly cpuBudgetMs?: number;
}

interface Row {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}

export const PerformanceOverlay = ({
  metrics,
  visible,
  onToggle,
  cpuBudgetMs = 8,
}: PerformanceOverlayProps): React.JSX.Element => {
  if (!visible) {
    return (
      <button type="button" className="pn-overlay__toggle" onClick={onToggle}>
        {metrics.fps.toFixed(0)} fps
      </button>
    );
  }

  const rows: readonly Row[] = [
    { label: 'FPS', value: metrics.fps.toFixed(1), warn: metrics.fps > 0 && metrics.fps < 55 },
    { label: 'Frame CPU', value: formatMs(metrics.cpuMs), warn: metrics.cpuMs > cpuBudgetMs },
    { label: 'Frame CPU avg', value: formatMs(metrics.averageCpuMs) },
    {
      label: 'Frame CPU worst',
      value: formatMs(metrics.worstCpuMs),
      warn: metrics.worstCpuMs > cpuBudgetMs * 2,
    },
    { label: 'Draw calls', value: formatCount(metrics.drawCalls) },
    { label: 'Backend', value: metrics.backend },
    { label: 'Tables', value: formatCount(metrics.tables) },
    { label: 'Visible rows', value: formatCount(metrics.visibleRows) },
    { label: 'Rendered rows', value: formatCount(metrics.renderedRows) },
    { label: 'Visible columns', value: formatCount(metrics.visibleColumns) },
    { label: 'Glyphs', value: formatCount(metrics.glyphs) },
    {
      label: 'Placeholder cells',
      value: formatCount(metrics.placeholderCells),
      warn: metrics.placeholderCells > 0,
    },
    { label: 'Cache blocks', value: formatCount(metrics.cacheBlocks) },
    { label: 'Cache bytes', value: formatBytes(metrics.cacheBytes) },
    { label: 'Cache evictions', value: formatCount(metrics.cacheEvictions) },
    { label: 'Fetches pending', value: formatCount(metrics.fetchesPending) },
    { label: 'Fetches completed', value: formatCount(metrics.fetchesCompleted) },
    { label: 'Last fetch', value: formatMs(metrics.lastFetchMs) },
    { label: 'Average fetch', value: formatMs(metrics.averageFetchMs) },
  ];

  return (
    <aside className="pn-overlay" aria-label="Performance">
      <button type="button" className="pn-overlay__toggle" onClick={onToggle}>
        Hide
      </button>
      <dl>
        {rows.map((row) => (
          <div key={row.label} className={row.warn === true ? 'pn-overlay__row--warn' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
};
