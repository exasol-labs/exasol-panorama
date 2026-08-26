/**
 * A JSON Schema *validator*, for the tests only.
 *
 * Every tool describes its arguments twice over: as JSON Schema, which is what
 * an agent reads, and as a runtime check, which is what actually decides. The
 * source file derives both from one table so they cannot drift — and this is how
 * that claim is tested rather than asserted. It reads the schema the way a
 * client's validator would, written from the specification rather than from
 * `schema.ts`, so a misunderstanding shared by both halves would have to be made
 * twice to pass.
 *
 * Only the keywords the catalogue actually uses are implemented, and anything
 * unrecognised is an error rather than a shrug: a schema keyword this does not
 * know about is a keyword the agreement has not been checked for.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords this validator understands. Anything else is a gap in the check. */
const KNOWN = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
]);

export class SchemaGap extends Error {}

/** A failure, in the terms the schema was written in; `null` when it validates. */
export const validate = (schema: unknown, value: unknown, path = ''): string | null => {
  if (!isRecord(schema)) throw new SchemaGap(`${path || 'the schema'} is not an object`);
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new SchemaGap(`${path}: unsupported keyword ${keyword}`);
  }
  const type = schema['type'];
  const where = path === '' ? 'value' : path;

  const enumerated = schema['enum'];
  if (Array.isArray(enumerated) && !enumerated.includes(value)) {
    return `${where} is not one of the allowed values`;
  }

  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `${where} must be a string`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${where} must be a boolean`;
    case 'number':
      // JSON has no infinities, so a number is a number.
      return typeof value === 'number' ? null : `${where} must be a number`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${where} must be an integer`;
    case 'array': {
      if (!Array.isArray(value)) return `${where} must be an array`;
      const minItems = schema['minItems'];
      if (typeof minItems === 'number' && value.length < minItems) {
        return `${where} must have at least ${minItems} items`;
      }
      const items = schema['items'];
      if (items === undefined) return null;
      for (const [index, entry] of value.entries()) {
        const failure = validate(items, entry, `${where}[${index}]`);
        if (failure !== null) return failure;
      }
      return null;
    }
    case 'object': {
      if (!isRecord(value)) return `${where} must be an object`;
      const properties = isRecord(schema['properties']) ? schema['properties'] : {};
      const required = Array.isArray(schema['required']) ? schema['required'] : [];
      for (const name of required) {
        if (typeof name !== 'string') throw new SchemaGap(`${where}: required must be strings`);
        if (!(name in value)) return `${where}.${name} is required`;
      }
      if (schema['additionalProperties'] === false) {
        const extra = Object.keys(value).find((name) => properties[name] === undefined);
        if (extra !== undefined) return `${where}.${extra} is not allowed`;
      }
      for (const [name, entry] of Object.entries(value)) {
        const property = properties[name];
        // A property with no schema is unconstrained where additional ones are
        // allowed, and already refused above where they are not.
        if (property === undefined) continue;
        const failure = validate(property, entry, `${where}.${name}`);
        if (failure !== null) return failure;
      }
      return null;
    }
    default:
      throw new SchemaGap(`${where}: unsupported type ${JSON.stringify(type)}`);
  }
};

export const accepts = (schema: unknown, value: unknown): boolean =>
  validate(schema, value) === null;
