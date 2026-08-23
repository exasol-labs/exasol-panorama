import { describe, expect, it } from 'vitest';
import { cellValue } from '@panorama/table';
import {
  MAX_FILTER_SCAN,
  ManualScheduler,
  MockTableDataSource,
  countryRelation,
  factRelation,
  immediateScheduler,
  nullHeavyRelation,
  tallRelation,
  wideRelation,
} from '@panorama/test-support';

describe('MockTableDataSource', () => {
  it('reports the schema and row count of a 10-billion-row relation', async () => {
    const source = new MockTableDataSource({
      relation: tallRelation(),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    expect(session.rowCount).toBe(10_000_000_000);
    expect(session.schema.columns).toHaveLength(4);
    expect(source.relation.table).toBe('VERY_TALL');
  });

  it('generates deterministic values far into a huge relation', async () => {
    const source = new MockTableDataSource({
      relation: tallRelation(),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    const first = await session.fetch({ startPosition: 9_999_999_000, maxRows: 4 });
    const second = await session.fetch({ startPosition: 9_999_999_000, maxRows: 4 });
    expect(first.startRow).toBe(9_999_999_000);
    expect(first.rowCount).toBe(4);
    expect(cellValue(first.columns[0] as never, 0)).toBe(cellValue(second.columns[0] as never, 0));
  });

  it('clamps requests at the end of the relation', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(10),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 8, maxRows: 100 });
    expect(chunk.rowCount).toBe(2);
    expect((await session.fetch({ startPosition: 50, maxRows: 10 })).rowCount).toBe(0);
    expect((await session.fetch({ startPosition: -3, maxRows: 2 })).startRow).toBe(0);
  });

  it('honours a custom value generator, including NULLs', async () => {
    const source = new MockTableDataSource({
      relation: nullHeavyRelation(100),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 0, maxRows: 20 });
    expect(cellValue(chunk.columns[0] as never, 0)).not.toBeNull();
    expect(cellValue(chunk.columns[0] as never, 1)).toBeNull();
  });

  it('handles 5000 columns', async () => {
    const source = new MockTableDataSource({
      relation: wideRelation(5_000),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 0, maxRows: 2 });
    expect(chunk.columns).toHaveLength(5_000);
  });

  it('applies simulated latency', async () => {
    const scheduler = new ManualScheduler();
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      latency: 250,
      scheduler: scheduler.schedule,
    });
    const session = await source.open();
    let settled = false;
    const pending = session.fetch({ startPosition: 0, maxRows: 10 }).then((chunk) => {
      settled = true;
      return chunk;
    });

    scheduler.advance(249);
    await Promise.resolve();
    expect(settled).toBe(false);

    scheduler.advance(1);
    await expect(pending).resolves.toMatchObject({ rowCount: 10 });
    expect(source.stats()).toMatchObject({ fetches: 1, rowsDelivered: 10, failures: 0 });
  });

  it('delivers responses out of order when jitter is configured', async () => {
    const scheduler = new ManualScheduler();
    const source = new MockTableDataSource({
      relation: factRelation(10_000),
      latency: { baseMs: 10, jitterMs: 200 },
      scheduler: scheduler.schedule,
      seed: 3,
    });
    const session = await source.open();
    const completed: number[] = [];
    const requests = [0, 100, 200, 300, 400].map((start) =>
      session.fetch({ startPosition: start, maxRows: 10 }).then((chunk) => {
        completed.push(chunk.startRow);
        return chunk;
      }),
    );
    scheduler.runAll();
    await Promise.all(requests);
    expect(completed).toHaveLength(5);
    expect(completed).not.toEqual([0, 100, 200, 300, 400]);
    expect([...completed].sort((a, b) => a - b)).toEqual([0, 100, 200, 300, 400]);
    expect(source.stats().maxConcurrentFetches).toBe(5);
  });

  it('fails every n-th fetch', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      scheduler: immediateScheduler,
      failure: { everyNth: 2, code: 'connection-lost' },
    });
    const session = await source.open();
    await expect(session.fetch({ startPosition: 0, maxRows: 4 })).resolves.toBeDefined();
    await expect(session.fetch({ startPosition: 4, maxRows: 4 })).rejects.toMatchObject({
      code: 'connection-lost',
    });
    expect(source.stats().failures).toBe(1);
  });

  it('fails the first attempts for a block and then succeeds', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      scheduler: immediateScheduler,
      failure: { firstAttempts: 2 },
    });
    const session = await source.open();
    await expect(session.fetch({ startPosition: 0, maxRows: 4 })).rejects.toMatchObject({
      code: 'fetch-failed',
    });
    await expect(session.fetch({ startPosition: 0, maxRows: 4 })).rejects.toThrow();
    await expect(session.fetch({ startPosition: 0, maxRows: 4 })).resolves.toBeDefined();
  });

  it('honours abort signals', async () => {
    const scheduler = new ManualScheduler();
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      latency: 50,
      scheduler: scheduler.schedule,
    });
    const session = await source.open();
    const controller = new AbortController();
    const pending = session.fetch({ startPosition: 0, maxRows: 4 }, controller.signal);
    controller.abort();
    scheduler.runAll();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects fetches after close, before and after the delay', async () => {
    const scheduler = new ManualScheduler();
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      latency: 50,
      scheduler: scheduler.schedule,
    });
    const session = await source.open();
    const inFlight = session.fetch({ startPosition: 0, maxRows: 4 });
    await source.close();
    scheduler.runAll();
    await expect(inFlight).rejects.toMatchObject({ code: 'session-closed' });
    await expect(session.fetch({ startPosition: 0, maxRows: 4 })).rejects.toMatchObject({
      code: 'session-closed',
    });
    // Closing a closed source is harmless.
    await expect(source.close()).resolves.toBeUndefined();
  });

  it('can hide the row count', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      scheduler: immediateScheduler,
      reportRowCount: false,
    });
    expect((await source.open()).rowCount).toBeNull();
  });

  it('can fail to open at all', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(1_000),
      failOpen: 'permission-denied',
    });
    await expect(source.open()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('defaults to real timers and zero latency', async () => {
    const source = new MockTableDataSource({ relation: factRelation(100) });
    const session = await source.open();
    await expect(session.fetch({ startPosition: 0, maxRows: 2 })).resolves.toMatchObject({
      rowCount: 2,
    });
  });
});

describe('filtering', () => {
  it('exposes only the matching rows, renumbered from zero', async () => {
    const source = new MockTableDataSource({
      relation: countryRelation(),
      scheduler: immediateScheduler,
      filter: { column: 'NAME', value: 'Denmark' },
    });
    const session = await source.open();
    expect(session.rowCount).toBe(1);

    const chunk = await session.fetch({ startPosition: 0, maxRows: 10 });
    expect(chunk.rowCount).toBe(1);
    expect(cellValue(chunk.columns[0] as never, 0)).toBe('Denmark');
    expect(cellValue(chunk.columns[1] as never, 0)).toBe('DEN');
  });

  it('reports no rows when nothing matches', async () => {
    const source = new MockTableDataSource({
      relation: countryRelation(),
      scheduler: immediateScheduler,
      filter: { column: 'NAME', value: 'Atlantis' },
    });
    expect((await source.open()).rowCount).toBe(0);
  });

  it('refuses to scan a relation too large to filter honestly', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(MAX_FILTER_SCAN + 1),
      filter: { column: 'COUNTRY', value: 'Germany' },
    });
    await expect(source.open()).rejects.toThrow(/will not scan/);
  });

  it('rejects a filter on a column that does not exist', async () => {
    const source = new MockTableDataSource({
      relation: countryRelation(),
      filter: { column: 'NOPE', value: 'x' },
    });
    await expect(source.open()).rejects.toMatchObject({ code: 'not-found' });
  });

  it('leaves an unfiltered session numbering rows as the relation does', async () => {
    const source = new MockTableDataSource({
      relation: countryRelation(),
      scheduler: immediateScheduler,
    });
    const session = await source.open();
    expect(session.rowCount).toBe(5);
    const chunk = await session.fetch({ startPosition: 1, maxRows: 1 });
    expect(cellValue(chunk.columns[0] as never, 0)).toBe('Denmark');
  });
});

describe('foreign keys in generated relations', () => {
  it('declares the key that makes the demo followable', async () => {
    const source = new MockTableDataSource({
      relation: factRelation(10),
      scheduler: immediateScheduler,
    });
    const country = (await source.open()).schema.columns.find(
      (column) => column.name === 'COUNTRY',
    );
    expect(country?.foreignKey).toMatchObject({ table: 'COUNTRIES', column: 'NAME' });
  });
});
