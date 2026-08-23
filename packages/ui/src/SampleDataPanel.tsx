/**
 * Built-in synthetic relations.
 *
 * Available with no database connected: the table experience is the Stage 1
 * deliverable, and it must be demonstrable — and profilable — on its own.
 */

export interface SampleTable {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface SampleDataPanelProps {
  readonly tables: readonly SampleTable[];
  readonly onOpen: (name: string) => void;
}

const compact = (value: number): string => {
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled.toFixed(scaled >= 10 ? 0 : 2)}${suffix}`;
    }
  }
  return String(value);
};

export const SampleDataPanel = ({ tables, onOpen }: SampleDataPanelProps): React.JSX.Element => (
  <section className="pn-panel pn-samples">
    <h2 className="pn-panel__title">Sample data</h2>
    <ul className="pn-list" aria-label="Sample tables">
      {tables.map((table) => (
        <li key={table.name}>
          <button type="button" onClick={() => onOpen(table.name)}>
            <span className="pn-list__name">{table.name}</span>
            <span className="pn-list__kind">
              {compact(table.rowCount)} × {compact(table.columnCount)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  </section>
);
