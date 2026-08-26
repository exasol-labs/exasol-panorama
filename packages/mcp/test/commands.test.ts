import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  describeCommands,
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

describe('readChartSpec', () => {
  const base = { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' };

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

describe('readSessionCommand', () => {
  it('accepts what is worth an agent saying', () => {
    expect(readSessionCommand({ type: 'SetSelection', ids: ['table:1'] })).toEqual({
      type: 'SetSelection',
      ids: ['table:1'],
    });
    expect(readSessionCommand({ type: 'SetHovered' })).toEqual({ type: 'SetHovered' });
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
