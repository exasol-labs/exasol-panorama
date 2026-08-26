import { formatBytes, formatCount } from './format.js';

/**
 * Exports in flight, and the ones that just finished.
 *
 * The halo starts an export; this is where it is watched. A file being written
 * from a ten-billion-row table takes as long as it takes, so it needs somewhere
 * to report progress and something to press to stop — and neither belongs on the
 * canvas, which is for the data itself. It is conventional UI, so it is React,
 * like the connection dialog and the explorer.
 *
 * The panel is absent until something has been exported: an empty box that says
 * "no exports" is furniture.
 */

export type ExportProgressStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ExportListing {
  readonly id: number;
  readonly tableName: string;
  readonly fileName: string;
  /** Human name of the format, e.g. `Parquet`. */
  readonly formatLabel: string;
  readonly status: ExportProgressStatus;
  readonly rows: number;
  readonly bytes: number;
  readonly totalRows: number | null;
  readonly error?: string;
}

export interface ExportPanelProps {
  readonly exports: readonly ExportListing[];
  readonly onCancel: (id: number) => void;
  readonly onDismiss: (id: number) => void;
}

const STATUS_TEXT: Readonly<Record<ExportProgressStatus, string>> = Object.freeze({
  running: 'Writing',
  done: 'Saved',
  failed: 'Failed',
  cancelled: 'Stopped',
});

/**
 * How far along, when that is knowable.
 *
 * A relation whose row count the source cannot report has no percentage to
 * show, and inventing one from bytes written would be a guess dressed as a fact
 * — so those show a count instead.
 */
const progressText = (listing: ExportListing): string => {
  const rows = formatCount(listing.rows);
  const bytes = formatBytes(listing.bytes);
  if (listing.totalRows === null || listing.totalRows === 0) return `${rows} rows · ${bytes}`;
  const share = Math.min(100, Math.round((listing.rows / listing.totalRows) * 100));
  return `${share}% · ${rows} of ${formatCount(listing.totalRows)} rows · ${bytes}`;
};

const fraction = (listing: ExportListing): number | null => {
  if (listing.status === 'done') return 1;
  if (listing.totalRows === null || listing.totalRows === 0) return null;
  return Math.min(1, listing.rows / listing.totalRows);
};

export const ExportPanel = ({
  exports,
  onCancel,
  onDismiss,
}: ExportPanelProps): React.JSX.Element | null => {
  if (exports.length === 0) return null;
  return (
    <section className="pn-panel pn-exports">
      <h2 className="pn-panel__title">Exports</h2>
      <ul className="pn-list" aria-label="Exports">
        {exports.map((listing) => {
          const share = fraction(listing);
          return (
            <li key={listing.id} className={`pn-export pn-export--${listing.status}`}>
              <div className="pn-export__head">
                <span className="pn-export__name" title={listing.fileName}>
                  {listing.fileName}
                </span>
                <span className="pn-export__format">{listing.formatLabel}</span>
              </div>
              <div
                className="pn-export__bar"
                role="progressbar"
                aria-label={`${listing.fileName} export`}
                {...(share === null
                  ? {}
                  : {
                      'aria-valuemin': 0,
                      'aria-valuemax': 100,
                      'aria-valuenow': Math.round(share * 100),
                    })}
              >
                <span
                  className="pn-export__fill"
                  // An unknowable total gets a full-width track rather than a
                  // bar that pretends to know where it is.
                  style={{ width: share === null ? '100%' : `${Math.round(share * 100)}%` }}
                />
              </div>
              <div className="pn-export__foot">
                <span className="pn-export__status">
                  {STATUS_TEXT[listing.status]}
                  {listing.status === 'running' ? ` · ${progressText(listing)}` : ''}
                  {listing.status === 'done' ? ` · ${progressText(listing)}` : ''}
                </span>
                {listing.status === 'running' ? (
                  <button type="button" onClick={() => onCancel(listing.id)}>
                    Stop
                  </button>
                ) : (
                  <button type="button" onClick={() => onDismiss(listing.id)}>
                    Dismiss
                  </button>
                )}
              </div>
              {listing.error === undefined ? null : (
                <p className="pn-error" role="alert">
                  {listing.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
