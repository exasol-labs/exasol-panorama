import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableEntity } from '@panorama/core';
import { DERIVED_TABLE, buildTableEntity } from '@panorama/core';
import type { TableRenderInput, TextRun } from '@panorama/renderer';
import { DEFAULT_TABLE_THEME, buildTableDrawList, referenceSpans } from '@panorama/renderer';
import { TEST_CONNECTION, dataView, sampleColumns, testIds } from './fixtures.js';

const SQL = 'SELECT *\nFROM "SALES"."ORDERS"\nWHERE COUNTRY = \'Denmark\'';

const queryTable = (mode: 'editing' | 'result'): TableEntity =>
  buildTableEntity(testIds(3), {
    source: {
      kind: 'query',
      connectionId: TEST_CONNECTION,
      sql: SQL,
      label: 'SALES.ORDERS · SQL',
    },
    mode,
    columns: sampleColumns,
    size: { width: 520, height: 260 },
  });

const draw = (
  entity: TableEntity,
  overrides: { lod?: TableRenderInput['lod']; showHalo?: boolean } = {},
) =>
  buildTableDrawList({
    entity,
    layout: computeColumnLayout(entity.columns),
    theme: DEFAULT_TABLE_THEME,
    scrollTop: 0,
    scrollLeft: 0,
    rowCount: 1_000,
    data: dataView(),
    lod: overrides.lod ?? 'full',
    showHalo: overrides.showHalo ?? false,
  });

describe('a derived table', () => {
  const plain = buildTableEntity(testIds(4), {
    source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
    columns: sampleColumns,
    size: { width: 520, height: 260 },
  });

  it('tints its title bar so it reads as computed', () => {
    const derived = draw(queryTable('result'));
    expect(
      derived.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.derivedTitleBackground),
    ).toBe(true);
    expect(derived.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.titleBackground)).toBe(
      false,
    );
    expect(derived.texts.find((run) => run.text.endsWith('· SQL'))?.color).toBe(
      DEFAULT_TABLE_THEME.derivedTitleText,
    );
    // One flat colour, like every other table's bar: exactly one quad covers
    // the title, so nothing is layered on top of it.
    const titleQuads = derived.quads.filter(
      (quad) => quad.y === 0 && quad.height === DEFAULT_TABLE_THEME.titleHeight,
    );
    expect(titleQuads.map((quad) => quad.color)).toEqual([
      DEFAULT_TABLE_THEME.derivedTitleBackground,
    ]);
  });

  it('leaves a stored relation looking exactly as it did', () => {
    const list = draw(plain);
    expect(list.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.titleBackground)).toBe(
      true,
    );
    expect(
      list.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.derivedTitleBackground),
    ).toBe(false);
  });

  it('keeps the tint at far zoom, where the title is all there is', () => {
    expect(
      draw(queryTable('result'), { lod: 'summary' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.derivedTitleBackground,
      ),
    ).toBe(true);
  });
});

describe('a query box being written', () => {
  it('draws its statement instead of rows', () => {
    const list = draw(queryTable('editing'));
    const lines = list.texts.map((run) => run.text);
    expect(lines).toContain('SELECT *');
    expect(lines).toContain('FROM "SALES"."ORDERS"');
    expect(lines).toContain("WHERE COUNTRY = 'Denmark'");
    // No data: not one cell, and no column header.
    expect(list.stats.visibleRows).toBe(0);
    expect(list.stats.renderedRows).toBe(0);
    expect(lines).not.toContain('country-0');
  });

  it('titles itself by its label', () => {
    expect(draw(queryTable('editing')).texts.map((run) => run.text)).toContain(
      'SALES.ORDERS · SQL',
    );
  });

  it('names the gesture that runs the statement', () => {
    expect(draw(queryTable('editing')).texts.map((run) => run.text)).toContain(
      DEFAULT_TABLE_THEME.editorHint,
    );
  });

  it('claims no row count before the statement has run', () => {
    // "0 rows" would read as a result that came back empty.
    const lines = draw(queryTable('editing')).texts.map((run) => run.text);
    expect(lines.some((line) => line.includes('row'))).toBe(false);
    expect(draw(queryTable('result')).texts.some((run) => run.text.endsWith('rows'))).toBe(true);
  });

  it('draws rows once it is showing its result', () => {
    const list = draw(queryTable('result'));
    expect(list.stats.renderedRows).toBeGreaterThan(0);
    expect(list.texts.map((run) => run.text)).not.toContain('SELECT *');
  });

  it('offers an edit button as well as a further query and a close', () => {
    const list = draw(queryTable('result'), { showHalo: true });
    const marks = list.texts.map((run) => run.text);
    expect(marks).toContain('✎');
    expect(marks).toContain('SQL');
    expect(marks).toContain('×');
  });

  it('turns the pencil into a way back while the statement is open', () => {
    const marks = draw(queryTable('editing'), { showHalo: true }).texts.map((run) => run.text);
    // Same slot, other direction: leaving the editor, not entering it.
    expect(marks).toContain('↩');
    expect(marks).not.toContain('✎');
    expect(marks).toContain('SQL');
    expect(marks).toContain('×');
  });

  it('drops statement lines that would overflow the box', () => {
    const tall = { ...queryTable('editing') };
    const short: TableEntity = {
      ...tall,
      transform: { ...tall.transform, height: 70 },
    };
    const lines = draw(short).texts.map((run) => run.text);
    // The first line still fits; the last does not.
    expect(lines).not.toContain("WHERE COUNTRY = 'Denmark'");
  });

  it('still summarises at far zoom rather than drawing an unreadable editor', () => {
    const list = draw(queryTable('editing'), { lod: 'summary' });
    expect(list.texts.map((run) => run.text)).not.toContain('SELECT *');
  });
});

describe('the name a query box calls its input by', () => {
  const boxWith = (sql: string): TableEntity =>
    buildTableEntity(testIds(5), {
      source: { kind: 'query', connectionId: TEST_CONNECTION, sql, label: 'step · SQL' },
      mode: 'editing',
      columns: [],
      size: { width: 520, height: 260 },
    });

  const runFor = (sql: string, line: string): TextRun | undefined =>
    draw(boxWith(sql)).texts.find((run) => run.text === line);

  it('is coloured, because it is the one word no database has heard of', () => {
    const run = runFor(`SELECT *\nFROM ${DERIVED_TABLE}`, `FROM ${DERIVED_TABLE}`);
    expect(run?.spans).toEqual([
      { from: 5, to: 5 + DERIVED_TABLE.length, color: DEFAULT_TABLE_THEME.editorReferenceText },
    ]);
    expect(run?.color).toBe(DEFAULT_TABLE_THEME.editorText);
  });

  it('is left plain where the statement names a real table', () => {
    expect(runFor('SELECT *\nFROM "S"."T"', 'FROM "S"."T"')?.spans).toBeUndefined();
  });

  it('is found on whichever line it is written on', () => {
    const sql = `SELECT COUNTRY\nFROM ${DERIVED_TABLE}\nWHERE ${DERIVED_TABLE}.REVENUE > 0`;
    const list = draw(boxWith(sql));
    const marked = list.texts.filter((run) => (run.spans?.length ?? 0) > 0);
    // Once per line that mentions it, in that line's own offsets — the statement
    // is lexed whole and drawn a line at a time.
    expect(marked.map((run) => run.spans?.[0]?.from)).toEqual([5, 6]);
  });

  it('is not coloured inside a string, which is a value and not a name', () => {
    const sql = `SELECT *\nFROM t WHERE label = '${DERIVED_TABLE}'`;
    const marked = draw(boxWith(sql)).texts.filter((run) => (run.spans?.length ?? 0) > 0);
    expect(marked).toEqual([]);
  });

  it('is coloured across a wrapped span that a line only partly holds', () => {
    // A span is trimmed to the line it lands on, so a reference split by the
    // statement being drawn line by line still colours what shows.
    expect(
      referenceSpans([{ from: 2, to: 20 }], 0, 6, DEFAULT_TABLE_THEME.editorReferenceText),
    ).toEqual([{ from: 2, to: 6, color: DEFAULT_TABLE_THEME.editorReferenceText }]);
    expect(
      referenceSpans([{ from: 2, to: 20 }], 10, 6, DEFAULT_TABLE_THEME.editorReferenceText),
    ).toEqual([{ from: 0, to: 6, color: DEFAULT_TABLE_THEME.editorReferenceText }]);
  });
});
