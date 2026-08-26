import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ExportListing } from '@panorama/ui';
import { ExportPanel } from '@panorama/ui';

const listing = (patch: Partial<ExportListing> = {}): ExportListing => ({
  id: 1,
  tableName: 'SALES.ORDERS',
  fileName: 'SALES.ORDERS.parquet',
  formatLabel: 'Parquet',
  status: 'running',
  rows: 250,
  bytes: 4_096,
  totalRows: 1_000,
  ...patch,
});

describe('ExportPanel', () => {
  it('stays out of the way until something has been exported', () => {
    const { container } = render(
      <ExportPanel exports={[]} onCancel={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('names the file, the format and how far it has got', () => {
    render(<ExportPanel exports={[listing()]} onCancel={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('SALES.ORDERS.parquet')).toBeTruthy();
    expect(screen.getByText('Parquet')).toBeTruthy();
    expect(screen.getByText(/25% · 250 of 1,000 rows · 4.0 KB/u)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
  });

  it('shows a count rather than a percentage when the total is unknown', () => {
    render(
      <ExportPanel
        exports={[listing({ totalRows: null })]}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/250 rows · 4.0 KB/u)).toBeTruthy();
    // No fabricated position: the bar has no value to report.
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('offers a way to stop a running export', async () => {
    const onCancel = vi.fn();
    render(<ExportPanel exports={[listing()]} onCancel={onCancel} onDismiss={vi.fn()} />);
    screen.getByRole('button', { name: 'Stop' }).click();
    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it('offers a way to clear a finished one, and reports how it ended', () => {
    const onDismiss = vi.fn();
    render(
      <ExportPanel
        exports={[
          listing({ id: 1, status: 'done', rows: 1_000, bytes: 2_048_000 }),
          listing({ id: 2, status: 'cancelled' }),
          listing({ id: 3, status: 'failed', error: 'The disk is full' }),
        ]}
        onCancel={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText(/Saved · 100%/u)).toBeTruthy();
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The disk is full');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    screen.getAllByRole('button', { name: 'Dismiss' })[0]?.click();
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('fills the bar completely once the file is saved', () => {
    render(
      <ExportPanel
        exports={[listing({ status: 'done', totalRows: null })]}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});
