import { describe, expect, it } from 'vitest';
import type { EntityId, SessionState } from '@panorama/core';
import {
  applyCommand,
  applySessionCommand,
  buildTableEntity,
  emptySession,
  emptyWorld,
  unwrap,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';
import {
  CHART_SPEC_SCHEMA,
  COMMAND_TYPES,
  describeCommands,
  readChartSources,
  readChartSpec,
  readCommand,
  readSessionCommand,
} from '@panorama/mcp';

describe('readCommand', () => {
  it('reads a command an agent sent as JSON', () => {
    expect(
      readCommand({ type: 'MoveEntities', ids: ['table:1'], position: { x: 10, y: 20, z: 0 } }),
    ).toEqual({ type: 'MoveEntities', ids: ['table:1'], position: { x: 10, y: 20, z: 0 } });
    expect(readCommand({ type: 'RemoveEntities', ids: [] })).toEqual({
      type: 'RemoveEntities',
      ids: [],
    });
  });

  it('checks the fields of the command it names', () => {
    expect(() => readCommand({ type: 'MoveEntities', ids: 'table:1' })).toThrow(
      /ids must be a list of strings/u,
    );
    expect(() => readCommand({ type: 'ResizeEntity', id: 'table:1', width: 100 })).toThrow(
      /height is required/u,
    );
    // The optional position of a resize from a top or left edge.
    expect(readCommand({ type: 'ResizeEntity', id: 'table:1', width: 100, height: 50 })).toEqual({
      type: 'ResizeEntity',
      id: 'table:1',
      width: 100,
      height: 50,
    });
  });

  it('lists the vocabulary when asked for something outside it', () => {
    expect(() => readCommand({ type: 'DropDatabase', ids: [] })).toThrow(/is not a command/u);
    expect(() => readCommand({ type: 'DropDatabase' })).toThrow(/MoveEntities\(ids, position\)/u);
    expect(() => readCommand({ ids: [] })).toThrow(/must name a command/u);
  });

  it("sends the three commands about a table's identity to the tools that can do them", () => {
    // The columns come from a result set and the source needs a connection: a
    // command that assembles either by hand leaves a box with nothing to draw.
    expect(() => readCommand({ type: 'CreateTableEntity', entity: {} })).toThrow(/open_table/u);
    expect(() => readCommand({ type: 'SetTableColumns', tableId: 't', columns: [] })).toThrow(
      /Use query/u,
    );
    expect(() => readCommand({ type: 'SetTableSource', tableId: 't', source: {} })).toThrow(
      /"rows" action/u,
    );
  });

  it('describes every command it accepts, and only those', () => {
    expect(COMMAND_TYPES).toContain('SetTableQuery');
    expect(COMMAND_TYPES).not.toContain('CreateTableEntity');
    for (const type of COMMAND_TYPES) expect(describeCommands()).toContain(type);
  });

  it('checks a chart specification field by field', () => {
    const read = readCommand({
      type: 'SetChartSpec',
      tableId: 'table:1',
      spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
    });
    expect(read).toEqual({
      type: 'SetChartSpec',
      tableId: 'table:1',
      spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
    });
    expect(() =>
      readCommand({ type: 'SetChartSpec', tableId: 'table:1', spec: { type: 'donut' } }),
    ).toThrow(/spec.type must be one of/u);
  });
});

describe('reading a connector', () => {
  const ends = { fromId: 'table:1', toId: 'table:2' };

  const binding = (extra: Record<string, unknown>): Record<string, unknown> =>
    readCommand({ type: 'CreateBinding', binding: { id: 'binding:1', ...ends, ...extra } })[
      'binding' as keyof ReturnType<typeof readCommand>
    ] as unknown as Record<string, unknown>;

  it('fills in the ends a hand-drawn connector would have got', () => {
    // The crash this reader was written for: a binding with no `from` reached the
    // anchor check as `undefined` and took the page with it. Absent is the mobile
    // attachment, which is what a connector drawn with a pointer gets.
    expect(binding({})).toEqual({
      id: 'binding:1',
      kind: 'connector',
      ...ends,
      from: { mode: 'auto' },
      to: { mode: 'auto' },
      directed: false,
    });
  });

  it('keeps what was said about an end that should stay put', () => {
    expect(binding({ from: { mode: 'fixed', x: 0.25, y: 1 } })['from']).toEqual({
      mode: 'fixed',
      x: 0.25,
      y: 1,
    });
    expect(binding({ from: { mode: 'auto' } })['from']).toEqual({ mode: 'auto' });
    expect(binding({ from: null })['from']).toEqual({ mode: 'auto' });
  });

  it('carries a label and machine-readable detail through', () => {
    const carried = binding({ label: 'follows', meta: { column: 'COUNTRY' }, directed: true });
    expect(carried['label']).toBe('follows');
    expect(carried['meta']).toEqual({ column: 'COUNTRY' });
    expect(carried['directed']).toBe(true);
  });

  it('says what is wrong with one that is not a connector', () => {
    const refused =
      (value: unknown): (() => unknown) =>
      (): unknown =>
        readCommand({ type: 'CreateBinding', binding: value });
    expect(refused('a line')).toThrow(/binding must be an object/u);
    expect(refused({ ...ends })).toThrow(/binding.id must be a non-empty string/u);
    expect(refused({ id: '', ...ends })).toThrow(/binding.id must be a non-empty string/u);
    expect(refused({ id: 'binding:1', toId: 't' })).toThrow(/binding.fromId/u);
    expect(refused({ id: 'binding:1', fromId: 'f' })).toThrow(/binding.toId/u);
    expect(refused({ id: 'binding:1', ...ends, kind: 'attachment' })).toThrow(/binding.kind/u);
    expect(refused({ id: 'binding:1', ...ends, directed: 'yes' })).toThrow(/binding.directed/u);
    expect(refused({ id: 'binding:1', ...ends, label: 7 })).toThrow(/binding.label/u);
    expect(refused({ id: 'binding:1', ...ends, meta: 'COUNTRY' })).toThrow(/binding.meta/u);
    expect(refused({ id: 'binding:1', ...ends, meta: { column: 7 } })).toThrow(/binding.meta/u);
    expect(refused({ id: 'binding:1', ...ends, from: 'left' })).toThrow(/binding.from must be/u);
    expect(refused({ id: 'binding:1', ...ends, to: { mode: 'edge' } })).toThrow(/binding.to.mode/u);
    expect(refused({ id: 'binding:1', ...ends, to: { mode: 'fixed', x: 0 } })).toThrow(
      /binding.to needs x and y/u,
    );
  });
});

describe('readChartSpec', () => {
  const base = { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' };

  it('refuses a setting it does not have, rather than dropping it', () => {
    // The failure this replaces: `pivot` was read past, the chart came back
    // looking fine, and an agent had every reason to believe a pivot had been
    // applied. A refusal is a fact; a silent omission is a wrong picture
    // presented as a right one.
    expect(() => readChartSpec({ ...base, pivot: 'RISK_BAND' })).toThrow(
      /spec.pivot is not a chart setting/u,
    );
    // And it says what there is, plus the one door out.
    expect(() => readChartSpec({ ...base, pivot: 'RISK_BAND' })).toThrow(/categoryLimit/u);
    expect(() => readChartSpec({ ...base, pivot: 'RISK_BAND' })).toThrow(/type "custom"/u);
  });

  it('is judged by exactly the settings its own schema advertises', () => {
    // One list, read twice: the schema an agent is given and the check it is
    // judged by. Written down because they were two lists for a while, and the
    // difference was invisible from either side.
    const advertised = Object.keys(CHART_SPEC_SCHEMA['properties'] as Record<string, unknown>);
    expect(advertised.length).toBeGreaterThan(10);
    for (const name of advertised) {
      // Nothing advertised may be refused for *existing*. It may still be
      // refused for its value — that is the field's own check, and this is not
      // trying to guess a valid value for every one of them.
      let refused = '';
      try {
        readChartSpec({ ...base, [name]: null });
      } catch (error) {
        refused = String(error);
      }
      expect(
        refused.includes('not a chart setting'),
        `${name} is advertised but not accepted`,
      ).toBe(false);
    }
    // And nothing outside the list is.
    expect(() => readChartSpec({ ...base, pivots: true })).toThrow(/not a chart setting/u);
  });

  it('reads how many places a figure should be read to', () => {
    const spec = readChartSpec({
      ...base,
      precision: 2,
      frames: [
        {
          name: 'money',
          kind: 'group',
          category: 'C',
          values: ['V'],
          aggregate: 'sum',
          precision: 0,
        },
      ],
    });
    expect(spec.precision).toBe(2);
    expect(spec.frames?.[0]).toMatchObject({ precision: 0 });
  });

  it('reads the data sets a specification names', () => {
    const spec = readChartSpec({
      ...base,
      type: 'custom',
      extra: '{"series":[{"type":"heatmap","datasetId":"matrix"}]}',
      frames: [
        {
          name: 'matrix',
          kind: 'group',
          category: 'CLAIM_TYPE',
          breakdown: 'RISK_BAND',
          values: ['FRAUD_PCT'],
          aggregate: 'average',
          sort: 'name',
          categoryLimit: 8,
        },
        { name: 'points', kind: 'rows', columns: ['X', 'Y', 'SIZE'], rowLimit: 500 },
        { name: 'baserate', kind: 'scalar', column: 'FRAUD_PCT', aggregate: 'average' },
      ],
    });
    expect(spec.frames).toEqual([
      {
        name: 'matrix',
        kind: 'group',
        category: 'CLAIM_TYPE',
        breakdown: 'RISK_BAND',
        values: ['FRAUD_PCT'],
        aggregate: 'average',
        sort: 'name',
        categoryLimit: 8,
      },
      { name: 'points', kind: 'rows', columns: ['X', 'Y', 'SIZE'], rowLimit: 500 },
      { name: 'baserate', kind: 'scalar', column: 'FRAUD_PCT', aggregate: 'average' },
    ]);
  });

  it('reads which box each data set was told to read, apart from its shape', () => {
    // Different kinds of fact: the shape is the question the chart asks and lives
    // in its specification; the box is an arrow on the canvas.
    const sent = {
      ...base,
      frames: [
        { name: 'matrix', kind: 'rows', columns: ['X'], from: 'table:7' },
        { name: 'mine', kind: 'rows', columns: ['Y'] },
      ],
    };
    expect([...readChartSources(sent)]).toEqual([['matrix', 'table:7']]);
    // And `from` never reaches the specification.
    expect(readChartSpec(sent).frames?.[0]).toEqual({
      name: 'matrix',
      kind: 'rows',
      columns: ['X'],
    });
  });

  it('says nothing about sources where there are none to read', () => {
    expect([...readChartSources({ ...base })]).toEqual([]);
    expect([...readChartSources({ ...base, frames: 'matrix' })]).toEqual([]);
    expect([
      ...readChartSources({ ...base, frames: [7, { name: 'a' }, { from: 'table:1' }] }),
    ]).toEqual([]);
  });

  it('refuses a field a data set does not have', () => {
    expect(() =>
      readChartSpec({
        ...base,
        frames: [{ name: 'a', kind: 'rows', columns: ['X'], pivot: true }],
      }),
    ).toThrow(/spec.frames\[0\].pivot is not part of a data set/u);
  });

  it('leaves the data sets out entirely when none were named', () => {
    // Absent means exactly today's chart, which is what keeps the simple path
    // simple: a bar chart of a category and a measure names no data set.
    expect('frames' in readChartSpec({ ...base })).toBe(false);
    expect('frames' in readChartSpec({ ...base, frames: [] })).toBe(false);
  });

  it('says what is wrong with a data set rather than drawing from nothing', () => {
    const frames =
      (frame: unknown): (() => unknown) =>
      (): unknown =>
        readChartSpec({ ...base, frames: [frame] });
    expect(frames('matrix')).toThrow(/spec.frames\[0\] must be an object/u);
    expect(frames({ kind: 'rows', columns: ['X'] })).toThrow(/name must be a string/u);
    expect(frames({ name: 'x', kind: 'pivot' })).toThrow(
      /kind must be one of group, rows, resample, scalar/u,
    );
    expect(frames({ name: 'x', kind: 'rows' })).toThrow(/names no columns to read/u);
    expect(frames({ name: 'x', kind: 'rows', columns: 'X' })).toThrow(
      /columns must be a list of column names/u,
    );
    expect(frames({ name: 'x', kind: 'group', values: ['A'] })).toThrow(
      /category is required for a group data set/u,
    );
    expect(frames({ name: 'x', kind: 'group', category: 'C' })).toThrow(
      /needs a column to measure, or the count aggregate/u,
    );
    expect(frames({ name: 'x', kind: 'scalar' })).toThrow(
      /column is required for a scalar data set/u,
    );
    expect(frames({ name: 'x', kind: 'rows', columns: ['X'], rowLimit: 'lots' })).toThrow(
      /rowLimit must be a number/u,
    );
    expect(frames({ name: 'x', kind: 'rows', columns: ['X'], key: 7 })).toThrow(
      /key must name one of the columns it reads/u,
    );
    expect(frames({ name: 'x', kind: 'rows', columns: ['X'], key: 'Y' })).toThrow(
      /says its key is Y, which it does not read/u,
    );
    expect(
      frames({ name: 'x', kind: 'group', category: 'C', values: ['V'], breakdown: 7 }),
    ).toThrow(/breakdown must name a second column/u);
    expect(readChartSpec({ ...base, frames: null })).toBeDefined();
    expect(() => readChartSpec({ ...base, frames: 'matrix' })).toThrow(
      /spec.frames must be a list of data sets/u,
    );
  });

  it('reads which part of a relation a data set says it reads', () => {
    const spec = readChartSpec({
      ...base,
      frames: [
        {
          name: 'page',
          kind: 'rows',
          columns: ['T'],
          window: { by: 'position', from: 1_000.7, count: 500.2 },
        },
        {
          name: 'line',
          kind: 'resample',
          x: 'T',
          values: ['V'],
          method: 'lttb',
          points: 900,
          key: 'T',
          window: { by: 'value', column: 'T', from: '2026-01-01', to: '2026-02-01' },
        },
      ],
    });
    // Whole rows, because half a row is not a row.
    expect(spec.frames?.[0]).toEqual({
      name: 'page',
      kind: 'rows',
      columns: ['T'],
      window: { by: 'position', from: 1_000, count: 500 },
    });
    expect(spec.frames?.[1]).toEqual({
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      method: 'lttb',
      points: 900,
      key: 'T',
      window: { by: 'value', column: 'T', from: '2026-01-01', to: '2026-02-01' },
    });
  });

  it('says what is wrong with a window rather than reading the wrong rows', () => {
    const window =
      (value: unknown): (() => unknown) =>
      (): unknown =>
        readChartSpec({
          ...base,
          frames: [{ name: 'p', kind: 'rows', columns: ['T'], window: value }],
        });
    expect(window('page 2')).toThrow(/window must be an object/u);
    expect(window({ by: 'sideways' })).toThrow(/window.by must be "position" or "value"/u);
    expect(window({ by: 'position', from: 0 })).toThrow(/needs from and count/u);
    expect(window({ by: 'value', from: 1, to: 2 })).toThrow(/needs the column it bounds/u);
    expect(window({ by: 'value', column: 'T', from: 1 })).toThrow(
      /window.to must be a value the column could hold/u,
    );
    expect(window({ by: 'value', column: 'T', from: null, to: 2 })).toThrow(
      /window.from must be a value/u,
    );
  });

  it('says what is wrong with a resampling', () => {
    expect(() =>
      readChartSpec({ ...base, frames: [{ name: 'l', kind: 'resample', values: ['V'] }] }),
    ).toThrow(/x is required for a resample data set/u);
    expect(() =>
      readChartSpec({
        ...base,
        frames: [{ name: 'l', kind: 'resample', x: 'T', values: ['V'], method: 'guess' }],
      }),
    ).toThrow(/method must be one of extremes, mean, lttb/u);
    expect(() =>
      readChartSpec({ ...base, frames: [{ name: 'l', kind: 'resample', x: 'T', values: [] }] }),
    ).toThrow(/at least one column to measure/u);
  });

  it('refuses a field that belongs to another kind of data set', () => {
    // The defect this replaces, and every combination of it rather than the one
    // that was reported: a `window` on a grouping was dropped as quietly as a
    // misspelt field, and what came back was five hundred and ninety-one rows
    // where a hundred and twenty had been asked for.
    const frames =
      (frame: unknown): (() => unknown) =>
      (): unknown =>
        readChartSpec({ ...base, frames: [frame] });
    expect(
      frames({
        name: 'g',
        kind: 'group',
        category: 'C',
        values: ['V'],
        window: { by: 'position', from: 471, count: 120 },
      }),
    ).toThrow(/window is not part of a group data set/u);
    // And it says which kinds do read it.
    expect(
      frames({
        name: 'g',
        kind: 'group',
        category: 'C',
        values: ['V'],
        window: { by: 'position', from: 0, count: 1 },
      }),
    ).toThrow(/window belongs to rows and resample/u);
    expect(frames({ name: 'r', kind: 'rows', columns: ['X'], aggregate: 'sum' })).toThrow(
      /aggregate is not part of a rows data set/u,
    );
    expect(frames({ name: 's', kind: 'scalar', column: 'V', rolling: 7 })).toThrow(
      /rolling is not part of a scalar data set/u,
    );
    expect(
      frames({ name: 'l', kind: 'resample', x: 'T', values: ['V'], categoryLimit: 3 }),
    ).toThrow(/categoryLimit is not part of a resample data set/u);
    // What each kind does read is still read.
    expect(() =>
      readChartSpec({
        ...base,
        frames: [
          {
            name: 'r',
            kind: 'rows',
            columns: ['X'],
            window: { by: 'position', from: 0, count: 9 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('reads a trailing average over the rows', () => {
    const spec = readChartSpec({
      ...base,
      frames: [{ name: 'l', kind: 'resample', x: 'T', values: ['V'], rolling: 7 }],
    });
    expect(spec.frames?.[0]).toMatchObject({ rolling: 7 });
    // A mean of one row is the row, and of none is nothing.
    expect(() =>
      readChartSpec({
        ...base,
        frames: [{ name: 'l', kind: 'resample', x: 'T', values: ['V'], rolling: 1 }],
      }),
    ).toThrow(/averages over at least two rows/u);
  });

  it('refuses two data sets under one name, and the name the reduction has', () => {
    // A name is how an option reaches a data set. Two answering to one name is a
    // picture drawn from whichever won, and it cannot say which that was.
    expect(() =>
      readChartSpec({
        ...base,
        frames: [
          { name: 'a', kind: 'rows', columns: ['X'] },
          { name: 'a', kind: 'rows', columns: ['Y'] },
        ],
      }),
    ).toThrow(/two data sets are called "a"/u);
    expect(() =>
      readChartSpec({ ...base, frames: [{ name: 'primary', kind: 'rows', columns: ['X'] }] }),
    ).toThrow(/"primary" is the name of the chart's own reduction/u);
    expect(() =>
      readChartSpec({ ...base, frames: [{ name: '  ', kind: 'rows', columns: ['X'] }] }),
    ).toThrow(/needs a name to be read by/u);
  });

  it('counts rows without a column to measure, as the chart itself does', () => {
    const spec = readChartSpec({
      ...base,
      frames: [{ name: 'volume', kind: 'group', category: 'BAND', aggregate: 'count' }],
    });
    expect(spec.frames?.[0]).toEqual({
      name: 'volume',
      kind: 'group',
      category: 'BAND',
      values: [],
      aggregate: 'count',
    });
  });

  it('keeps the optional settings it understands', () => {
    const spec = readChartSpec({
      ...base,
      sort: 'name',
      orientation: 'horizontal',
      curve: 'smooth',
      scale: 'log',
      legend: 'always',
      stacked: true,
      showValues: false,
      hole: 0.4,
      categoryLimit: 8,
      extra: '{"grid":{"top":8}}',
    });
    expect(spec).toMatchObject({
      sort: 'name',
      orientation: 'horizontal',
      curve: 'smooth',
      scale: 'log',
      legend: 'always',
      stacked: true,
      showValues: false,
      hole: 0.4,
      categoryLimit: 8,
      extra: '{"grid":{"top":8}}',
    });
    // Absent settings stay absent rather than arriving as undefined, which is
    // the difference between "leave it alone" and "set it to nothing".
    expect('showGrid' in spec).toBe(false);
  });

  it('takes a written option as the whole of a custom chart', () => {
    const spec = readChartSpec({
      type: 'custom',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      extra: '{"series":[{"type":"sankey"}]}',
    });
    expect(spec.type).toBe('custom');
    expect(spec.extra).toBe('{"series":[{"type":"sankey"}]}');
  });

  it('lets a written option name no columns, because it may carry its own data', () => {
    const spec = readChartSpec({
      type: 'custom',
      category: '',
      values: [],
      aggregate: 'count',
      extra: '{"series":[{"type":"gauge","data":[{"value":42}]}]}',
    });
    expect(spec.category).toBe('');
  });

  it('insists on the option, and on it being JSON, for a custom chart', () => {
    // For a custom chart this *is* the chart, so an agent should be told which
    // character was wrong rather than reading back a picture with no series.
    expect(() => readChartSpec({ ...base, type: 'custom' })).toThrow(
      /A custom chart needs spec.extra/u,
    );
    expect(() => readChartSpec({ ...base, type: 'custom', extra: '  ' })).toThrow(
      /needs spec.extra/u,
    );
    expect(() => readChartSpec({ ...base, type: 'custom', extra: '{oh dear' })).toThrow(
      /spec.extra is not JSON/u,
    );
    expect(() => readChartSpec({ ...base, type: 'custom', extra: '[1,2]' })).toThrow(
      /spec.extra is not JSON: Extra settings must be a JSON object/u,
    );
    // A category that is given must still be a string, custom or not.
    expect(() => readChartSpec({ ...base, type: 'custom', category: 7, extra: '{}' })).toThrow(
      /spec.category must be a string/u,
    );
  });

  it('takes a second grouping column, and one measure with it', () => {
    const spec = readChartSpec({ ...base, breakdown: 'DECILE' });
    expect(spec.breakdown).toBe('DECILE');
    // Two measures split two ways is a cube, and a cube is not a picture.
    expect(() => readChartSpec({ ...base, values: ['A', 'B'], breakdown: 'DECILE' })).toThrow(
      /measures one column/u,
    );
    expect(() => readChartSpec({ ...base, breakdown: 7 })).toThrow(/spec.breakdown must name/u);
    // Left out, or given as nothing, is not a cross-tabulation at all.
    expect('breakdown' in readChartSpec({ ...base, breakdown: '' })).toBe(false);
    expect('breakdown' in readChartSpec(base)).toBe(false);
  });

  it('says which setting was wrong', () => {
    expect(() => readChartSpec({ ...base, category: '' })).toThrow(/must name the column/u);
    expect(() => readChartSpec({ ...base, values: 'REVENUE' })).toThrow(/list of column names/u);
    expect(() => readChartSpec({ ...base, aggregate: 'median' })).toThrow(/spec.aggregate/u);
    expect(() => readChartSpec({ ...base, sort: 'sideways' })).toThrow(/spec.sort/u);
    expect(() => readChartSpec({ ...base, hole: 'half' })).toThrow(/spec.hole must be a number/u);
    expect(() => readChartSpec({ ...base, stacked: 'yes' })).toThrow(/true or false/u);
    expect(() => readChartSpec({ ...base, extra: 7 })).toThrow(/ECharts options as JSON/u);
    expect(() => readChartSpec({ category: 'C', values: [], aggregate: 'sum' })).toThrow(
      /spec.type/u,
    );
    // A setting left out entirely, rather than given wrongly.
    expect(() => readChartSpec({ type: 'bar', category: 'C', values: [] })).toThrow(
      /spec.aggregate must be one of/u,
    );
  });
});

describe('reading something that is not a command at all', () => {
  it('refuses it in the terms a sender can act on', () => {
    // The readers take `unknown` on purpose: what arrives has been through a
    // pipe, and a boundary that trusts its own parameter type trusts the sender.
    expect(() => readCommand(null)).toThrow(/must be an object naming a type/u);
    expect(() => readCommand('MoveEntities')).toThrow(/must be an object naming a type/u);
    expect(() => readCommand(['MoveEntities'])).toThrow(/must be an object naming a type/u);
    expect(() => readSessionCommand(null)).toThrow(/must be an object naming a type/u);
    expect(() => readSessionCommand(42)).toThrow(/must be an object naming a type/u);
  });
});

describe('readSessionCommand', () => {
  it('accepts what is worth an agent saying', () => {
    expect(readSessionCommand({ type: 'SetSelection', ids: ['table:1'] })).toEqual({
      type: 'SetSelection',
      ids: ['table:1'],
    });
    // Nothing, spelled out: `hovered` is an entity or null and never missing,
    // and everything downstream compares it against null.
    expect(readSessionCommand({ type: 'SetHovered' })).toEqual({ type: 'SetHovered', id: null });
    expect(readSessionCommand({ type: 'EndDrag' })).toEqual({ type: 'EndDrag' });
    const marks = [{ entityId: 'table:1', series: 0, data: 1 }];
    expect(readSessionCommand({ type: 'SetSelectedMarks', targets: marks })).toEqual({
      type: 'SetSelectedMarks',
      targets: marks,
    });
  });

  it('refuses what only a pointer can honestly say', () => {
    // A hand that is not there has no position, and no button to press.
    expect(() => readSessionCommand({ type: 'SetPointer', pointer: null })).toThrow(
      /not a session command an agent may send/u,
    );
    expect(() => readSessionCommand({ type: 'BeginDrag' })).toThrow(/SetSelection/u);
    expect(() => readSessionCommand({})).toThrow(/must name a session command/u);
  });
});

describe('the commands an agent sends, applied for real', () => {
  /**
   * The seam that a hand-written table of field names needs.
   *
   * Every command here is described twice: once as an interface in the core, and
   * once as a table of fields in this package — and nothing was checking that
   * the two used the same *names*. They did not: an agent following the schema
   * sent `SetSelectedColumns(columnIds)` where the reducer reads `ids`, which
   * reached `sameIds(undefined, …)` and took the page down. So each command is
   * now built the way an agent would build it and applied to a real session,
   * where a name that does not match shows up as an answer that did not change.
   */
  const ids = testIds();
  const table = makeTable(ids);
  const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: table }));
  const columnId = table.columns[0]?.id as EntityId;

  it('changes the session as each command says it will', () => {
    const applied = (sent: Record<string, unknown>): SessionState =>
      applySessionCommand(emptySession(), readSessionCommand(sent));

    expect(applied({ type: 'SetSelection', ids: [table.id] }).selection).toEqual([table.id]);
    expect(applied({ type: 'SetHovered', id: table.id }).hovered).toBe(table.id);
    // And a null that arrives as an omission is still a null in the state.
    expect(applied({ type: 'SetHovered' }).hovered).toBeNull();
    expect(applied({ type: 'SetFocusedTable', id: table.id }).focusedTable).toBe(table.id);
    expect(applied({ type: 'SetFocusedTable' }).focusedTable).toBeNull();
    expect(applied({ type: 'SetSelectedColumns', ids: [columnId] }).selectedColumns).toEqual([
      columnId,
    ]);
    const mark = { entityId: table.id, series: 0, data: 1 };
    expect(applied({ type: 'SetSelectedMarks', targets: [mark] }).selectedMarks).toEqual([mark]);
    expect(applied({ type: 'EndDrag' }).drag).toBeNull();
  });

  it('changes the document as each command says it will', () => {
    // The same seam on the document side: a field named wrongly here would be a
    // command the core reads as missing.
    const move = unwrap(
      applyCommand(
        world,
        readCommand({ type: 'MoveEntities', ids: [table.id], position: { x: 40, y: 12 } }),
      ),
    );
    expect(move.entities.get(table.id)?.transform).toMatchObject({ x: 40, y: 12 });

    const resized = unwrap(
      applyCommand(
        world,
        readCommand({ type: 'ResizeEntity', id: table.id, width: 300, height: 200 }),
      ),
    );
    expect(resized.entities.get(table.id)?.transform).toMatchObject({ width: 300, height: 200 });

    const widened = unwrap(
      applyCommand(
        world,
        readCommand({ type: 'ResizeColumn', tableId: table.id, columnId, width: 180 }),
      ),
    );
    expect(widened.entities.get(table.id)?.columns[0]?.width).toBe(180);

    const reordered = unwrap(
      applyCommand(
        world,
        readCommand({
          type: 'ReorderColumns',
          tableId: table.id,
          columnIds: [...table.columns].reverse().map((column) => column.id),
        }),
      ),
    );
    expect(reordered.entities.get(table.id)?.columns[0]?.id).toBe(table.columns.at(-1)?.id);

    const hidden = unwrap(
      applyCommand(
        world,
        readCommand({
          type: 'SetColumnVisibility',
          tableId: table.id,
          columnId,
          visible: false,
        }),
      ),
    );
    expect(hidden.entities.get(table.id)?.columns[0]?.visible).toBe(false);

    const removed = unwrap(
      applyCommand(world, readCommand({ type: 'RemoveEntities', ids: [table.id] })),
    );
    expect(removed.entities.size).toBe(0);
  });

  it('changes a query, a chart and a name as each command says it will', () => {
    const box = buildTableEntity(ids, {
      source: {
        kind: 'query',
        connectionId: TEST_CONNECTION,
        sql: 'SELECT 1',
        label: 'SALES.ORDERS · SQL',
      },
      mode: 'result',
      columns: [],
    });
    const withBox = unwrap(applyCommand(world, { type: 'CreateTableEntity', entity: box }));

    const rewritten = unwrap(
      applyCommand(
        withBox,
        readCommand({ type: 'SetTableQuery', tableId: box.id, sql: 'SELECT 2' }),
      ),
    );
    expect((rewritten.entities.get(box.id)?.source as { sql: string }).sql).toBe('SELECT 2');

    const editing = unwrap(
      applyCommand(
        withBox,
        readCommand({ type: 'SetTableMode', tableId: box.id, mode: 'editing' }),
      ),
    );
    expect(editing.entities.get(box.id)?.mode).toBe('editing');

    const named = unwrap(
      applyCommand(
        withBox,
        readCommand({ type: 'SetTableLabel', tableId: box.id, label: 'deciles' }),
      ),
    );
    expect((named.entities.get(box.id)?.source as { label: string }).label).toBe('deciles');

    const chart = buildTableEntity(ids, {
      source: {
        kind: 'chart',
        connectionId: TEST_CONNECTION,
        spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
        label: 'SALES.ORDERS · Chart',
        derivedFrom: table.id,
      },
      mode: 'editing',
      columns: [],
    });
    const withChart = unwrap(applyCommand(world, { type: 'CreateTableEntity', entity: chart }));
    const drawn = unwrap(
      applyCommand(
        withChart,
        readCommand({
          type: 'SetChartSpec',
          tableId: chart.id,
          spec: { type: 'pie', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
        }),
      ),
    );
    expect((drawn.entities.get(chart.id)?.source as { spec: { type: string } }).spec.type).toBe(
      'pie',
    );
  });

  it('changes a connector as each command says it will', () => {
    const second = makeTable(ids);
    const both = unwrap(applyCommand(world, { type: 'CreateTableEntity', entity: second }));
    const bindingId = ids.binding();
    const joined = unwrap(
      applyCommand(
        both,
        readCommand({
          type: 'CreateBinding',
          binding: {
            id: bindingId,
            kind: 'connector',
            fromId: table.id,
            toId: second.id,
            from: { mode: 'auto' },
            to: { mode: 'auto' },
            directed: true,
          },
        }),
      ),
    );
    expect(joined.bindings.size).toBe(1);
    const retitled = unwrap(
      applyCommand(joined, readCommand({ type: 'SetBindingLabel', bindingId, label: 'follows' })),
    );
    expect(retitled.bindings.get(bindingId)?.label).toBe('follows');
    const cut = unwrap(
      applyCommand(joined, readCommand({ type: 'RemoveBindings', ids: [bindingId] })),
    );
    expect(cut.bindings.size).toBe(0);
  });
});
