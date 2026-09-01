import type { ColumnDataType } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { RelationShape } from './generators.js';

/**
 * A JSON table family, as the two loaders would have written it.
 *
 * Modelled on `examples/people.source_manifest.json` in `exasol-mongodb-vs` —
 * the same tables, the same columns, the same order — so what the tests and
 * probes drive is the shape a real load produces rather than one invented to be
 * convenient. Every state the contract can express is in here at least once:
 *
 * - a property present and explicitly `null` (`note`, row 0)
 * - a property missing entirely (`note`, row 1)
 * - a string present and empty (`empty_text`, row 0), which SQL stores as NULL
 * - a property that is an integer in one row and a string in another (`value`)
 * - an object that exists in some rows and not others (`profile`)
 * - an array that is populated, empty, and missing (`tags`)
 * - an array of objects, one of which has an array of its own (`items.flags`)
 *
 * A family cannot be generated from a row index the way the other shapes are:
 * the whole point of it is that a value's meaning depends on a *sibling* column
 * in the same row, so the rows are written out. Five of them, which is enough to
 * hold every state and few enough to read.
 */

const VARCHAR = (size: number): ColumnDataType => dataType('varchar', `VARCHAR(${size})`, { size });
const ID = VARCHAR(64);
const BOOL = dataType('boolean', 'BOOLEAN');
const INT = dataType('decimal', 'DECIMAL(19,0)', { precision: 19, scale: 0 });
const POS = dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 });
const TIMESTAMP = dataType('timestamp', 'TIMESTAMP(3)', { fraction: 3 });

export const JSON_FAMILY_SCHEMA = 'PANORAMA_JSON';

/** The comment `exasol-json-tables` stamps on every table it creates. */
export const familyComment = (tablePath: string): string =>
  `COPY provenance ${JSON.stringify({
    source: 'people.ndjson',
    sourceConnection: 'local-file',
    importedAt: '2026-08-31T09:12:44Z',
    tablePath,
    tool: 'exasol-json-tables',
  })}`;

/** Builds a shape whose rows are written down rather than derived. */
const written = (
  table: string,
  columns: readonly { readonly name: string; readonly type: ColumnDataType }[],
  rows: ReadonlyArray<readonly unknown[]>,
): RelationShape => ({
  schema: JSON_FAMILY_SCHEMA,
  table,
  rowCount: rows.length,
  columns: [...columns],
  valueFor: (_type, column, row) => rows[row]?.[column] ?? null,
});

/**
 * The document root.
 *
 * Column order is the manifest's, which is the order the loader emits and
 * therefore the order a `SELECT *` returns: a property's masks and alternate
 * branches sit immediately after it.
 */
export const jsonFamilyRoot = (): RelationShape =>
  written(
    'PEOPLE',
    [
      { name: '_id', type: ID },
      { name: 'mongo_id', type: VARCHAR(24) },
      { name: 'name', type: VARCHAR(2_000_000) },
      { name: 'empty_text', type: VARCHAR(2_000_000) },
      { name: 'empty_text|empty', type: BOOL },
      { name: 'note', type: VARCHAR(2_000_000) },
      { name: 'note|n', type: BOOL },
      { name: 'value', type: INT },
      { name: 'value|string', type: VARCHAR(2_000_000) },
      { name: 'created_at', type: TIMESTAMP },
      { name: 'profile|object', type: ID },
      { name: 'tags|array', type: POS },
      { name: 'items|array', type: POS },
    ],
    [
      // Present and empty, explicitly null, an integer, an object, three tags.
      [
        'r0',
        '66b60c1f3dce4f58d74f97a1',
        'Ada',
        null,
        true,
        null,
        true,
        42,
        null,
        '2026-01-04 09:00:00.000',
        'p0',
        3,
        2,
      ],
      // Missing throughout, the string branch of `value`, an empty array.
      [
        'r1',
        '66b60c1f3dce4f58d74f97a2',
        'Bo',
        null,
        null,
        null,
        null,
        null,
        'forty-two',
        '2026-01-05 11:30:00.000',
        null,
        0,
        1,
      ],
      // A real string, explicitly null again, and no arrays at all.
      [
        'r2',
        '66b60c1f3dce4f58d74f97a3',
        'Cyd',
        'text',
        null,
        null,
        true,
        7,
        null,
        '2026-01-06 08:15:00.000',
        'p2',
        null,
        null,
      ],
      // Nothing but a name: every branch and every mask unset.
      [
        'r3',
        '66b60c1f3dce4f58d74f97a4',
        'Dag',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      // A note that is a real string rather than a null or a nothing. Note that
      // `empty_text` is *missing* here and not empty: Exasol stores `''` as NULL,
      // so a present empty string is a NULL with the mask set, exactly as row 0
      // has it. A literal `''` in this column could not come out of a real load.
      [
        'r4',
        '66b60c1f3dce4f58d74f97a5',
        'Eve',
        null,
        null,
        'shipped late',
        null,
        null,
        null,
        '2026-01-08 17:45:00.000',
        null,
        1,
        null,
      ],
    ],
  );

/** An embedded object: one row per parent that had one. */
export const jsonFamilyProfile = (): RelationShape =>
  written(
    'PEOPLE_profile',
    [
      { name: '_id', type: ID },
      { name: 'city', type: VARCHAR(2_000_000) },
    ],
    [
      ['p0', 'Copenhagen'],
      ['p2', 'Aarhus'],
    ],
  );

/** A scalar array: one row per element, ordered by `_pos`, with a null element. */
export const jsonFamilyTags = (): RelationShape =>
  written(
    'PEOPLE_tags_arr',
    [
      { name: '_parent', type: ID },
      { name: '_pos', type: POS },
      { name: '_value', type: VARCHAR(2_000_000) },
      { name: '_value|n', type: BOOL },
    ],
    [
      ['r0', 0, 'rust', null],
      ['r0', 1, 'analytics', null],
      ['r0', 2, null, true],
      ['r4', 0, 'sql', null],
    ],
  );

/** An array of objects, which has an `_id` of its own because it has children. */
export const jsonFamilyItems = (): RelationShape =>
  written(
    'PEOPLE_items_arr',
    [
      { name: '_id', type: ID },
      { name: '_parent', type: ID },
      { name: '_pos', type: POS },
      { name: 'label', type: VARCHAR(2_000_000) },
      { name: 'flags|array', type: POS },
    ],
    [
      ['i0', 'r0', 0, 'first', 2],
      ['i1', 'r0', 1, 'second', null],
      ['i2', 'r1', 0, 'only', 0],
    ],
  );

/** An array inside an array, which is what the doubled `_arr` in the name means. */
export const jsonFamilyFlags = (): RelationShape =>
  written(
    'PEOPLE_items_arr_flags_arr',
    [
      { name: '_parent', type: ID },
      { name: '_pos', type: POS },
      { name: '_value', type: BOOL },
    ],
    [
      ['i0', 0, true],
      ['i0', 1, false],
    ],
  );

/** The whole family, in the order the explorer would list it: alphabetical. */
export const jsonFamily = (): readonly RelationShape[] => [
  jsonFamilyRoot(),
  jsonFamilyItems(),
  jsonFamilyFlags(),
  jsonFamilyProfile(),
  jsonFamilyTags(),
];

/** The table names in the family, which is what the naming rules are read against. */
export const jsonFamilyTables = (): readonly string[] =>
  jsonFamily().map((relation) => relation.table);
