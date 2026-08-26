import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SchemaContents, TableListing } from '@panorama/ui';
import { SchemaExplorer, groupRelations } from '@panorama/ui';

const schemas = [{ name: 'RETAIL' }, { name: 'SALES' }];
const relation = (name: string, kind = 'TABLE'): TableListing => ({ schema: 'SALES', name, kind });
const noop = (): void => {};

const ready = (tables: readonly TableListing[]): SchemaContents => ({ status: 'ready', tables });

const renderTree = (
  contents: ReadonlyMap<string, SchemaContents> = new Map(),
  props: Partial<Parameters<typeof SchemaExplorer>[0]> = {},
): { onExpandSchema: ReturnType<typeof vi.fn>; onOpenTable: ReturnType<typeof vi.fn> } => {
  const onExpandSchema = vi.fn();
  const onOpenTable = vi.fn();
  render(
    <SchemaExplorer
      schemas={schemas}
      contents={contents}
      onExpandSchema={onExpandSchema}
      onOpenTable={onOpenTable}
      {...props}
    />,
  );
  return { onExpandSchema, onOpenTable };
};

const schemaRow = (name: string): HTMLElement =>
  screen.getByRole('button', { expanded: false, name: new RegExp(name, 'u') });

describe('groupRelations', () => {
  it('puts tables first and views after', () => {
    const mixed = [
      relation('ORDERS_V', 'VIEW'),
      relation('ORDERS'),
      relation('CUSTOMERS_V', 'VIEW'),
      relation('CUSTOMERS'),
    ];
    expect(groupRelations(mixed).map((entry) => entry.name)).toEqual([
      'ORDERS',
      'CUSTOMERS',
      'ORDERS_V',
      'CUSTOMERS_V',
    ]);
  });

  it('keeps the order each group arrived in, which the driver already sorted', () => {
    const sorted = [relation('A'), relation('B'), relation('C')];
    expect(groupRelations(sorted).map((entry) => entry.name)).toEqual(['A', 'B', 'C']);
  });

  it('reads the kind case-insensitively, as a database may spell it either way', () => {
    const mixed = [relation('V', 'view'), relation('T', 'table')];
    expect(groupRelations(mixed).map((entry) => entry.name)).toEqual(['T', 'V']);
  });

  it('puts a kind it was not written for last rather than guessing where it goes', () => {
    const mixed = [relation('S', 'SYNONYM'), relation('V', 'VIEW'), relation('T', 'TABLE')];
    expect(groupRelations(mixed).map((entry) => entry.name)).toEqual(['T', 'V', 'S']);
  });

  it('leaves what it was given alone', () => {
    const given = [relation('V', 'VIEW'), relation('T')];
    groupRelations(given);
    expect(given.map((entry) => entry.name)).toEqual(['V', 'T']);
  });
});

describe('SchemaExplorer', () => {
  it('says nothing about a connection unless it is given one', () => {
    renderTree();
    expect(screen.queryByRole('button', { name: /Disconnect/u })).toBeNull();
  });

  it('names the connection it is a tree of, and offers the way off it', () => {
    const onDisconnect = vi.fn();
    renderTree(new Map(), {
      connection: { label: 'exasol.test:8563', detail: 'wss://exasol.test:8563', onDisconnect },
    });
    expect(screen.getByText('exasol.test:8563')).toBeDefined();
    const off = screen.getByRole('button', { name: 'Disconnect from exasol.test:8563' });
    // The whole URL is worth having, but not worth the room: it is the tooltip.
    expect(off.getAttribute('title')).toBe('Disconnect from wss://exasol.test:8563');
    fireEvent.click(off);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    // The indicator is not itself the button: disconnecting is a press on the
    // one control that means it, not on anything that happens to say the host.
    fireEvent.click(screen.getByText('exasol.test:8563'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to the label when there is no URL to show', () => {
    renderTree(new Map(), { connection: { label: 'somewhere', onDisconnect: noop } });
    expect(
      screen.getByRole('button', { name: 'Disconnect from somewhere' }).getAttribute('title'),
    ).toBe('Disconnect from somewhere');
  });

  it('shows only the schemas until one is opened', () => {
    renderTree(new Map([['SALES', ready([relation('ORDERS')])]]));
    expect(screen.getByRole('button', { name: /RETAIL/u })).toBeDefined();
    expect(screen.getByRole('button', { name: /SALES/u })).toBeDefined();
    // Closed, so nothing inside it is on screen even though it is loaded.
    expect(screen.queryByText('ORDERS')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Relations in SALES' })).toBeNull();
  });

  it('reports an opening, and shows what the shell then supplies', () => {
    const { onExpandSchema } = renderTree(new Map([['SALES', ready([relation('ORDERS')])]]));
    fireEvent.click(schemaRow('SALES'));
    expect(onExpandSchema).toHaveBeenCalledWith('SALES');
    expect(within(screen.getByRole('list', { name: 'Relations in SALES' })).getByText('ORDERS'));
  });

  it('says a schema is open, for anything reading the page rather than looking at it', () => {
    renderTree(new Map([['SALES', ready([relation('ORDERS')])]]));
    const row = schemaRow('SALES');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(screen.getByRole('button', { name: /SALES/u }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('closes again, and reports the reopening so a failure can be retried', () => {
    const { onExpandSchema } = renderTree(new Map([['SALES', ready([relation('ORDERS')])]]));
    fireEvent.click(schemaRow('SALES'));
    fireEvent.click(screen.getByRole('button', { name: /SALES/u, expanded: true }));
    expect(screen.queryByText('ORDERS')).toBeNull();
    fireEvent.click(schemaRow('SALES'));
    expect(onExpandSchema).toHaveBeenCalledTimes(2);
  });

  it('keeps several schemas open at once, which is the point of a tree', () => {
    renderTree(
      new Map([
        ['RETAIL', ready([relation('STORES')])],
        ['SALES', ready([relation('ORDERS')])],
      ]),
    );
    fireEvent.click(schemaRow('RETAIL'));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('STORES')).toBeDefined();
    expect(screen.getByText('ORDERS')).toBeDefined();
  });

  it('marks a table and a view differently, and opens either', () => {
    const table = relation('ORDERS');
    const view = relation('ORDERS_V', 'VIEW');
    const { onOpenTable } = renderTree(new Map([['SALES', ready([view, table])]]));
    fireEvent.click(schemaRow('SALES'));

    const rows = within(screen.getByRole('list', { name: 'Relations in SALES' })).getAllByRole(
      'listitem',
    );
    // The table comes first whichever order it arrived in.
    expect(rows.map((row) => row.textContent)).toEqual(['ORDERS', 'ORDERS_V']);
    // One icon each, and not the same one.
    const marks = rows.map((row) => row.querySelector('svg')?.innerHTML);
    expect(marks[0]).toBeDefined();
    expect(marks[1]).toBeDefined();
    expect(marks[0]).not.toBe(marks[1]);

    fireEvent.click(screen.getByText('ORDERS_V'));
    expect(onOpenTable).toHaveBeenCalledWith(view);
  });

  it('spells out a kind it has no icon for', () => {
    renderTree(new Map([['SALES', ready([relation('LEGACY', 'SYNONYM')])]]));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('SYNONYM')).toBeDefined();
    // A table needs no such caption: its icon already says so.
    expect(screen.queryByText('TABLE')).toBeNull();
  });

  it('shows the row count the catalogue reported, abbreviated', () => {
    renderTree(
      new Map([
        [
          'SALES',
          ready([
            { ...relation('ORDERS'), rowCount: 2_830_000_000 },
            { ...relation('SMALL'), rowCount: 1_204 },
            { ...relation('EMPTY'), rowCount: 0 },
          ]),
        ],
      ]),
    );
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('2.83B')).toBeDefined();
    // Not abbreviated: `1.20K` would be no shorter and would say less.
    expect(screen.getByText('1,204')).toBeDefined();
    // A table known to be empty says so, rather than saying nothing.
    expect(screen.getByText('0')).toBeDefined();
  });

  it('shows no count where the database has none', () => {
    renderTree(
      new Map([
        [
          'SALES',
          // A view's count exists only once the view has been run, and a table
          // whose statistics were never gathered has none either.
          ready([relation('ORDERS_V', 'VIEW'), relation('FRESH')]),
        ],
      ]),
    );
    fireEvent.click(schemaRow('SALES'));
    const rows = within(screen.getByRole('list', { name: 'Relations in SALES' })).getAllByRole(
      'listitem',
    );
    expect(rows.every((row) => row.querySelector('.pn-tree__count') === null)).toBe(true);
  });

  it('puts the exact count in the tooltip, beside any comment', () => {
    renderTree(
      new Map([
        [
          'SALES',
          ready([
            { ...relation('ORDERS'), rowCount: 2_830_412, comment: 'One row per order line' },
            { ...relation('BARE'), rowCount: 12 },
          ]),
        ],
      ]),
    );
    fireEvent.click(schemaRow('SALES'));
    // The visible figure is abbreviated so a column of them lines up; the exact
    // one is where it costs no room.
    expect(screen.getByText('ORDERS').closest('button')?.title).toBe(
      '2,830,412 rows · One row per order line',
    );
    expect(screen.getByText('BARE').closest('button')?.title).toBe('12 rows');
  });

  it('offers a comment as the row own tooltip', () => {
    const documented = { ...relation('ORDERS'), comment: 'One row per order line' };
    renderTree(new Map([['SALES', ready([documented])]]));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('ORDERS').closest('button')?.title).toBe('One row per order line');
  });

  it('says a schema is loading, before anything about it is known', () => {
    renderTree(new Map());
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('reports a schema that could not be listed, inside that schema', () => {
    renderTree(new Map([['SALES', { status: 'failed', error: 'insufficient privileges' }]]));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByRole('alert').textContent).toBe('insufficient privileges');
    // The other schema is unaffected.
    expect(screen.getByRole('button', { name: /RETAIL/u })).toBeDefined();
  });

  it('has something to say even when a failure did not', () => {
    renderTree(new Map([['SALES', { status: 'failed' }]]));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByRole('alert').textContent).toBe('Could not list this schema');
  });

  it('says an empty schema is empty rather than showing nothing', () => {
    renderTree(new Map([['SALES', ready([])]]));
    fireEvent.click(schemaRow('SALES'));
    expect(screen.getByText('Nothing in this schema.')).toBeDefined();
  });

  it('says the schemas are still coming', () => {
    render(
      <SchemaExplorer
        schemas={[]}
        contents={new Map()}
        loadingSchemas
        onExpandSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByText('Loading schemas…')).toBeDefined();
    // And does not also claim there are none.
    expect(screen.queryByText('No schemas on this connection.')).toBeNull();
  });

  it('says a connection with no schemas has none', () => {
    render(
      <SchemaExplorer schemas={[]} contents={new Map()} onExpandSchema={noop} onOpenTable={noop} />,
    );
    expect(screen.getByText('No schemas on this connection.')).toBeDefined();
  });

  it('shows errors, with any URL in them clickable', () => {
    render(
      <SchemaExplorer
        schemas={[]}
        contents={new Map()}
        error="see https://docs.test/privileges"
        onExpandSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('see https://docs.test/privileges');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://docs.test/privileges');
  });

  it('hides the error region when there is nothing to report', () => {
    render(
      <SchemaExplorer
        schemas={[]}
        contents={new Map()}
        error=""
        onExpandSchema={noop}
        onOpenTable={noop}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
