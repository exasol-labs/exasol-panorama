import { describe, expect, it } from 'vitest';
import { buildTableColumns, buildTableEntity, dataType } from '@panorama/core';
import type { TableRenderInput } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  DOCUMENT_TABLE_ACTIONS,
  TABLE_ACTIONS,
  actionsForTable,
  buildTableDrawList,
  summaryPanelSections,
} from '@panorama/renderer';
import { computeColumnLayout, jsonColumnSpecs } from '@panorama/table';
import { jsonFamilyRoot, jsonFamilyTables, relationSchema } from '@panorama/test-support';
import { testIds } from './fixtures.js';

/**
 * A document family, drawn.
 *
 * What is asserted is the *difference between the four states*, because that is
 * the feature: a table where a missing property and an explicit null both come
 * out as one grey dash has thrown away the thing the source went to the trouble
 * of recording. So the tests read the drawn text and the drawn colours, and
 * insist the three kinds of emptiness are three things.
 */

const root = jsonFamilyRoot();
const schema = relationSchema(root);
const ids = testIds();
const specs = jsonColumnSpecs(schema, { siblings: jsonFamilyTables() }) ?? [];

const table = buildTableEntity(ids, {
  source: {
    kind: 'relation',
    connectionId: 'c1' as never,
    schema: 'PANORAMA_JSON',
    table: 'PEOPLE',
    document: true,
  },
  columns: specs,
  size: { width: 1_400, height: 420 },
});

/** The fixture's own rows, read the way the cache would hand them over. */
const data = {
  cell: (row: number, columnIndex: number) =>
    (root.valueFor?.(root.columns[columnIndex]?.type as never, columnIndex, row) ?? null) as never,
};

const drawn = (overrides: Partial<TableRenderInput> = {}) =>
  buildTableDrawList({
    entity: table,
    layout: computeColumnLayout(table.columns),
    theme: DEFAULT_TABLE_THEME,
    lod: 'full',
    scrollTop: 0,
    scrollLeft: 0,
    rowCount: root.rowCount,
    data,
    ...overrides,
  });

const colourOf = (text: string) =>
  drawn()
    .texts.find((run) => run.text === text)
    ?.color.join(',');

describe('drawing a document', () => {
  it('heads the columns with the properties, not the columns they are stored in', () => {
    const texts = drawn().texts.map((run) => run.text);
    for (const property of ['mongo_id', 'name', 'empty_text', 'note', 'value', 'profile', 'tags']) {
      expect(texts, property).toContain(property);
    }
    // The storage is not on screen, though it is still in the result set.
    for (const stored of ['note|n', 'value|string', 'profile|object', 'empty_text|empty']) {
      expect(texts, stored).not.toContain(stored);
    }
  });

  /** The whole point: three kinds of nothing, three different things drawn. */
  it('draws an explicit null, an empty string and a missing property apart', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).toContain('null');
    expect(texts).toContain('""');
    expect(texts).toContain('—');
    const nulls = colourOf('null');
    const empty = colourOf('""');
    const missing = colourOf('—');
    expect(nulls).not.toBe(missing);
    expect(empty).not.toBe(missing);
    expect(nulls).not.toBe(empty);
    // And the one the reader is most likely to misread is the one given a hue
    // rather than another shade of the same grey.
    expect(nulls).toBe(DEFAULT_TABLE_THEME.jsonNullText.join(','));
  });

  it('shows a value from whichever branch the row used, and says which', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).toContain('42');
    expect(texts).toContain('forty-two');
    // The branch, beside the value it qualifies — and only on the branch the
    // column is *not* named after, since the header already says that one.
    expect(texts).toContain('string');
    expect(colourOf('string')).toBe(DEFAULT_TABLE_THEME.jsonBranchTag.join(','));
  });

  it('reads a nested property as what it is, and as somewhere to go', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).toContain('{…}');
    expect(texts).toContain('3 items');
    // A list that is there and empty is not a link, and does not read as one.
    expect(texts).toContain('empty');
    expect(colourOf('3 items')).toBe(DEFAULT_TABLE_THEME.linkText.join(','));
    expect(colourOf('empty')).toBe(DEFAULT_TABLE_THEME.nullText.join(','));
    expect(colourOf('{…}')).toBe(DEFAULT_TABLE_THEME.linkText.join(','));
  });

  /**
   * A cell whose block has not arrived is a fact about the fetch. Drawing it as
   * an absent property would be a claim about the document that the next frame
   * contradicts, so it gets the placeholder every unfetched cell gets.
   */
  it('draws a placeholder, not a dash, for a cell that has not arrived', () => {
    const list = drawn({ data: { cell: () => undefined } });
    expect(list.texts.map((run) => run.text)).not.toContain('—');
    expect(list.stats.placeholderCells).toBeGreaterThan(0);
  });

  it('hides the structural columns, and keeps the list order visible', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).not.toContain('_id');
    expect(table.columns.find((column) => column.sourceColumn.name === '_id')?.visible).toBe(false);
  });
});

describe('the halo of a document table', () => {
  it('offers the switch, and only where there is a document to switch to', () => {
    expect(actionsForTable(table).map((action) => action.action)).toContain('json');
    expect(actionsForTable(table)).toEqual(DOCUMENT_TABLE_ACTIONS);
    const ordinary = buildTableEntity(testIds(), {
      source: { kind: 'relation', connectionId: 'c1' as never, schema: 'S', table: 'ORDERS' },
      columns: [{ name: 'ID', type: dataType('decimal', 'DECIMAL(18,0)') }],
    });
    expect(actionsForTable(ordinary)).toEqual(TABLE_ACTIONS);
    expect(actionsForTable(ordinary).map((action) => action.action)).not.toContain('json');
  });
});

describe('drawing the stored columns instead', () => {
  /** What the switch goes back to: every physical column, exactly as before. */
  it('draws the masks and the branches as the ordinary columns they are', () => {
    const stored = buildTableEntity(testIds(), {
      source: {
        kind: 'relation',
        connectionId: 'c1' as never,
        schema: 'PANORAMA_JSON',
        table: 'PEOPLE',
        document: true,
      },
      columns: schema.columns.map((column) => ({ name: column.name, type: column.type })),
      size: { width: 2_400, height: 420 },
    });
    const texts = buildTableDrawList({
      entity: stored,
      layout: computeColumnLayout(stored.columns),
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: root.rowCount,
      data,
    }).texts.map((run) => run.text);
    expect(texts).toContain('note|n');
    expect(texts).toContain('value|string');
    // And no document tokens at all: these are ordinary columns again, so an
    // absent value is the one dash SQL has always drawn.
    expect(texts).not.toContain('null');
    expect(texts).not.toContain('{…}');
  });
});

describe('a column view built from the specs', () => {
  it('carries the reading instructions onto the entity', () => {
    const columns = buildTableColumns(testIds(), specs);
    const value = columns.find((column) => column.sourceColumn.name === 'value');
    expect(value?.json).toMatchObject({ kind: 'variant' });
    expect(value?.json?.branches).toHaveLength(2);
    // A structural column carries one too: with the properties drawn, a
    // column's position in the table is no longer its position in the result
    // set, so every column of a document table names the index it reads.
    const id = columns.find((column) => column.sourceColumn.name === '_id');
    expect(id?.json).toMatchObject({ kind: 'scalar', branches: [{ index: 0 }] });
  });
});

describe('the panel under a picked-out property', () => {
  const breakdown = {
    rows: 100,
    branches: [
      { name: 'value', count: 60, primary: true },
      { name: 'string', count: 18 },
    ],
    explicitNulls: 12,
    emptyStrings: 4,
    missing: 6,
  };

  const panelTexts = (
    document?: typeof breakdown,
    summary?: Parameters<typeof summaryPanelSections>[0]['summary'],
  ) => {
    const sections = summaryPanelSections({
      name: 'value',
      type: dataType('decimal', 'DECIMAL(19,0)'),
      summary,
      note: undefined,
      ...(document === undefined ? {} : { document }),
    });
    const quads: unknown[] = [];
    const texts: { text: string; color: readonly number[] }[] = [];
    const panel = { columnId: 'col' as never, x: 0, y: 0, width: 240, height: 400, sections };
    for (const [index, section] of sections.entries()) {
      section.paint(
        { quads, texts, theme: DEFAULT_TABLE_THEME } as never,
        panel as never,
        index * 20,
      );
    }
    return texts;
  };

  /**
   * The question a tagged union actually raises. A histogram of the integer
   * branch describes the sixty rows that were integers and cannot mention the
   * other forty at all.
   */
  it('says what is in the property before saying how it is distributed', () => {
    const texts = panelTexts(breakdown).map((run) => run.text);
    expect(texts).toContain('value');
    expect(texts).toContain('string');
    expect(texts).toContain('60');
    expect(texts).toContain('18');
    // The three kinds of nothing, in the same words the cells use.
    expect(texts).toContain('null');
    expect(texts).toContain('""');
    expect(texts).toContain('—');
    expect(texts).toContain('12');
    expect(texts).toContain('4');
    expect(texts).toContain('6');
  });

  it('names the emptinesses in the colours the cells drew them in', () => {
    const texts = panelTexts(breakdown);
    const colour = (text: string) => texts.find((run) => run.text === text)?.color.join(',');
    expect(colour('null')).toBe(DEFAULT_TABLE_THEME.jsonNullText.join(','));
    expect(colour('""')).toBe(DEFAULT_TABLE_THEME.jsonEmptyText.join(','));
    expect(colour('—')).toBe(DEFAULT_TABLE_THEME.nullText.join(','));
  });

  /** A row of zero costs a line and says nothing. */
  it('leaves out an emptiness that never happened', () => {
    const texts = panelTexts({ ...breakdown, emptyStrings: 0, missing: 10 }).map((run) => run.text);
    expect(texts).not.toContain('""');
    expect(texts).toContain('—');
  });

  /**
   * A breakdown with no distribution under it is a complete answer, not a half
   * one: a list, an object, or a property that was `null` in every row has
   * nothing to be distributed.
   */
  it('does not ask the reader to wait for a distribution there will not be', () => {
    const texts = panelTexts(breakdown).map((run) => run.text);
    expect(texts).not.toContain('Reading…');
  });

  it('still says so where there is nothing at all yet', () => {
    expect(panelTexts(undefined, undefined).map((run) => run.text)).toContain('Reading…');
  });
});
