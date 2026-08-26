/**
 * Argument shapes, written once.
 *
 * Every tool needs its arguments described twice over: as JSON Schema, so an
 * agent knows what to send, and as a runtime check, because what arrives is
 * whatever the agent actually sent. Written twice they drift, and the drift is
 * silent — the schema says one thing and the check enforces another.
 *
 * So they are written once, as a table of fields, and both are derived from it.
 * The check is not decoration: an agent is the one caller that reaches the
 * document without a keyboard or a pointer in the way, so `{"ids": "table:1"}`
 * where a list belongs must come back as a message rather than as a crash
 * halfway through applying it.
 */

export type FieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'string-array'
  | 'vec3'
  | 'mark-array'
  | 'object-array';

export interface FieldSpec {
  readonly kind: FieldKind;
  readonly describe: string;
  readonly optional?: true;
  /** Allowed values, for a field that names one of a fixed few. */
  readonly enum?: readonly string[];
  /**
   * A JSON Schema for the inside of an object, used as written.
   *
   * The one escape from the field table, and it exists because a nested object's
   * own fields have to be describable: an agent that cannot see that `sort` takes
   * `size`, `name` or `natural` finds out by being refused, and four refusals is
   * four round trips. The runtime check stays shallow — the reader for that shape
   * does the rest, and says what was wrong in its own words.
   */
  readonly schema?: Record<string, unknown>;
}

export type ArgsSpec = Readonly<Record<string, FieldSpec>>;

/** A refusal an agent can read: what was wrong, in the terms it was sent in. */
export class AgentError extends Error {}

const fail = (message: string): never => {
  throw new AgentError(message);
};

const jsonTypes: Readonly<Record<FieldKind, string>> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  object: 'object',
  'string-array': 'array',
  vec3: 'object',
  'mark-array': 'array',
  'object-array': 'array',
};

/** The JSON Schema for one field, as an MCP `inputSchema` property. */
const propertySchema = (field: FieldSpec): Record<string, unknown> =>
  field.schema === undefined
    ? plainSchema(field)
    : { ...field.schema, description: field.describe };

const plainSchema = (field: FieldSpec): Record<string, unknown> => ({
  type: jsonTypes[field.kind],
  description: field.describe,
  ...(field.enum === undefined ? {} : { enum: [...field.enum] }),
  ...(field.kind === 'string-array' ? { items: { type: 'string' } } : {}),
  ...(field.kind === 'object-array' ? { items: { type: 'object' } } : {}),
  ...(field.kind === 'mark-array'
    ? {
        items: {
          type: 'object',
          properties: {
            entityId: { type: 'string' },
            series: { type: 'integer' },
            data: { type: 'integer' },
          },
          required: ['entityId', 'series', 'data'],
          additionalProperties: false,
        },
      }
    : {}),
  ...(field.kind === 'vec3'
    ? {
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number', description: 'Stacking order; 0 when left out' },
        },
        required: ['x', 'y'],
      }
    : {}),
});

/**
 * The `inputSchema` for a tool.
 *
 * `additionalProperties: false` on purpose: a misspelt argument that is quietly
 * ignored looks to an agent exactly like one that was honoured, and it will
 * believe the reply.
 */
export const jsonSchema = (spec: ArgsSpec): Record<string, unknown> => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(spec).map(([name, field]) => [name, propertySchema(field)]),
  ),
  required: Object.entries(spec)
    .filter(([, field]) => field.optional !== true)
    .map(([name]) => name),
  additionalProperties: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const checkField = (name: string, field: FieldSpec, value: unknown): void => {
  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') fail(`${name} must be a string`);
      if (field.enum !== undefined && !field.enum.includes(value as string)) {
        fail(`${name} must be one of ${field.enum.join(', ')}`);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${name} must be a number`);
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail(`${name} must be a whole number`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${name} must be true or false`);
      return;
    case 'object':
      if (!isRecord(value)) fail(`${name} must be an object`);
      return;
    case 'vec3': {
      if (!isRecord(value)) fail(`${name} must be a position, as {x, y}`);
      const point = value as Record<string, unknown>;
      for (const axis of ['x', 'y'] as const) {
        if (typeof point[axis] !== 'number' || !Number.isFinite(point[axis])) {
          fail(`${name}.${axis} must be a number`);
        }
      }
      // Depth is stacking order, which a caller placing a box has no view on and
      // should not have to invent. Absent means the ground.
      if (
        point['z'] !== undefined &&
        (typeof point['z'] !== 'number' || !Number.isFinite(point['z']))
      ) {
        fail(`${name}.z must be a number when it is given`);
      }
      return;
    }
    case 'object-array': {
      if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
        fail(`${name} must be a list of objects`);
      }
      if ((value as readonly unknown[]).length === 0) fail(`${name} must not be empty`);
      return;
    }
    case 'mark-array': {
      if (!Array.isArray(value)) fail(`${name} must be a list of chart marks`);
      for (const entry of value as readonly unknown[]) {
        if (!isRecord(entry)) fail(`${name} must be a list of chart marks`);
        const mark = entry as Record<string, unknown>;
        if (typeof mark['entityId'] !== 'string') {
          fail(`${name}: each mark needs the chart's entityId`);
        }
        if (!Number.isInteger(mark['series']) || !Number.isInteger(mark['data'])) {
          fail(`${name}: each mark needs series and data as whole numbers`);
        }
      }
      return;
    }
    default:
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        fail(`${name} must be a list of strings`);
      }
  }
};

/**
 * Checks arguments against a spec and returns them.
 *
 * Absent optional fields stay absent rather than becoming `undefined` entries,
 * so a caller can tell "not given" from "given as nothing" — which is the
 * difference between leaving a size alone and asking for none.
 */
export const readArgs = (spec: ArgsSpec, args: unknown): Readonly<Record<string, unknown>> => {
  const given = args === undefined ? {} : args;
  if (!isRecord(given)) fail('arguments must be an object');
  const record = given as Record<string, unknown>;
  const unknownName = Object.keys(record).find((name) => spec[name] === undefined);
  if (unknownName !== undefined) {
    const known = Object.keys(spec);
    fail(
      known.length === 0
        ? `${unknownName} is not an argument of this tool, which takes none`
        : `${unknownName} is not an argument of this tool; it takes ${known.join(', ')}`,
    );
  }
  const read: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = record[name];
    if (value === undefined || value === null) {
      if (field.optional !== true) fail(`${name} is required`);
      continue;
    }
    checkField(name, field, value);
    read[name] = value;
  }
  return read;
};

/** Reads a checked field. The spec is what makes these casts safe. */
export const str = (args: Readonly<Record<string, unknown>>, name: string): string =>
  args[name] as string;

export const obj = (
  args: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> => args[name] as Readonly<Record<string, unknown>>;

/** An optional field, or the fallback. */
export const optional = <T>(
  args: Readonly<Record<string, unknown>>,
  name: string,
  fallback: T,
): T => (args[name] === undefined ? fallback : (args[name] as T));
