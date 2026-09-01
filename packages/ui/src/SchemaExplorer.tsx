import { useCallback, useId, useState } from 'react';
import type { SchemaListing, TableListing } from './types.js';
import type { RelationNode } from './json-families.js';
import { documentPathOf, nestRelations } from './json-families.js';
import { LinkedText } from './LinkedText.js';
import { formatCompactCount, formatCount } from './format.js';

/**
 * Schema and table chooser.
 *
 * A tree rather than a dropdown. A dropdown could only ever show one schema's
 * contents at a time and gave no way to compare two, which is most of what
 * exploring a database is; and it hid the *shape* of the database behind an
 * interaction, when the shape is the thing being explored. Schemas are listed
 * closed, because a database has more of them than a sidebar has room for and
 * listing a schema's tables costs a query.
 *
 * The tree owns which schemas are open — pure view state, gone when the
 * connection is — and reports each opening as an intent. Whether that needs a
 * query is the shell's business: it holds what has been loaded and decides.
 *
 * Choosing a table is a request, not a mutation: the shell reports the intent
 * and Panorama Core decides what to create.
 *
 * Row counts are the database's own, taken from its catalogue along with the
 * listing rather than counted here. A view has none — its row count only exists
 * once the view has been run — so a view shows no number rather than a wrong
 * one, and opening a schema never sets a `COUNT(*)` going.
 */

/** What a database calls a relation that is stored rather than computed. */
const TABLE_KIND = 'TABLE';
const VIEW_KIND = 'VIEW';

export type SchemaLoadStatus = 'loading' | 'ready' | 'failed';

/** What one expanded schema holds, or why it does not. */
export interface SchemaContents {
  readonly status: SchemaLoadStatus;
  readonly tables?: readonly TableListing[];
  readonly error?: string;
}

/**
 * The connection the tree is a tree of.
 *
 * Shown here because once a connection is made the dialog that made it is a
 * form with nothing left to ask: it takes a quarter of the sidebar to say
 * "connected", and every field in it is disabled. So it goes, and what survives
 * of it is this — which database, and the way back out.
 */
export interface ExplorerConnection {
  /** Which database, short enough for a title row: see `connectionLabel`. */
  readonly label: string;
  /** The whole URL, for the tooltip. */
  readonly detail?: string;
  readonly onDisconnect: () => void;
}

export interface SchemaExplorerProps {
  readonly schemas: readonly SchemaListing[];
  readonly connection?: ExplorerConnection;
  /** Contents of the schemas that have been opened, by schema name. */
  readonly contents: ReadonlyMap<string, SchemaContents>;
  readonly loadingSchemas?: boolean;
  readonly error?: string | null;
  /**
   * Reports that a schema was opened. Called every time, including for one
   * already loaded: the tree says what the user did, and the shell decides
   * whether that means a query — which is also what makes a failed schema
   * retry by closing and opening it again.
   */
  readonly onExpandSchema: (schema: string) => void;
  readonly onOpenTable: (table: TableListing) => void;
}

/**
 * Icons as inline SVG rather than as glyphs.
 *
 * The halo spells its marks out in letters because it is drawn by the GPU from
 * a glyph atlas, where an icon would need a pipeline. Here there is a DOM, and
 * an inline SVG needs no pipeline either — no font to depend on, no request to
 * make, sharp at any pixel ratio, and coloured by whatever the row is coloured.
 *
 * There is a mark for a table and a mark for a view, and none for a schema. An
 * icon earns its place by telling one thing apart from another, and every row at
 * the top level is a schema — a mark they all share distinguishes nothing, and
 * the chevron beside it already says the row opens. A table and a view, on the
 * other hand, differ by one word, and at this size two words are
 * indistinguishable while a grid and an eye are not.
 */
const ICON = {
  viewBox: '0 0 16 16',
  width: 13,
  height: 13,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  'aria-hidden': true,
  focusable: false,
} as const;

/**
 * A power symbol: the way off this connection.
 *
 * An icon rather than the word, because the row it sits in is a title row with
 * a database name already in it — and a shape the size of a chevron cannot be
 * mistaken for a heading. It carries its own label for anything reading the page
 * aloud, and the tooltip names what it will disconnect from, because "off" is a
 * dangerous thing to press without knowing what it is off.
 */
const PowerIcon = (): React.JSX.Element => (
  <svg {...ICON} strokeWidth={1.6} strokeLinecap="round" className="pn-tree__icon">
    <path d="M4.9 4.9a4.4 4.4 0 1 0 6.2 0" />
    <path d="M8 2.4v4.4" />
  </svg>
);

/**
 * A grid: a stored relation.
 *
 * The header band is filled, and that is not decoration. An outline at this size
 * is a pixel and a half of stroke, which carries almost no colour — a hue with
 * nothing to sit in reads as grey, which is exactly how the first version of this
 * failed. A filled band gives the colour somewhere to be, at a third opacity so
 * it stays a mark rather than a block.
 */
const TableIcon = (): React.JSX.Element => (
  <svg {...ICON} className="pn-tree__icon pn-tree__icon--table">
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
    <path d="M2.2 3.9h11.6v2.5H2.2z" fill="currentColor" fillOpacity={0.32} stroke="none" />
    <path d="M2.2 6.4h11.6M7.4 6.4V13" />
  </svg>
);

/** An eye: a relation you look through rather than one that is there. */
const ViewIcon = (): React.JSX.Element => (
  <svg {...ICON} className="pn-tree__icon pn-tree__icon--view">
    <path d="M1.4 8S3.8 4 8 4s6.6 4 6.6 4-2.4 4-6.6 4S1.4 8 1.4 8Z" />
    <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * The same grid, drawn as something reached rather than held: two cells of it are
 * dashed, because part of this relation is not here.
 *
 * A colour alone would be the wrong way to carry this. Colour is what makes the
 * three kinds separable at a glance in a column of thirty rows, and it is the
 * *only* thing distinguishing a virtual table from a stored one if the shape does
 * not move — which fails for anyone who cannot tell the two hues apart, and fails
 * in a screenshot. So the mark differs too, and the row says the word.
 */
const VirtualTableIcon = (): React.JSX.Element => (
  <svg {...ICON} className="pn-tree__icon pn-tree__icon--virtual">
    <path d="M2.2 6.4V4.4a1.4 1.4 0 0 1 1.4-1.4h2.2M9.8 3h2.6a1.4 1.4 0 0 1 1.4 1.4v2" />
    <path d="M2.2 9.2v2.4A1.4 1.4 0 0 0 3.6 13h2.2M13.8 9.2v2.4a1.4 1.4 0 0 1-1.4 1.4H9.8" />
    {/* The same filled band as a stored table, so the two read as the same kind
        of thing — one of them reached rather than held. */}
    <path d="M3.2 3.9h9.6v2.5H3.2z" fill="currentColor" fillOpacity={0.32} stroke="none" />
    <path d="M2.2 6.4h11.6M7.4 7.6V13" />
  </svg>
);

/**
 * A schema whose contents are somewhere else.
 *
 * Ordinary schemas still carry no icon — a mark every row at the top level shares
 * distinguishes nothing, and the chevron already says the row opens. This one
 * appears *because* it is the difference: presence, not hue, is what separates a
 * virtual schema from a plain one, and the colour then ties it to the tables
 * inside it.
 */
const VirtualSchemaIcon = (): React.JSX.Element => (
  <svg
    {...ICON}
    strokeLinecap="round"
    className="pn-tree__icon pn-tree__icon--virtual pn-tree__icon--schema"
  >
    <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6" />
    <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6" />
  </svg>
);

const Chevron = ({ open }: { readonly open: boolean }): React.JSX.Element => (
  <svg
    {...ICON}
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`pn-tree__chevron${open ? ' pn-tree__chevron--open' : ''}`}
  >
    <path d="M6 4l4.2 4L6 12" />
  </svg>
);

const iconFor = (table: TableListing): React.JSX.Element => {
  if (table.kind.toUpperCase() === VIEW_KIND) return <ViewIcon />;
  return table.virtual === true ? <VirtualTableIcon /> : <TableIcon />;
};

/**
 * The row's tooltip: the count in full, and the comment, whichever there is.
 *
 * The visible count is abbreviated so that a column of them lines up, and
 * `2.83B` is not a number anyone can act on — so the exact figure is here,
 * where it costs no room.
 */
const describeRelation = (
  table: TableListing,
  siblings: readonly TableListing[] = [],
): string | undefined => {
  const parts: string[] = [];
  /**
   * Where in the document this table is, and what it is really called.
   *
   * A nested row is shown by its property name — the path is drawn by where the
   * row sits — so the table's own name is only here, which is where somebody
   * about to write SQL against it will look.
   */
  const path = documentPathOf(table, siblings);
  if (path !== undefined) parts.push(`${table.name} · ${path}`);
  /**
   * First, and spelled out: it explains the absent row count rather than leaving
   * it looking like a table nobody has gathered statistics for, and it is the one
   * thing here that changes what opening the relation will cost.
   */
  if (table.virtual === true) parts.push('Virtual: held by another system');
  if (table.rowCount !== undefined) parts.push(`${formatCount(table.rowCount)} rows`);
  if (table.comment !== undefined && table.comment !== '') parts.push(table.comment);
  return parts.length === 0 ? undefined : parts.join(' · ');
};

/** How far in a nested row sits, in the same rhythm as the tree's own indents. */
const NEST_STEP_PX = 14;
const nestedBy = (node: RelationNode): string => `${node.depth * NEST_STEP_PX}px`;

const rank = (kind: string): number => {
  const upper = kind.toUpperCase();
  if (upper === TABLE_KIND) return 0;
  if (upper === VIEW_KIND) return 1;
  // Anything else last, and spelled out beside its row: a database may report a
  // kind this was not written for, and guessing at an icon for it would be worse
  // than saying what it is.
  return 2;
};

/**
 * Tables first, then views, then anything else, each group keeping the order it
 * arrived in — the driver already sorts by name, and re-sorting here would only
 * be a second opinion about collation.
 */
export const groupRelations = (tables: readonly TableListing[]): readonly TableListing[] =>
  [...tables]
    .map((table, index) => ({ table, index }))
    .sort((a, b) => rank(a.table.kind) - rank(b.table.kind) || a.index - b.index)
    .map((entry) => entry.table);

export const SchemaExplorer = ({
  schemas,
  connection,
  contents,
  loadingSchemas = false,
  error = null,
  onExpandSchema,
  onOpenTable,
}: SchemaExplorerProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const treeId = useId();

  const toggle = useCallback(
    (name: string): void => {
      const opening = !expanded.includes(name);
      setExpanded(opening ? [...expanded, name] : expanded.filter((open) => open !== name));
      if (opening) onExpandSchema(name);
    },
    [expanded, onExpandSchema],
  );

  return (
    <section className="pn-panel pn-explorer">
      <div className="pn-panel__heading">
        <h2 className="pn-panel__title">Explorer</h2>
        {connection === undefined ? null : (
          <span
            className="pn-connected"
            {...(connection.detail === undefined ? {} : { title: connection.detail })}
          >
            <span className="pn-connected__dot" aria-hidden="true" />
            <span className="pn-connected__host">{connection.label}</span>
            <button
              type="button"
              className="pn-connected__off"
              aria-label={`Disconnect from ${connection.label}`}
              title={`Disconnect from ${connection.detail ?? connection.label}`}
              onClick={connection.onDisconnect}
            >
              <PowerIcon />
            </button>
          </span>
        )}
      </div>

      {error !== null && error !== '' ? (
        <p className="pn-error" role="alert">
          <LinkedText text={error} />
        </p>
      ) : null}

      {loadingSchemas ? <p className="pn-hint">Loading schemas…</p> : null}

      <ul className="pn-tree" aria-label="Schemas">
        {schemas.map((schema) => {
          const open = expanded.includes(schema.name);
          const held = contents.get(schema.name);
          const panelId = `${treeId}-${schema.name}`;
          return (
            <li key={schema.name}>
              <button
                type="button"
                className="pn-tree__row pn-tree__row--schema"
                {...(schema.virtual === true
                  ? { title: 'Virtual schema: its contents are held by another system' }
                  : {})}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(schema.name)}
              >
                <Chevron open={open} />
                <span className="pn-tree__name pn-tree__name--schema">{schema.name}</span>
                {/*
                  After the name, not before it.

                  A virtual schema is the only row in the tree with a mark of its
                  own, so ahead of the word it made a column that existed for one
                  row in thirty and pushed that row's name out of line with every
                  other. Behind the word, every name starts in the same place and
                  the mark reads as something said about the schema once you have
                  read which schema it is.
                */}
                {schema.virtual === true ? <VirtualSchemaIcon /> : null}
                {/*
                  The word, for everyone the mark does not reach.

                  Not shown: a caption on every virtual schema was, on a panel of
                  thirty rows, the loudest thing in it — which is the opposite of
                  what a mark this size is for. So the visible signal is the mark
                  and its colour, and the word is in the row's accessible name and
                  in its tooltip, where it costs nobody any attention and is still
                  there for a reader who is listening to the page or cannot
                  separate two muted hues.
                */}
                {schema.virtual === true ? (
                  <span className="pn-visually-hidden"> (virtual schema)</span>
                ) : null}
              </button>

              {open ? (
                <div id={panelId} className="pn-tree__branch">
                  {held === undefined || held.status === 'loading' ? (
                    <p className="pn-hint">Loading…</p>
                  ) : null}
                  {held?.status === 'failed' ? (
                    <p className="pn-error" role="alert">
                      <LinkedText text={held.error ?? 'Could not list this schema'} />
                    </p>
                  ) : null}
                  {held?.status === 'ready' && held.tables?.length === 0 ? (
                    <p className="pn-hint">Nothing in this schema.</p>
                  ) : null}
                  {held?.status === 'ready' && (held.tables?.length ?? 0) > 0 ? (
                    <ul className="pn-tree__children" aria-label={`Relations in ${schema.name}`}>
                      {nestRelations(groupRelations(held.tables ?? [])).map((node) => (
                        <li key={`${node.table.kind}.${node.table.name}`}>
                          <button
                            type="button"
                            className="pn-tree__row"
                            title={describeRelation(node.table, held.tables ?? [])}
                            /*
                              Indented by how deep in the document it sits. A
                              style rather than a class because the depth is a
                              number and there is no sensible number of classes
                              for "however deep this document goes".
                            */
                            style={node.depth === 0 ? undefined : { paddingLeft: nestedBy(node) }}
                            onClick={() => onOpenTable(node.table)}
                          >
                            {iconFor(node.table)}
                            {/*
                              The mark goes *inside* the name, against the word.
                              Beside it, in the row's own flex gap, it drifts to
                              the right edge and pairs up with the row count —
                              `[] 3` reads as one number nobody can parse. Inside
                              rather than merely after, unlike the virtual mark on
                              a schema row, because this row has a count on the
                              right that still has to be pushed there.
                            */}
                            <span className="pn-tree__name">
                              {node.label}
                              {node.nesting === undefined ? null : (
                                <span
                                  className="pn-tree__nesting"
                                  aria-label={node.nesting === 'array' ? ' (list)' : ' (object)'}
                                >
                                  {node.nesting === 'array' ? '[]' : '{}'}
                                </span>
                              )}
                            </span>
                            {rank(node.table.kind) === 2 ? (
                              <span className="pn-tree__kind">{node.table.kind}</span>
                            ) : null}
                            {node.table.rowCount === undefined ? null : (
                              <span className="pn-tree__count">
                                {formatCompactCount(node.table.rowCount)}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {!loadingSchemas && schemas.length === 0 ? (
        <p className="pn-hint">No schemas on this connection.</p>
      ) : null}
    </section>
  );
};
