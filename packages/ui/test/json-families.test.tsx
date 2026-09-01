import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TableListing } from '@panorama/ui';
import { SchemaExplorer, documentPathOf, familyRootsIn, nestRelations } from '@panorama/ui';
import { familyComment } from '@panorama/test-support';

/**
 * Gathering a document's tables under one entry.
 *
 * The explorer has names, kinds, counts and comments and no columns, so the
 * shape test that settles this everywhere else is not available. What is left is
 * names and evidence — and the cost of getting it wrong is a schema of ordinary
 * tables drawn as a document tree, so most of what is asserted here is the
 * *refusal* to nest.
 */

const listing = (name: string, comment?: string): TableListing => ({
  schema: 'S',
  name,
  kind: 'TABLE',
  ...(comment === undefined ? {} : { comment }),
});

/** As `exasol-json-tables` writes it: a provenance comment on every table. */
const loaded = [
  listing('PEOPLE', familyComment('root')),
  listing('PEOPLE_items_arr', familyComment('items[]')),
  listing('PEOPLE_items_arr_flags_arr', familyComment('items[].flags[]')),
  listing('PEOPLE_profile', familyComment('profile')),
  listing('PEOPLE_tags_arr', familyComment('tags[]')),
];

/** As `exasol-mongodb-vs` exposes it: a virtual schema, so no comments at all. */
const federated = loaded.map((table) => listing(table.name));

describe('finding the families in a schema', () => {
  it('follows a loaded family up to its root', () => {
    expect([...familyRootsIn(loaded)]).toEqual(['PEOPLE']);
  });

  /**
   * No comments to read, so the evidence is the `_arr` suffix — the contract's
   * array marker, and not a thing people name tables.
   */
  it('finds one with no comments at all, from the array marker', () => {
    expect([...familyRootsIn(federated)]).toEqual(['PEOPLE']);
  });

  /**
   * The case worth being careful about. `ORDERS_ARCHIVE` beside `ORDERS` is two
   * tables, and drawing the second as part of the first would be a confident
   * picture of a relationship that does not exist.
   */
  it('finds none where a name merely looks like a child', () => {
    expect([...familyRootsIn([listing('ORDERS'), listing('ORDERS_ARCHIVE')])]).toEqual([]);
    expect(nestRelations([listing('ORDERS'), listing('ORDERS_ARCHIVE')])).toEqual([
      { table: listing('ORDERS'), depth: 0, label: 'ORDERS' },
      { table: listing('ORDERS_ARCHIVE'), depth: 0, label: 'ORDERS_ARCHIVE' },
    ]);
  });

  it('finds none in a schema of ordinary tables', () => {
    expect([...familyRootsIn([listing('ORDERS'), listing('CUSTOMERS')])]).toEqual([]);
  });
});

describe('nesting them', () => {
  const nodes = nestRelations(loaded);

  it('reads top to bottom in the order the document nests', () => {
    expect(nodes.map((node) => [node.depth, node.label])).toEqual([
      [0, 'PEOPLE'],
      [1, 'items'],
      [2, 'flags'],
      [1, 'profile'],
      [1, 'tags'],
    ]);
  });

  it('says which of the two kinds of nesting each child is', () => {
    expect(nodes.map((node) => node.nesting)).toEqual([
      undefined,
      'array',
      'array',
      'object',
      'array',
    ]);
  });

  /**
   * One evident child establishes the whole family. Requiring evidence from each
   * table separately would nest the arrays and leave `PEOPLE_profile` behind,
   * which reads as a bug rather than as caution.
   */
  it('takes an object child along on the evidence of an array sibling', () => {
    const nested = nestRelations(federated);
    expect(nested.find((node) => node.label === 'profile')).toMatchObject({
      depth: 1,
      nesting: 'object',
    });
  });

  it('leaves everything that is not a document where it was', () => {
    const mixed = nestRelations([listing('ORDERS'), ...loaded, listing('CUSTOMERS')]);
    expect(mixed.map((node) => node.label)).toEqual([
      'ORDERS',
      'PEOPLE',
      'items',
      'flags',
      'profile',
      'tags',
      'CUSTOMERS',
    ]);
  });

  it('says where a table sits, for anybody about to write SQL against it', () => {
    expect(documentPathOf(loaded[2] as TableListing, loaded)).toBe('items[].flags[]');
    expect(documentPathOf(loaded[0] as TableListing, loaded)).toBeUndefined();
  });
});

describe('the explorer showing a family', () => {
  const renderTree = (tables: readonly TableListing[]) =>
    render(
      <SchemaExplorer
        schemas={[{ name: 'S' }]}
        connection={{ label: 'test', onDisconnect: () => {} }}
        contents={new Map([['S', { status: 'ready' as const, tables: [...tables] }]])}
        onExpandSchema={() => {}}
        onOpenTable={() => {}}
      />,
    );

  it('shows a document as one entry with its shape under it', async () => {
    const { container } = renderTree(loaded);
    fireEvent.click(screen.getByRole('button', { name: /^S/u }));
    // The five tables are five rows still — they are five tables — but four of
    // them are now named by the property they are and sit under the one they
    // belong to.
    // The nesting mark lives inside the label, so the label's own text is read
    // by dropping it — which is also what says the mark is where it is.
    const rows = [...container.querySelectorAll('.pn-tree__children .pn-tree__name')].map((node) =>
      node.firstChild?.textContent?.trim(),
    );
    expect(rows).toEqual(['PEOPLE', 'items', 'flags', 'profile', 'tags']);
    expect(container.querySelectorAll('.pn-tree__nesting')).toHaveLength(4);
  });

  it('keeps the real name where somebody about to query it will look', () => {
    const { container } = renderTree(loaded);
    fireEvent.click(screen.getByRole('button', { name: /^S/u }));
    const flags = [...container.querySelectorAll('.pn-tree__row')].find(
      (node) => node.querySelector('.pn-tree__name')?.firstChild?.textContent === 'flags',
    );
    expect(flags?.getAttribute('title')).toContain('PEOPLE_items_arr_flags_arr');
    expect(flags?.getAttribute('title')).toContain('items[].flags[]');
  });

  it('leaves a schema of ordinary tables exactly as it was', () => {
    const { container } = renderTree([listing('ORDERS'), listing('CUSTOMERS')]);
    fireEvent.click(screen.getByRole('button', { name: /^S/u }));
    expect(
      [...container.querySelectorAll('.pn-tree__children .pn-tree__name')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['ORDERS', 'CUSTOMERS']);
    expect(container.querySelectorAll('.pn-tree__nesting')).toHaveLength(0);
  });
});
