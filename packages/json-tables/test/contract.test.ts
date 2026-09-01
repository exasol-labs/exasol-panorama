import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import {
  BRANCH_NAMES,
  isLoadedFamily,
  isStructuralColumn,
  parseColumnName,
  presentedType,
  provenanceOf,
  readFamilyTable,
} from '@panorama/json-tables';
import {
  familyComment,
  jsonFamilyItems,
  jsonFamilyRoot,
  jsonFamilyTags,
} from '@panorama/test-support';

/**
 * The grammar, against the two projects it was read out of.
 *
 * Every case here is one either `exasol-json-tables` or `exasol-mongodb-vs`
 * actually emits, taken from their sources and their example manifest rather than
 * imagined — because the value of a parser for somebody else's format is exactly
 * how well it matches theirs, and a case nobody produces is a case not worth
 * being right about.
 */

const VARCHAR = dataType('varchar', 'VARCHAR(2000000)', { size: 2_000_000 });
const BOOL = dataType('boolean', 'BOOLEAN');
const INT = dataType('decimal', 'DECIMAL(19,0)', { precision: 19, scale: 0 });

const columns = (...names: readonly string[]) =>
  names.map((name) => ({ name, type: name.endsWith('|n') ? BOOL : VARCHAR }));

describe('reading a column name', () => {
  it('takes the structural columns out of the document', () => {
    for (const name of ['_id', '_parent', '_pos', '__mongodb_source_json']) {
      expect(parseColumnName(name), name).toBeNull();
      expect(isStructuralColumn(name)).toBe(true);
    }
    // `_value` is not one of them: a row of an array table *is* its value.
    expect(parseColumnName('_value')).toEqual({ property: '_value', marker: 'primary' });
  });

  it('reads each marker the contract defines', () => {
    expect(parseColumnName('note')).toEqual({ property: 'note', marker: 'primary' });
    expect(parseColumnName('note|n')).toEqual({ property: 'note', marker: 'nullMask' });
    expect(parseColumnName('empty_text|empty')).toEqual({
      property: 'empty_text',
      marker: 'emptyMask',
    });
    expect(parseColumnName('profile|object')).toEqual({ property: 'profile', marker: 'object' });
    expect(parseColumnName('tags|array')).toEqual({ property: 'tags', marker: 'array' });
    expect(parseColumnName('value|string')).toEqual({
      property: 'value',
      marker: 'alternate',
      branch: 'string',
    });
  });

  /**
   * A property called `n` gives `n|n`, and reading the suffix before splitting is
   * what gets it right. Split on the first `|` instead and the mask becomes a
   * property called `n` with a branch called `n`, which is not a branch at all.
   */
  it('reads a mask on a property whose own name is the suffix', () => {
    expect(parseColumnName('n|n')).toEqual({ property: 'n', marker: 'nullMask' });
    expect(parseColumnName('array|array')).toEqual({ property: 'array', marker: 'array' });
    // And a bare suffix is a property in its own right, not a mask for nothing.
    expect(parseColumnName('|n')).toEqual({ property: '|n', marker: 'primary' });
  });

  /**
   * The reason the branch vocabulary is closed.
   *
   * Read any `|` as a variant and a table with a column called `a|b` is reported
   * as a document family and drawn as one — masks inferred, cells collapsed, a
   * confident picture of something else entirely.
   */
  it('leaves a column alone whose suffix is not a branch this contract emits', () => {
    expect(parseColumnName('a|b')).toEqual({ property: 'a|b', marker: 'primary' });
    expect(parseColumnName('RATE|EUR')).toEqual({ property: 'RATE|EUR', marker: 'primary' });
    expect(readFamilyTable(columns('a|b', 'RATE|EUR'))).toBeNull();
  });

  it('accepts every branch name either loader spells', () => {
    for (const branch of BRANCH_NAMES) {
      expect(parseColumnName(`value|${branch}`), branch).toEqual({
        property: 'value',
        marker: 'alternate',
        branch,
      });
    }
    // Case-insensitively, since the manifest and the inference spell them apart.
    expect(parseColumnName('value|STRING')?.marker).toBe('alternate');
  });
});

describe('reading a table as a document', () => {
  const root = readFamilyTable(jsonFamilyRoot().columns);

  it('is nothing for an ordinary table, which is the whole of the detection', () => {
    expect(readFamilyTable(columns('ORDER_ID', 'CUSTOMER', 'AMOUNT'))).toBeNull();
  });

  it('groups the physical columns of the root into the properties they encode', () => {
    expect(root?.properties.map((property) => property.name)).toEqual([
      'mongo_id',
      'name',
      'empty_text',
      'note',
      'value',
      'created_at',
      'profile',
      'tags',
      'items',
    ]);
    // Nine properties out of thirteen columns, and `_id` is not one of them.
    expect(root?.structural.map((column) => column.name)).toEqual(['_id']);
    expect(root?.rowKey).toEqual({ name: '_id', index: 0 });
  });

  it('says what kind each property is', () => {
    const kinds = Object.fromEntries(
      (root?.properties ?? []).map((property) => [property.name, property.kind]),
    );
    expect(kinds).toMatchObject({
      name: 'scalar',
      empty_text: 'scalar',
      note: 'scalar',
      value: 'variant',
      profile: 'object',
      tags: 'array',
      items: 'array',
    });
  });

  it('keeps the branches in the order a value should be looked for', () => {
    const value = root?.properties.find((property) => property.name === 'value');
    // The primary first — the contract puts the strongest-evidence branch on the
    // bare name — then the alternates, each still knowing which type it is.
    expect(value?.branches.map((branch) => [branch.column, branch.branch])).toEqual([
      ['value', undefined],
      ['value|string', 'string'],
    ]);
    expect(value?.branches[0]?.type.name).toBe('DECIMAL(19,0)');
  });

  /**
   * A property present as `null` in every row the loader saw has a mask and no
   * value column, so there is no type to present it as — and inventing one would
   * be a claim about data that is not there.
   */
  it('has a presented type only where a value could actually arrive', () => {
    const value = root?.properties.find((property) => property.name === 'value');
    expect(presentedType(value as never)?.name).toBe('DECIMAL(19,0)');
    const nullOnly = readFamilyTable([
      { name: '_id', type: VARCHAR },
      { name: 'note|n', type: BOOL },
    ]);
    expect(nullOnly?.properties[0]).toMatchObject({ name: 'note', branches: [] });
    expect(presentedType(nullOnly?.properties[0] as never)).toBeUndefined();
  });

  it('points a property at the masks that say what its emptiness means', () => {
    const note = root?.properties.find((property) => property.name === 'note');
    expect(note?.nullMask).toBe(6);
    expect(note?.emptyMask).toBeUndefined();
    const empty = root?.properties.find((property) => property.name === 'empty_text');
    expect(empty?.emptyMask).toBe(4);
    expect(empty?.nullMask).toBeUndefined();
  });

  it('reads an array element table, where the row is the value', () => {
    const tags = readFamilyTable(jsonFamilyTags().columns);
    expect(tags?.structural.map((column) => column.name)).toEqual(['_parent', '_pos']);
    expect(tags?.parentKey).toEqual({ name: '_parent', index: 0 });
    expect(tags?.rowKey).toBeUndefined();
    // Presented as `value`, because `_value` is a fact about the storage.
    expect(tags?.properties.map((property) => property.name)).toEqual(['value']);
    expect(tags?.properties[0]?.nullMask).toBe(3);
  });

  it('reads an array of objects, which has both keys and children of its own', () => {
    const items = readFamilyTable(jsonFamilyItems().columns);
    expect(items?.rowKey?.name).toBe('_id');
    expect(items?.parentKey?.name).toBe('_parent');
    expect(items?.properties.map((property) => [property.name, property.kind])).toEqual([
      ['label', 'scalar'],
      ['flags', 'array'],
    ]);
  });

  /**
   * A property that is a list in some rows and a number in others.
   *
   * A variant as much as a string-or-number is: what varies is the type, and one
   * of the types needing a second table to hold it does not change the question.
   */
  it('calls a property that is sometimes nested and sometimes scalar a variant', () => {
    const family = readFamilyTable([
      { name: '_id', type: VARCHAR },
      { name: 'thing', type: INT },
      { name: 'thing|array', type: INT },
    ]);
    expect(family?.properties[0]).toMatchObject({ kind: 'variant', arrayCount: 2 });
  });

  /**
   * A root whose properties are all plain scalars is *identical* to an ordinary
   * table apart from its `_id`, so shape cannot settle it and the comment does.
   */
  it('reads a family with no markers only when something already said it is one', () => {
    const plain = [
      { name: '_id', type: VARCHAR },
      { name: 'name', type: VARCHAR },
    ];
    expect(readFamilyTable(plain)).toBeNull();
    expect(readFamilyTable(plain, { known: true })?.properties.map((one) => one.name)).toEqual([
      'name',
    ]);
    // But being told so does not conjure a document out of a table with no
    // structure at all: there would be nothing to say about it.
    expect(readFamilyTable(columns('A', 'B'), { known: true })).toBeNull();
  });
});

describe('the comment the loader leaves', () => {
  it('reads the provenance a loaded family carries', () => {
    expect(provenanceOf(familyComment('items[]'))).toEqual({
      source: 'people.ndjson',
      sourceConnection: 'local-file',
      importedAt: '2026-08-31T09:12:44Z',
      tablePath: 'items[]',
      tool: 'exasol-json-tables',
    });
  });

  it('finds it behind a note somebody wrote in front of it', () => {
    const comment = `Reload nightly. ${familyComment('root')}`;
    expect(provenanceOf(comment)?.tablePath).toBe('root');
  });

  it('is nothing where there is no comment, no marker, or no JSON', () => {
    expect(provenanceOf(undefined)).toBeNull();
    expect(provenanceOf('an ordinary table comment')).toBeNull();
    expect(provenanceOf('COPY provenance not-json-at-all')).toBeNull();
    expect(provenanceOf('COPY provenance {oops')).toBeNull();
    expect(provenanceOf('COPY provenance ["a list"]')).toBeNull();
    // A comment carrying the marker and an empty object is provenance with
    // nothing in it, which is different from no provenance.
    expect(provenanceOf('COPY provenance {}')).toEqual({});
  });

  /**
   * The signal that settles a family shape alone cannot: a root whose properties
   * are all plain scalars looks exactly like an ordinary table.
   */
  it('says whether a loader wrote the table', () => {
    expect(isLoadedFamily(familyComment('root'))).toBe(true);
    expect(isLoadedFamily(undefined)).toBe(false);
    expect(isLoadedFamily('a hand-written comment')).toBe(false);
    expect(isLoadedFamily('COPY provenance {"tool":"something-else"}')).toBe(false);
  });
});
