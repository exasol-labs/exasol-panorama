import type { SchemaListing, TableListing } from './types.js';

/**
 * Schema and table chooser.
 *
 * Choosing a table is a request, not a mutation: the shell reports the intent
 * and Panorama Core decides what to create.
 */

export interface SchemaExplorerProps {
  readonly schemas: readonly SchemaListing[];
  readonly tables: readonly TableListing[];
  readonly selectedSchema: string | null;
  readonly loadingSchemas?: boolean;
  readonly loadingTables?: boolean;
  readonly error?: string | null;
  readonly onSelectSchema: (schema: string) => void;
  readonly onOpenTable: (table: TableListing) => void;
}

export const SchemaExplorer = ({
  schemas,
  tables,
  selectedSchema,
  loadingSchemas = false,
  loadingTables = false,
  error = null,
  onSelectSchema,
  onOpenTable,
}: SchemaExplorerProps): React.JSX.Element => (
  <section className="pn-panel pn-explorer">
    <h2 className="pn-panel__title">Explorer</h2>

    {error !== null && error !== '' ? (
      <p className="pn-error" role="alert">
        {error}
      </p>
    ) : null}

    <label className="pn-field">
      <span>Schema</span>
      <select
        value={selectedSchema ?? ''}
        disabled={loadingSchemas || schemas.length === 0}
        onChange={(event) => onSelectSchema(event.target.value)}
      >
        <option value="" disabled>
          {loadingSchemas ? 'Loading…' : 'Choose a schema'}
        </option>
        {schemas.map((schema) => (
          <option key={schema.name} value={schema.name}>
            {schema.name}
          </option>
        ))}
      </select>
    </label>

    {loadingTables ? <p className="pn-hint">Loading tables…</p> : null}

    <ul className="pn-list" aria-label="Tables">
      {tables.map((table) => (
        <li key={`${table.schema}.${table.name}`}>
          <button type="button" onClick={() => onOpenTable(table)}>
            <span className="pn-list__name">{table.name}</span>
            <span className="pn-list__kind">{table.kind}</span>
          </button>
        </li>
      ))}
    </ul>

    {!loadingTables && selectedSchema !== null && tables.length === 0 ? (
      <p className="pn-hint">No tables in this schema.</p>
    ) : null}
  </section>
);
