import type {
  ChartDatasetResolution,
  ChartDrawList,
  ChartResolution,
  ChartSeriesResolution,
} from '@panorama/chart';

/**
 * What an option turned out to read.
 *
 * Read from the option rather than from the library's internals, and for a
 * reason: this is the one piece of chart feedback whose job is to be true when
 * the picture is wrong. Asking ECharts what it resolved would report what it
 * managed to do with what it was given; reading the option reports what it was
 * asked to do, so a channel naming a column that does not exist shows up as the
 * mismatch it is instead of as a series that quietly drew nothing.
 *
 * Everything here is ECharts' vocabulary — `dataset`, `datasetId`, `encode`,
 * `dimensions` — and none of it leaves this package: what comes out is
 * Panorama's own `ChartResolution`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A single component or a list of them, as ECharts allows either. */
const asList = (value: unknown): readonly unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/**
 * The dimension names of one data set.
 *
 * Either declared outright — which is how Panorama offers its own data sets, so
 * that an `encode` can be checked against them — or taken from a header row,
 * which is the shape most hand-written examples use.
 */
const dimensionsOf = (dataset: Record<string, unknown>): readonly string[] => {
  const declared = dataset['dimensions'];
  if (Array.isArray(declared)) {
    return declared.map((entry) =>
      typeof entry === 'string' ? entry : isRecord(entry) ? String(entry['name'] ?? '') : '',
    );
  }
  const source = dataset['source'];
  if (!Array.isArray(source)) return [];
  const header = source[0];
  // A header row is a row of strings. A row of numbers is data, and a data set
  // whose first row is data has no names for anything.
  if (!Array.isArray(header) || !header.every((cell) => typeof cell === 'string')) return [];
  return header as readonly string[];
};

const rowsOf = (dataset: Record<string, unknown>, named: boolean): number => {
  const source = dataset['source'];
  if (!Array.isArray(source)) return 0;
  // The header is not a row, and it is only a header when the names came from it.
  return named && Array.isArray(dataset['dimensions'])
    ? source.length
    : Math.max(0, source.length - 1);
};

interface ResolvedDataset extends ChartDatasetResolution {
  readonly index: number;
}

const readDatasets = (option: Record<string, unknown>): readonly ResolvedDataset[] =>
  asList(option['dataset'])
    .filter(isRecord)
    .map((dataset, index) => {
      const dimensions = dimensionsOf(dataset);
      const id = dataset['id'];
      return {
        index,
        ...(typeof id === 'string' ? { name: id } : {}),
        dimensions,
        rows: rowsOf(dataset, dimensions.length > 0),
      };
    });

/** The data set a series reads: by name, by index, or the first one there is. */
const datasetFor = (
  series: Record<string, unknown>,
  datasets: readonly ResolvedDataset[],
): ResolvedDataset | undefined => {
  const id = series['datasetId'];
  if (typeof id === 'string') return datasets.find((dataset) => dataset.name === id);
  const index = series['datasetIndex'];
  if (typeof index === 'number') return datasets[index];
  // A series with its own `data` is reading that, not a data set — and saying it
  // read the first one would be inventing a link the option never made.
  return series['data'] === undefined ? datasets[0] : undefined;
};

/** One channel's dimension, however the option spelled it. */
const channelDimension = (value: unknown, dimensions: readonly string[]): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return dimensions[value] ?? `dimension ${value}`;
  // A channel may take several dimensions — `tooltip: ['a', 'b']` — and each is
  // checked, so the report names them together.
  if (Array.isArray(value)) {
    const parts = value.map((entry) => channelDimension(entry, dimensions)).filter(Boolean);
    return parts.length === 0 ? undefined : parts.join(', ');
  }
  return undefined;
};

/** Marks drawn per series index, counted from the geometry that was produced. */
const markCounts = (drawList: ChartDrawList): ReadonlyMap<number, number> => {
  const seen = new Map<number, Set<number>>();
  const note = (series: number, data: number): void => {
    const marks = seen.get(series) ?? new Set<number>();
    marks.add(data);
    seen.set(series, marks);
  };
  for (const polygon of drawList.polygons) {
    if (polygon.mark !== undefined) note(polygon.mark.series, polygon.mark.data);
  }
  for (const run of drawList.texts) {
    if (run.mark !== undefined) note(run.mark.series, run.mark.data);
  }
  // Distinct marks, not pieces of geometry: a bar is a dozen triangles and a
  // count of triangles is not a fact about the data.
  return new Map([...seen].map(([series, marks]) => [series, marks.size]));
};

/**
 * Where a `{"$param": "name"}` survived into the option.
 *
 * Which means no data set answered to that name: the marker is left in place
 * rather than replaced by a nought, so it is here to be found and reported by the
 * name the author used.
 */
const unresolvedParams = (value: unknown, path: string): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => unresolvedParams(entry, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const asked = record['$param'];
  if (typeof asked === 'string' && Object.keys(record).length === 1) {
    return [
      `${path} asks for the number from data set "${asked}", which there is no such data set for`,
    ];
  }
  return Object.entries(record).flatMap(([key, entry]) =>
    unresolvedParams(entry, path === '' ? key : `${path}.${key}`),
  );
};

/**
 * The data set each series reads, by series index.
 *
 * Taken from the option because that is where the link is made, and used twice:
 * once to say what a series resolved to, and once to stamp every mark with the
 * data set and row it came from as the geometry is read out.
 */
export const seriesDatasets = (option: unknown): readonly (string | undefined)[] => {
  if (!isRecord(option)) return [];
  const datasets = readDatasets(option);
  return asList(option['series'])
    .filter(isRecord)
    .map((series) => datasetFor(series, datasets)?.name);
};

export const resolveOption = (option: unknown, drawList: ChartDrawList): ChartResolution => {
  // Whether any of what was drawn can be pointed at. Read from the geometry
  // rather than from the option, because it is a fact about what the library
  // attached and not about what was asked for.
  const pickable =
    drawList.polygons.some((polygon) => polygon.mark !== undefined) ||
    drawList.texts.some((run) => run.mark !== undefined);
  if (!isRecord(option)) return { datasets: [], series: [], unresolved: [], pickable };
  const datasets = readDatasets(option);
  const marks = markCounts(drawList);
  const unresolved: string[] = [...unresolvedParams(option, '')];
  const series = asList(option['series'])
    .filter(isRecord)
    .map((entry, index): ChartSeriesResolution => {
      const dataset = datasetFor(entry, datasets);
      const encoded: Record<string, string> = {};
      const encode = entry['encode'];
      if (isRecord(encode)) {
        for (const [channel, value] of Object.entries(encode)) {
          const dimension = channelDimension(value, dataset?.dimensions ?? []);
          if (dimension === undefined) continue;
          encoded[channel] = dimension;
          // The failure that looks like success: a channel naming a column the
          // data set has not got draws a series with nothing in it.
          if (dataset === undefined) {
            unresolved.push(
              `series[${index}].encode.${channel} names ${dimension}, but the series reads no data set`,
            );
          } else if (
            dataset.dimensions.length > 0 &&
            !dimension.split(', ').every((name) => dataset.dimensions.includes(name))
          ) {
            unresolved.push(
              `series[${index}].encode.${channel} names ${dimension}, which ${
                dataset.name === undefined ? 'the data set' : `data set "${dataset.name}"`
              } has not got — it has ${dataset.dimensions.join(', ')}`,
            );
          }
        }
      }
      const type = entry['type'];
      return {
        index,
        type: typeof type === 'string' ? type : 'unknown',
        ...(dataset?.name === undefined ? {} : { dataset: dataset.name }),
        ...(Object.keys(encoded).length === 0 ? {} : { encode: encoded }),
        marks: marks.get(index) ?? 0,
      };
    });
  return {
    datasets: datasets.map(({ index: _index, ...rest }) => rest),
    series,
    unresolved,
    pickable,
  };
};
