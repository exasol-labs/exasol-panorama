/**
 * Built-in synthetic relations.
 *
 * Available with no database connected: the table experience is the Stage 1
 * deliverable, and it must be demonstrable — and profilable — on its own.
 */

import { formatCompactCount } from './format.js';

export interface SampleTable {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface SampleDataPanelProps {
  readonly tables: readonly SampleTable[];
  readonly onOpen: (name: string) => void;
}

export const SampleDataPanel = ({ tables, onOpen }: SampleDataPanelProps): React.JSX.Element => (
  <section className="pn-panel pn-samples">
    <h2 className="pn-panel__title">Sample data</h2>
    <ul className="pn-list" aria-label="Sample tables">
      {tables.map((table) => (
        <li key={table.name}>
          <button type="button" onClick={() => onOpen(table.name)}>
            <span className="pn-list__name">{table.name}</span>
            <span className="pn-list__kind">
              {formatCompactCount(table.rowCount)} × {formatCompactCount(table.columnCount)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  </section>
);
