import { describe, expect, it } from 'vitest';
import { AgentError, jsonSchema, readArgs } from '@panorama/mcp';
import type { ArgsSpec } from '@panorama/mcp';

const SPEC: ArgsSpec = {
  tableId: { kind: 'string', describe: 'Which table' },
  action: { kind: 'string', describe: 'What to do', enum: ['open', 'close'] },
  count: { kind: 'integer', describe: 'How many', optional: true },
  size: { kind: 'number', describe: 'How big', optional: true },
  visible: { kind: 'boolean', describe: 'Whether shown', optional: true },
  ids: { kind: 'string-array', describe: 'Several things', optional: true },
  command: { kind: 'object', describe: 'A command', optional: true },
  position: { kind: 'vec3', describe: 'Where', optional: true },
  marks: { kind: 'mark-array', describe: 'Chart pieces', optional: true },
};

describe('jsonSchema', () => {
  it('describes every field, and says which are required', () => {
    const schema = jsonSchema(SPEC);
    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(['tableId', 'action']);
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['tableId']?.['type']).toBe('string');
    expect(properties['action']?.['enum']).toEqual(['open', 'close']);
    expect(properties['count']?.['type']).toBe('integer');
    expect(properties['ids']?.['items']).toEqual({ type: 'string' });
    // Depth is stacking order, which a caller placing a box has no view on.
    expect(properties['position']?.['required']).toEqual(['x', 'y']);
    expect((properties['marks']?.['items'] as Record<string, unknown>)['required']).toEqual([
      'entityId',
      'series',
      'data',
    ]);
  });

  it('refuses arguments it did not describe', () => {
    // A misspelt argument that is quietly ignored looks to an agent exactly like
    // one that was honoured, and it will believe the answer.
    expect(jsonSchema(SPEC)['additionalProperties']).toBe(false);
    expect(() => readArgs(SPEC, { tableId: 't', action: 'open', tabelId: 'x' })).toThrow(
      /tabelId is not an argument/u,
    );
    expect(() => readArgs({}, { anything: 1 })).toThrow(/takes none/u);
  });
});

describe('readArgs', () => {
  const valid = { tableId: 'table:1', action: 'open' };

  it('passes what matches, and leaves absent options absent', () => {
    const read = readArgs(SPEC, valid);
    expect(read).toEqual(valid);
    expect('count' in read).toBe(false);
    // One of each kind, passing rather than failing.
    expect(
      readArgs(SPEC, {
        ...valid,
        count: 3,
        size: 1.5,
        visible: false,
        ids: ['a'],
        command: { type: 'EndDrag' },
      }),
    ).toEqual({
      ...valid,
      count: 3,
      size: 1.5,
      visible: false,
      ids: ['a'],
      command: { type: 'EndDrag' },
    });
  });

  it('treats null as absent, so an explicit nothing is not a wrong type', () => {
    expect(readArgs(SPEC, { ...valid, count: null })).toEqual(valid);
    expect(() => readArgs(SPEC, { tableId: null, action: 'open' })).toThrow(/tableId is required/u);
  });

  it('says which field was wrong and what it should have been', () => {
    expect(() => readArgs(SPEC, {})).toThrow(/tableId is required/u);
    expect(() => readArgs(SPEC, { tableId: 7, action: 'open' })).toThrow(
      /tableId must be a string/u,
    );
    expect(() => readArgs(SPEC, { ...valid, action: 'launch' })).toThrow(/one of open, close/u);
    expect(() => readArgs(SPEC, { ...valid, count: 1.5 })).toThrow(/whole number/u);
    expect(() => readArgs(SPEC, { ...valid, size: Number.NaN })).toThrow(/must be a number/u);
    expect(() => readArgs(SPEC, { ...valid, visible: 'yes' })).toThrow(/true or false/u);
    expect(() => readArgs(SPEC, { ...valid, ids: ['a', 2] })).toThrow(/list of strings/u);
    expect(() => readArgs(SPEC, { ...valid, command: [] })).toThrow(/must be an object/u);
    expect(() => readArgs(SPEC, 'nonsense')).toThrow(/arguments must be an object/u);
  });

  it('checks a position axis by axis, and lets the depth go unsaid', () => {
    expect(readArgs(SPEC, { ...valid, position: { x: 1, y: 2, z: 0 } })['position']).toEqual({
      x: 1,
      y: 2,
      z: 0,
    });
    // Stacking order is not something a caller placing a box has a view on.
    expect(readArgs(SPEC, { ...valid, position: { x: 1, y: 2 } })['position']).toEqual({
      x: 1,
      y: 2,
    });
    expect(() => readArgs(SPEC, { ...valid, position: { x: 1 } })).toThrow(/position.y/u);
    expect(() => readArgs(SPEC, { ...valid, position: { x: 1, y: 2, z: 'up' } })).toThrow(
      /position.z must be a number when it is given/u,
    );
    expect(() => readArgs(SPEC, { ...valid, position: 5 })).toThrow(/as \{x, y\}/u);
  });

  it('checks a list of commands as a list of objects', () => {
    const spec: ArgsSpec = { commands: { kind: 'object-array', describe: 'Several' } };
    expect(readArgs(spec, { commands: [{ type: 'EndDrag' }] })['commands']).toHaveLength(1);
    expect(() => readArgs(spec, { commands: 'one' })).toThrow(/list of objects/u);
    expect(() => readArgs(spec, { commands: [1] })).toThrow(/list of objects/u);
    // An empty list is a call that does nothing, which is a mistake worth saying.
    expect(() => readArgs(spec, { commands: [] })).toThrow(/must not be empty/u);
  });

  it('carries a nested schema through as written', () => {
    const spec: ArgsSpec = {
      thing: {
        kind: 'object',
        describe: 'A thing',
        schema: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } },
      },
    };
    const properties = jsonSchema(spec)['properties'] as Record<string, Record<string, unknown>>;
    // The one escape from the field table: a nested object's own fields have to
    // be describable, or they are discovered by being refused.
    expect(properties['thing']?.['properties']).toEqual({
      mode: { type: 'string', enum: ['a', 'b'] },
    });
    expect(properties['thing']?.['description']).toBe('A thing');
  });

  it('checks chart marks mark by mark', () => {
    const marks = [{ entityId: 'table:1', series: 0, data: 2 }];
    expect(readArgs(SPEC, { ...valid, marks })['marks']).toEqual(marks);
    expect(() => readArgs(SPEC, { ...valid, marks: 'all' })).toThrow(/list of chart marks/u);
    expect(() => readArgs(SPEC, { ...valid, marks: [1] })).toThrow(/list of chart marks/u);
    expect(() => readArgs(SPEC, { ...valid, marks: [{ series: 0, data: 0 }] })).toThrow(
      /needs the chart's entityId/u,
    );
    expect(() =>
      readArgs(SPEC, { ...valid, marks: [{ entityId: 'x', series: 0.5, data: 0 }] }),
    ).toThrow(/whole numbers/u);
  });

  it('treats no arguments at all as an empty object', () => {
    expect(readArgs({}, undefined)).toEqual({});
  });

  it('refuses with an error an agent can read', () => {
    expect(() => readArgs(SPEC, {})).toThrow(AgentError);
  });
});
