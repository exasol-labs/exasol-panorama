import type {
  SemanticColumnView,
  SemanticFieldKind,
  SemanticMetricKind,
  SemanticPairing,
} from '@panorama/core';
import type { ExasolValue } from '../protocol/messages.js';
import {
  semanticFieldsQuery,
  semanticInvalidPairsQuery,
  semanticMetricsQuery,
  semanticModelsQuery,
  semanticVersionQuery,
} from '../protocol/sql.js';
// The same shape of caller as the wrapper surface has, and deliberately the same
// type: both are "run a metadata query", and two names for it would suggest a
// difference that is not there.
import type { QueryRows } from './json-wrapper.js';

/**
 * The semantic layer, as the database describes it.
 *
 * `exasol-semantic-views` records what a database's numbers *mean* — which
 * columns are metrics and which are things to group by, what to call them, how
 * to write them down, who has vouched for them — and publishes it as ordinary
 * views in `SEMANTIC_CATALOG` and `SEMANTIC_AGENT`. Where a model has been
 * published, its objects also exist as real views, and those are the relations a
 * reader opens.
 *
 * This module reads that description and nothing else. It does not compile
 * semantic SQL and it does not set the semantic preprocessor — both are the next
 * slice, and both are deliberately absent here so that knowing what a column
 * means costs no session state at all.
 *
 * `null` from `readSemanticSurface` is the detection, and it is the ordinary
 * answer: almost no connection has the layer installed.
 */

/** One semantic model, published or still being written. */
export interface SemanticModel {
  readonly id: number;
  readonly name: string;
  /** The schema its objects are published to — created only once it is published. */
  readonly publishedSchema: string;
  /**
   * Whether the views are actually there.
   *
   * The whole reason this is carried: an unpublished model's `PUBLISHED_SCHEMA`
   * is a name it *intends* to use, and on a real instance three drafts named
   * `SEMANTIC_SALES` alongside the published model that owns it. Letting a draft
   * describe the views of a schema it has never written to would put one model's
   * meanings on another model's columns.
   */
  readonly published: boolean;
  readonly description?: string;
}

/**
 * One field of one semantic object, with the physical names to match it by.
 *
 * Everything a column view carries except the model, which a field does not know
 * by name — it knows an id, and turning that into "who says so" is what
 * `indexSemanticFields` does once it has both halves.
 */
export interface SemanticField extends Omit<SemanticColumnView, 'model'> {
  /** The published view's name, upper-cased as the publish step creates it. */
  readonly object: string;
  /** The published view's column name, likewise. */
  readonly column: string;
}

/** How one metric combines, which `FIELDS_FOR_AGENT` does not say. */
export interface SemanticMetric {
  readonly modelId: number;
  readonly metricId: number;
  readonly kind?: SemanticMetricKind;
  readonly aggregation?: string;
}

/** One metric × dimension pairing the model refuses. */
export interface SemanticInvalidPair extends SemanticPairing {
  readonly modelId: number;
  readonly metricId: number;
  readonly dimensionId: number;
}

/** Everything the layer says, read once per connection. */
export interface SemanticSurface {
  /** The installed build, as it describes itself; `0.1+dev` and the like. */
  readonly version: string;
  readonly models: readonly SemanticModel[];
  readonly fields: readonly SemanticField[];
  readonly metrics: readonly SemanticMetric[];
  /** Only the refusals; see `semanticInvalidPairsQuery`. */
  readonly invalidPairs: readonly SemanticInvalidPair[];
}

const text = (value: ExasolValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/** Only `true` is true; see `toFlag` in the connection for why that is spelled out. */
const flag = (value: ExasolValue | undefined): boolean =>
  value === true || value === 'true' || value === 1;

/**
 * Reads the semantic layer, or reports that there is not one.
 *
 * Three queries, run once and remembered. The first is the detection and the
 * cheap one: a connection with no semantic layer pays for a single failing
 * lookup and stops there, which is what nearly every connection does.
 *
 * A layer that is installed but unreadable — the views exist and the user has no
 * grant on them — costs the meanings and not the connection, the same rule the
 * wrapper surface follows. Browsing tables must not depend on being allowed to
 * read somebody's catalogue.
 */
export const readSemanticSurface = async (query: QueryRows): Promise<SemanticSurface | null> => {
  const installed = await query(semanticVersionQuery()).catch(() => null);
  const version = installed === null ? null : text(installed[0]?.[0]);
  if (version === null) return null;

  const models = await query(semanticModelsQuery()).catch(() => []);
  const fields = await query(semanticFieldsQuery()).catch(() => []);
  const metrics = await query(semanticMetricsQuery()).catch(() => []);
  const pairs = await query(semanticInvalidPairsQuery()).catch(() => []);
  return {
    version,
    models: readModels(models),
    fields: readFields(fields),
    metrics: readMetrics(metrics),
    invalidPairs: readInvalidPairs(pairs),
  };
};

const METRIC_KINDS: readonly SemanticMetricKind[] = [
  'SIMPLE',
  'FILTERED',
  'RATIO',
  'DERIVED',
  'CUMULATIVE',
];

const readMetrics = (rows: ReadonlyArray<readonly ExasolValue[]>): readonly SemanticMetric[] => {
  const found: SemanticMetric[] = [];
  for (let row = 0; row < (rows[0]?.length ?? 0); row += 1) {
    const modelId = Number(rows[0]?.[row]);
    const metricId = Number(rows[1]?.[row]);
    if (!Number.isFinite(modelId) || !Number.isFinite(metricId)) continue;
    const kind = METRIC_KINDS.find((known) => known === text(rows[2]?.[row]));
    const aggregation = text(rows[3]?.[row]);
    found.push({
      modelId,
      metricId,
      ...(kind === undefined ? {} : { kind }),
      ...(aggregation === null ? {} : { aggregation }),
    });
  }
  return found;
};

const readInvalidPairs = (
  rows: ReadonlyArray<readonly ExasolValue[]>,
): readonly SemanticInvalidPair[] => {
  const found: SemanticInvalidPair[] = [];
  for (let row = 0; row < (rows[0]?.length ?? 0); row += 1) {
    const modelId = Number(rows[0]?.[row]);
    const metricId = Number(rows[1]?.[row]);
    const dimensionId = Number(rows[2]?.[row]);
    const code = text(rows[3]?.[row]);
    if (!Number.isFinite(modelId) || !Number.isFinite(metricId) || !Number.isFinite(dimensionId)) {
      continue;
    }
    // A refusal with no reason is still a refusal, but it is not one a person
    // can be shown, so it is not one this reports.
    if (code === null) continue;
    const path = text(rows[4]?.[row]);
    found.push({ modelId, metricId, dimensionId, code, ...(path === null ? {} : { path }) });
  }
  return found;
};

const readModels = (rows: ReadonlyArray<readonly ExasolValue[]>): readonly SemanticModel[] => {
  const found: SemanticModel[] = [];
  for (let row = 0; row < (rows[0]?.length ?? 0); row += 1) {
    const id = Number(rows[0]?.[row]);
    const name = text(rows[1]?.[row]);
    const publishedSchema = text(rows[2]?.[row]);
    const description = text(rows[3]?.[row]);
    if (!Number.isFinite(id) || name === null || publishedSchema === null) continue;
    found.push({
      id,
      name,
      publishedSchema,
      published: text(rows[4]?.[row]) === 'PUBLISHED',
      ...(description === null ? {} : { description }),
    });
  }
  return found;
};

const FIELD_KINDS: Readonly<Record<string, SemanticFieldKind>> = {
  METRIC: 'metric',
  DIMENSION: 'dimension',
};

const readFields = (rows: ReadonlyArray<readonly ExasolValue[]>): readonly SemanticField[] => {
  const found: SemanticField[] = [];
  for (let row = 0; row < (rows[0]?.length ?? 0); row += 1) {
    const modelId = Number(rows[0]?.[row]);
    const fieldId = Number(rows[10]?.[row]);
    const object = text(rows[1]?.[row]);
    const column = text(rows[2]?.[row]);
    // A field kind the layer grows later is a field this cannot present, and
    // silently calling it a dimension would put it on a chart's category axis.
    const kind = FIELD_KINDS[String(rows[3]?.[row])];
    if (
      !Number.isFinite(modelId) ||
      !Number.isFinite(fieldId) ||
      object === null ||
      column === null ||
      kind === undefined
    ) {
      continue;
    }
    const displayName = text(rows[4]?.[row]);
    const description = text(rows[5]?.[row]);
    const format = text(rows[6]?.[row]);
    const unit = text(rows[7]?.[row]);
    const sensitivity = text(rows[9]?.[row]);
    found.push({
      modelId,
      fieldId,
      object,
      column,
      kind,
      ...(displayName === null ? {} : { displayName }),
      ...(description === null ? {} : { description }),
      ...(format === null ? {} : { format }),
      ...(unit === null ? {} : { unit }),
      ...(flag(rows[8]?.[row]) ? { certified: true } : {}),
      ...(sensitivity === null ? {} : { sensitivity }),
    });
  }
  return found;
};

/** How a published object is keyed here, and by whoever looks one up. */
export const semanticObjectKey = (schema: string, object: string): string => `${schema}.${object}`;

/** The meanings of one published object's columns, by column name. */
export type SemanticColumns = ReadonlyMap<string, SemanticColumnView>;

/**
 * Everything a box or a chart editor has to ask, in two lookups.
 *
 * `objects` answers "what do this relation's columns mean". `refusals` answers
 * "may this metric be broken down by that dimension" — a question about two
 * fields of one model, which is why it is keyed by their ids rather than by the
 * object either of them is published in.
 */
export interface SemanticIndex {
  readonly objects: ReadonlyMap<string, SemanticColumns>;
  readonly refusals: ReadonlyMap<string, SemanticPairing>;
}

/** An index over nothing, which is what a connection without the layer has. */
export const EMPTY_SEMANTIC_INDEX: SemanticIndex = { objects: new Map(), refusals: new Map() };

const pairingKey = (modelId: number, metricId: number, dimensionId: number): string =>
  `${modelId}:${metricId}:${dimensionId}`;

/**
 * Why the model refuses to break this metric down by this dimension, if it does.
 *
 * `undefined` is "nothing said", and that is not the same as "safe": a metric and
 * a dimension published in two different objects never appear in the matrix at
 * all. What it does mean is that there is nothing to warn anybody about, which is
 * the only thing a chart editor can act on.
 */
export const semanticRefusal = (
  index: SemanticIndex,
  metric: SemanticColumnView | undefined,
  dimension: SemanticColumnView | undefined,
): SemanticPairing | undefined => {
  if (metric?.kind !== 'metric' || dimension?.kind !== 'dimension') return undefined;
  if (metric.modelId !== dimension.modelId) return undefined;
  return index.refusals.get(pairingKey(metric.modelId, metric.fieldId, dimension.fieldId));
};

/**
 * The surface as something a table box can be looked up in.
 *
 * Two rules live here, and only here.
 *
 * **Only published models describe anything.** A draft's published schema is an
 * intention, and on the instance this was written against three drafts named a
 * schema a fourth, published model owns. Their fields would otherwise land on
 * that model's views.
 *
 * **Where two published models still claim the same object, the newer wins —
 * whole.** Publishing is `CREATE OR REPLACE VIEW`, so the view that is there is
 * the one published last and there is exactly one right answer;
 * `semanticModelsQuery` orders by `UPDATED_AT` so walking the models in order
 * leaves the newest claim standing. Whole, and not column by column: half of one
 * model's meanings mixed with half of another's would describe a view that never
 * existed. This is the opposite of the wrapper preprocessor's ambiguity, where
 * several candidates were all equally correct and none was more current.
 */
export const indexSemanticFields = (surface: SemanticSurface | null): SemanticIndex => {
  if (surface === null) return EMPTY_SEMANTIC_INDEX;
  const metrics = new Map(
    surface.metrics.map((metric) => [`${metric.modelId}:${metric.metricId}`, metric]),
  );
  const byModel = new Map<number, SemanticField[]>();
  for (const field of surface.fields) {
    const fields = byModel.get(field.modelId) ?? [];
    fields.push(field);
    byModel.set(field.modelId, fields);
  }
  const refusals = new Map<string, SemanticPairing>(
    surface.invalidPairs.map((pair) => [
      pairingKey(pair.modelId, pair.metricId, pair.dimensionId),
      { code: pair.code, ...(pair.path === undefined ? {} : { path: pair.path }) },
    ]),
  );
  const index = new Map<string, Map<string, SemanticColumnView>>();
  for (const model of surface.models) {
    if (!model.published) continue;
    // Cleared per object, not per model: a model claiming one of two objects
    // must not take the other away from whoever published it.
    const claimed = new Map<string, Map<string, SemanticColumnView>>();
    for (const field of byModel.get(model.id) ?? []) {
      const key = semanticObjectKey(model.publishedSchema, field.object);
      let columns = claimed.get(key);
      if (columns === undefined) {
        columns = new Map();
        claimed.set(key, columns);
        index.set(key, columns);
      }
      const { object: _object, column, ...view } = field;
      const declared = metrics.get(`${field.modelId}:${field.fieldId}`);
      columns.set(column, {
        ...view,
        model: model.name,
        ...(declared?.kind === undefined ? {} : { metricKind: declared.kind }),
        ...(declared?.aggregation === undefined ? {} : { aggregation: declared.aggregation }),
      });
    }
  }
  return { objects: index, refusals };
};

/** What a relation's columns mean, where it is a published semantic object. */
export const semanticColumnsFor = (
  index: SemanticIndex,
  schema: string,
  table: string,
): SemanticColumns | undefined => index.objects.get(semanticObjectKey(schema, table));
