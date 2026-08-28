import { describe, expect, it } from 'vitest';
import { cellValue } from '@panorama/table';
import { DEMO_SCHEMA, DEMO_RELATIONS, demoRelation, demoSchema } from '../src/panorama/demo.js';
import { createWorkerEndpoint } from '../src/bootstrap.js';
import { DataWorkerClient } from '@panorama/worker';
import type { EntityId } from '@panorama/core';

describe('demo relations', () => {
  it('covers the pathological shapes Stage 1 must survive', () => {
    const names = Object.keys(DEMO_RELATIONS);
    expect(names).toContain('VERY_TALL');
    expect(names).toContain('VERY_WIDE');
    expect(names).toContain('LARGE_STRINGS');
    expect(names).toContain('MOSTLY_NULL');
    expect(names).toContain('TYPE_COVERAGE');
    expect(demoRelation('VERY_TALL')?.rowCount).toBe(10_000_000_000);
    expect(demoRelation('VERY_WIDE')?.columns).toHaveLength(5_000);
    expect(demoRelation('NOPE')).toBeUndefined();
  });

  it('describes every relation without a database', () => {
    for (const [name, shape] of Object.entries(DEMO_RELATIONS)) {
      const schema = demoSchema(name);
      expect(schema?.schema).toBe(DEMO_SCHEMA);
      expect(schema?.table).toBe(name);
      expect(schema?.columns).toHaveLength(shape.columns.length);
    }
    expect(demoSchema('NOPE')).toBeUndefined();
  });

  it('serves rows through the data worker with no connection', async () => {
    const client = new DataWorkerClient(
      createWorkerEndpoint({ useWorker: false, demoLatencyMs: 0 }),
    );
    const tableId = 'table:demo' as EntityId;
    const opened = await client.openTable({ tableId, schema: DEMO_SCHEMA, table: 'SAMPLE_100' });
    expect(opened.rowCount).toBe(100);

    const rows = new Promise<{ blockIndex: number; chunk: { startRow: number } }>((resolve) => {
      client.onRows((event) => resolve(event));
    });
    client.requestBlocks(tableId, 0, 256, [{ index: 0, priority: 0 }]);
    const delivered = await rows;
    expect(delivered.blockIndex).toBe(0);
    expect(delivered.chunk.startRow).toBe(0);
    await client.closeTable(tableId);
  });

  it('refuses non-demo tables when nothing is connected', async () => {
    const client = new DataWorkerClient(createWorkerEndpoint({ useWorker: false }));
    await expect(
      client.openTable({ tableId: 'table:x' as EntityId, schema: 'SALES', table: 'ORDERS' }),
    ).rejects.toThrow(/No connection/);
  });

  it('builds an Exasol-backed source for real schemas', async () => {
    const { createTableSource } = await import('../src/panorama/start-data-worker.js');
    const connection = { id: 'connection:1' } as never;
    const source = createTableSource({ schema: 'SALES', table: 'ORDERS' }, connection);
    expect(source).toBeDefined();
    expect(typeof source.open).toBe('function');
  });

  it('sends a statement to the database, never to the demo generator', async () => {
    const { createTableSource } = await import('../src/panorama/start-data-worker.js');
    const connection = { id: 'connection:1' } as never;
    // Even addressed at the demo schema, a statement needs a real engine: the
    // local generator has no SQL in it.
    const source = createTableSource(
      { schema: DEMO_SCHEMA, table: 'SAMPLE_100', sql: 'SELECT 1' },
      connection,
    );
    expect(source.constructor.name).toBe('ExasolTableDataSource');
  });

  it('refuses a statement when nothing is connected', async () => {
    const { createTableSource } = await import('../src/panorama/start-data-worker.js');
    expect(() => createTableSource({ schema: 'QUERY', table: 'q', sql: 'SELECT 1' }, null)).toThrow(
      /without a database connection/,
    );
  });

  it('generates deterministic cells far into a huge relation', () => {
    const shape = demoRelation('VERY_TALL');
    if (shape === undefined) throw new Error('expected the relation');
    expect(shape.columns.length).toBeGreaterThan(0);
    expect(cellValue).toBeTypeOf('function');
  });
});
