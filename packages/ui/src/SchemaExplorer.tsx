import { useCallback, useId, useState } from 'react';
import type { SchemaListing, TableListing } from './types.js';
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

/** A grid: a stored relation. */
const TableIcon = (): React.JSX.Element => (
  <svg {...ICON} className="pn-tree__icon">
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
    <path d="M2.2 6.4h11.6M7.4 6.4V13" />
  </svg>
);

/** An eye: a relation you look through rather than one that is there. */
const ViewIcon = (): React.JSX.Element => (
  <svg {...ICON} className="pn-tree__icon">
    <path d="M1.4 8S3.8 4 8 4s6.6 4 6.6 4-2.4 4-6.6 4S1.4 8 1.4 8Z" />
    <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
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

const iconFor = (kind: string): React.JSX.Element =>
  kind.toUpperCase() === VIEW_KIND ? <ViewIcon /> : <TableIcon />;

/**
 * The row's tooltip: the count in full, and the comment, whichever there is.
 *
 * The visible count is abbreviated so that a column of them lines up, and
 * `2.83B` is not a number anyone can act on — so the exact figure is here,
 * where it costs no room.
 */
const describeRelation = (table: TableListing): string | undefined => {
  const parts: string[] = [];
  if (table.rowCount !== undefined) parts.push(`${formatCount(table.rowCount)} rows`);
  if (table.comment !== undefined && table.comment !== '') parts.push(table.comment);
  return parts.length === 0 ? undefined : parts.join(' · ');
};

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
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(schema.name)}
              >
                <Chevron open={open} />
                <span className="pn-tree__name">{schema.name}</span>
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
                      {groupRelations(held.tables ?? []).map((table) => (
                        <li key={`${table.kind}.${table.name}`}>
                          <button
                            type="button"
                            className="pn-tree__row"
                            title={describeRelation(table)}
                            onClick={() => onOpenTable(table)}
                          >
                            {iconFor(table.kind)}
                            <span className="pn-tree__name">{table.name}</span>
                            {rank(table.kind) === 2 ? (
                              <span className="pn-tree__kind">{table.kind}</span>
                            ) : null}
                            {table.rowCount === undefined ? null : (
                              <span className="pn-tree__count">
                                {formatCompactCount(table.rowCount)}
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
