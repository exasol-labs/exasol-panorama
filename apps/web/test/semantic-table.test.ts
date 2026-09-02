import { describe, expect, it } from 'vitest';
import { isTableEntity } from '@panorama/core';
import type { TableEntity } from '@panorama/core';
import { createAppHarness } from './harness.js';

/**
 * Opening a table a semantic model describes.
 *
 * End to end from the workspace's side. Nothing here is told which columns mean
 * anything: the harness serves the layer's own views, and what is asserted is
 * that Panorama reads them on connect and puts the meaning on the box — without
 * changing the columns, their order, or the names a statement has to use.
 */

const opened = async (
  options: {
    semanticLayer?: boolean;
    failStatement?: (sql: string) => boolean;
    renamesColumns?: boolean;
  } = {},
): Promise<TableEntity> => {
  const harness = createAppHarness(options);
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  await harness.settle();
  const tableId = await opening;
  await harness.settle();
  const entity = harness.workspace.core.world.entities.get(tableId);
  if (entity === undefined || !isTableEntity(entity)) throw new Error('no table');
  return entity;
};

const column = (entity: TableEntity, name: string) =>
  entity.columns.find((view) => view.sourceColumn.name === name);

describe('a table a model describes', () => {
  it('carries what the model says, on the column the model named', async () => {
    const entity = await opened({ semanticLayer: true });
    expect(column(entity, 'REVENUE')?.semantic).toEqual({
      kind: 'metric',
      model: 'sales',
      modelId: 1,
      fieldId: 10,
      metricKind: 'SIMPLE',
      aggregation: 'SUM',
      displayName: 'Total Revenue',
      description: 'Net recognized revenue excluding tax',
      format: 'currency',
      certified: true,
    });
    // The database's own name and type are untouched: the meaning is drawn over
    // the column, and a statement written against this box still has to name
    // something the database will recognise.
    expect(column(entity, 'REVENUE')?.sourceColumn.name).toBe('REVENUE');
    // And the columns the model says nothing about are exactly as they were.
    expect(column(entity, 'ORDER_DATE')).not.toHaveProperty('semantic');
    expect(entity.columns.map((view) => view.sourceColumn.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'ORDER_DATE',
      'REVENUE',
    ]);
  });

  /**
   * A draft model's published schema is a schema it *intends* to use. The
   * harness's layer has one naming the same schema as the published model — the
   * shape a live instance had, with three of them — and its meanings describe
   * views it has never written.
   */
  it('takes no notice of a draft claiming the same schema', async () => {
    const entity = await opened({ semanticLayer: true });
    expect(column(entity, 'REVENUE')?.semantic?.displayName).toBe('Total Revenue');
    expect(column(entity, 'REVENUE')?.semantic?.model).toBe('sales');
  });

  /**
   * The state every published semantic view is in until the compile step lands.
   *
   * Its object is a `SEMANTIC_GUARD` stub, so `SELECT * ... LIMIT 0` describes it
   * — which is what opens the box — and any statement that asks for a row is
   * refused. The meaning has to survive that: a box whose rows will not come is
   * exactly the box whose headers are the only thing it has to say.
   */
  it('keeps what the columns mean when the rows will not come', async () => {
    const entity = await opened({ semanticLayer: true, failStatement: () => true });
    expect(column(entity, 'REVENUE')?.semantic?.displayName).toBe('Total Revenue');
    expect(entity.columns).toHaveLength(4);
  });

  /** Nearly every connection. It must cost nothing and change nothing. */
  it('leaves every column alone where there is no semantic layer', async () => {
    const entity = await opened();
    for (const view of entity.columns) expect(view).not.toHaveProperty('semantic');
  });
});

/**
 * A box has to describe the rows it actually got.
 *
 * The columns are built from `describeTable` before a row is asked for, which is
 * what lets the box appear immediately — and for a compiled semantic statement
 * that description is of the *stub view*, `CUSTOMER_REGION`, while the SQL that
 * fetches the rows aliases them `customer_region`.
 *
 * Reading a cell by position works either way, which is why the table looked
 * perfectly right. Everything that resolves a column by *name* silently found
 * nothing: a chart looked its category up with `indexOf('CUSTOMER_REGION')`, got
 * `-1`, and drew every bar against `(null)`.
 */
describe('a box whose statement renamed its columns', () => {
  it('takes the names the rows arrived under', async () => {
    const entity = await opened({ semanticLayer: true, renamesColumns: true });
    expect(entity.columns.map((view) => view.sourceColumn.name)).toEqual([
      'order_id',
      'country',
      'order_date',
      'revenue',
    ]);
  });

  /**
   * And keeps the meaning through the rename, because the layer's names are the
   * published ones and a compiled alias is the same field spelled differently.
   */
  it('keeps what the columns mean through the rename', async () => {
    const entity = await opened({ semanticLayer: true, renamesColumns: true });
    const revenue = entity.columns.find((view) => view.sourceColumn.name === 'revenue');
    expect(revenue?.semantic?.displayName).toBe('Total Revenue');
    expect(revenue?.semantic?.aggregation).toBe('SUM');
  });

  it('leaves a box whose names already agreed exactly as it was', async () => {
    const entity = await opened({ semanticLayer: true });
    expect(entity.columns.map((view) => view.sourceColumn.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'ORDER_DATE',
      'REVENUE',
    ]);
  });
});
