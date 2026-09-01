/**
 * Where a family came from, as the loader stamped it on the table.
 *
 * `exasol-json-tables` writes a comment on every table it creates:
 *
 *     COPY provenance {"source":"orders.ndjson","sourceConnection":"local-file",
 *                      "importedAt":"2026-08-31T09:12:44Z","tablePath":"items[]",
 *                      "tool":"exasol-json-tables"}
 *
 * Two things worth having out of it. `tool` says the shape *is* the contract
 * rather than merely looking like it, which settles the one case column shape
 * cannot (see `readFamilyTable`). And `tablePath` says where in the document this
 * table sits — `root`, `customer`, `items[]` — which is the document's own answer
 * to a question the physical table name only approximates.
 *
 * Read leniently and reported as absent rather than as an error: a comment is a
 * free-text field a person may have edited, and a family whose comment somebody
 * rewrote is still a family. Nothing here is required for the feature to work.
 */

export const PROVENANCE_PREFIX = 'COPY provenance ';

/** The tools that write this comment. */
export const JSON_TABLES_TOOL = 'exasol-json-tables';

export interface Provenance {
  /** The file, URI or table the family was loaded from. */
  readonly source?: string;
  readonly sourceConnection?: string;
  readonly importedAt?: string;
  readonly sourceModifiedAt?: string;
  /** `root`, or a dotted path with `[]` for each array level. */
  readonly tablePath?: string;
  readonly tool?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The provenance in a table comment, or `null` where there is none.
 *
 * The comment may carry anything before the marker — a person's own note about
 * the table, which the loader does not remove — so the JSON is taken from the
 * first `{` after the marker to the end.
 */
export const provenanceOf = (comment: string | undefined): Provenance | null => {
  if (comment === undefined) return null;
  const marker = comment.indexOf(PROVENANCE_PREFIX);
  if (marker < 0) return null;
  const opens = comment.indexOf('{', marker);
  if (opens < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment.slice(opens));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  return {
    ...(text(fields['source']) === undefined ? {} : { source: text(fields['source']) as string }),
    ...(text(fields['sourceConnection']) === undefined
      ? {}
      : { sourceConnection: text(fields['sourceConnection']) as string }),
    ...(text(fields['importedAt']) === undefined
      ? {}
      : { importedAt: text(fields['importedAt']) as string }),
    ...(text(fields['sourceModifiedAt']) === undefined
      ? {}
      : { sourceModifiedAt: text(fields['sourceModifiedAt']) as string }),
    ...(text(fields['tablePath']) === undefined
      ? {}
      : { tablePath: text(fields['tablePath']) as string }),
    ...(text(fields['tool']) === undefined ? {} : { tool: text(fields['tool']) as string }),
  };
};

/** True where a comment says outright that this table is part of a family. */
export const isLoadedFamily = (comment: string | undefined): boolean =>
  provenanceOf(comment)?.tool === JSON_TABLES_TOOL;
