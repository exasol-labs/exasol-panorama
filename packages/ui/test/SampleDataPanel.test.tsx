import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SampleDataPanel } from '@panorama/ui';

const tables = [
  { name: 'SAMPLE_100', rowCount: 100, columnCount: 4 },
  { name: 'SALES', rowCount: 2_830_000_000, columnCount: 4 },
  { name: 'VERY_WIDE', rowCount: 100, columnCount: 5_000 },
  { name: 'MID', rowCount: 250_000, columnCount: 12 },
];

describe('SampleDataPanel', () => {
  it('lists the built-in relations with compact dimensions', () => {
    render(<SampleDataPanel tables={tables} onOpen={() => {}} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('100 × 4')).toBeDefined();
    expect(screen.getByText('2.83B × 4')).toBeDefined();
    // Five thousand columns, not `5.00K` of them: the exact figure is no wider.
    expect(screen.getByText('100 × 5,000')).toBeDefined();
    expect(screen.getByText('250K × 12')).toBeDefined();
  });

  it('reports the chosen relation', () => {
    const onOpen = vi.fn();
    render(<SampleDataPanel tables={tables} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('SALES'));
    expect(onOpen).toHaveBeenCalledWith('SALES');
  });
});
