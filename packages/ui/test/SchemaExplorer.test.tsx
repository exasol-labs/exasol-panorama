import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SchemaExplorer } from '@panorama/ui';

const schemas = [{ name: 'RETAIL' }, { name: 'SALES' }];
const tables = [
  { schema: 'SALES', name: 'ORDERS', kind: 'TABLE' },
  { schema: 'SALES', name: 'ORDERS_V', kind: 'VIEW' },
];
const noop = (): void => {};

describe('SchemaExplorer', () => {
  it('lists schemas and reports the chosen one', () => {
    const onSelectSchema = vi.fn();
    render(
      <SchemaExplorer
        schemas={schemas}
        tables={[]}
        selectedSchema={null}
        onSelectSchema={onSelectSchema}
        onOpenTable={noop}
      />,
    );
    fireEvent.change(screen.getByLabelText('Schema'), { target: { value: 'SALES' } });
    expect(onSelectSchema).toHaveBeenCalledWith('SALES');
    expect(screen.getByText('Choose a schema')).toBeDefined();
  });

  it('lists tables and views, and opens one', () => {
    const onOpenTable = vi.fn();
    render(
      <SchemaExplorer
        schemas={schemas}
        tables={tables}
        selectedSchema="SALES"
        onSelectSchema={noop}
        onOpenTable={onOpenTable}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('VIEW')).toBeDefined();
    fireEvent.click(screen.getByText('ORDERS'));
    expect(onOpenTable).toHaveBeenCalledWith(tables[0]);
  });

  it('shows loading states', () => {
    const { rerender } = render(
      <SchemaExplorer
        schemas={[]}
        tables={[]}
        selectedSchema={null}
        loadingSchemas
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByText('Loading…')).toBeDefined();
    expect((screen.getByLabelText('Schema') as HTMLSelectElement).disabled).toBe(true);

    rerender(
      <SchemaExplorer
        schemas={schemas}
        tables={[]}
        selectedSchema="SALES"
        loadingTables
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByText('Loading tables…')).toBeDefined();
  });

  it('reports an empty schema only once loading has finished', () => {
    const { rerender } = render(
      <SchemaExplorer
        schemas={schemas}
        tables={[]}
        selectedSchema="SALES"
        loadingTables
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.queryByText('No tables in this schema.')).toBeNull();

    rerender(
      <SchemaExplorer
        schemas={schemas}
        tables={[]}
        selectedSchema="SALES"
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByText('No tables in this schema.')).toBeDefined();
  });

  it('shows errors', () => {
    render(
      <SchemaExplorer
        schemas={[]}
        tables={[]}
        selectedSchema={null}
        error="insufficient privileges"
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('insufficient privileges');
  });

  it('hides the error region when there is nothing to report', () => {
    render(
      <SchemaExplorer
        schemas={[]}
        tables={[]}
        selectedSchema={null}
        error=""
        onSelectSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
