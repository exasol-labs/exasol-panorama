import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChartAggregate,
  ChartCurve,
  ChartLegend,
  ChartOrientation,
  ChartScale,
  ChartSort,
  ChartSpec,
  ChartType,
  EntityId,
} from '@panorama/core';
import {
  CHART_AGGREGATES,
  CHART_CURVES,
  CHART_LEGENDS,
  CHART_ORIENTATIONS,
  CHART_SCALES,
  CHART_SORTS,
  CHART_TYPES,
  chartSupports,
  isBrokenDown,
  isCustomChart,
  isTableEntity,
  parseChartExtra,
} from '@panorama/core';
import { DEFAULT_TABLE_THEME, chartBoxLayout } from '@panorama/renderer';
import type { PanoramaRenderer } from '@panorama/renderer';
import type { ChartColumnChoice, Workspace } from './workspace.js';

/**
 * The controls of a chart box.
 *
 * The second DOM overlay, and for the same reason as the first: a form is
 * selection, focus order, keyboard traversal and a screen reader's idea of a
 * label, and a GPU-drawn form would reimplement all of that worse.
 *
 * Three things make a large set of options bearable. It takes a column down the
 * left and leaves the chart visible beside it, so every control is a change you
 * *watch* rather than a guess followed by a reveal. It is grouped by what someone
 * is thinking about — what to draw, how it looks, what is written on it — with
 * everything past the first group folded away until wanted. And a control appears
 * only where it does something: there is no stacking on a pie and no hole in a
 * bar chart, so neither is offered.
 *
 * Under all of that is one raw field. Every chart library has hundreds of
 * settings and a form with hundreds of controls is not a form, so the controls
 * cover what people reach for and the field covers the rest.
 */

export interface ChartEditorsProps {
  readonly workspace: Workspace;
  readonly rendererRef: { current: PanoramaRenderer | null };
  readonly onError: (message: string | null) => void;
}

/** Below this zoom the controls are too small to use, so they step aside. */
const MIN_LEGIBLE_SCALE = 0.4;

const sameIds = (left: readonly EntityId[], right: readonly EntityId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const ChartEditors = ({
  workspace,
  rendererRef,
  onError,
}: ChartEditorsProps): React.JSX.Element => {
  const [ids, setIds] = useState<readonly EntityId[]>([]);
  const elements = useRef(new Map<EntityId, HTMLDivElement>());

  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const editing = workspace.editingCharts();
      setIds((current) => (sameIds(current, editing) ? current : editing));

      const renderer = rendererRef.current;
      if (renderer === null) return;
      const { camera } = renderer;
      const scale = camera.scale;
      for (const [id, element] of elements.current) {
        const entity = workspace.core.world.entities.get(id);
        if (entity === undefined || !isTableEntity(entity)) continue;
        // The drawn transform, so the panel keeps up with a drag rather than
        // snapping into place when it commits.
        const { x, y, width, height } = renderer.drawnEntity(entity).transform;
        // The same split the canvas draws, so the controls sit exactly beside the
        // preview rather than over it.
        const box = chartBoxLayout(width, height, DEFAULT_TABLE_THEME, true);
        const origin = camera.worldToScreen(x + box.form.x, y + box.form.y);
        element.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
        element.style.width = `${box.form.width * scale}px`;
        element.style.height = `${box.form.height * scale}px`;
        element.style.fontSize = `${DEFAULT_TABLE_THEME.editorFontSize * scale}px`;
        element.style.visibility = scale < MIN_LEGIBLE_SCALE ? 'hidden' : 'visible';
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [workspace, rendererRef]);

  const show = useCallback(
    (tableId: EntityId) => {
      onError(null);
      try {
        workspace.showChart(tableId);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [workspace, onError],
  );

  return (
    <>
      {ids.map((id) => {
        // Resolved here, so the editor itself never has to consider not having a
        // specification: every id came from the list of charts being set up.
        const spec = workspace.chartDraft(id);
        return spec === null ? null : (
          <ChartEditor
            key={id}
            tableId={id}
            initialSpec={spec}
            workspace={workspace}
            elements={elements}
            onShow={show}
          />
        );
      })}
    </>
  );
};

interface ChartEditorProps {
  readonly tableId: EntityId;
  readonly initialSpec: ChartSpec;
  readonly workspace: Workspace;
  readonly elements: { current: Map<EntityId, HTMLDivElement> };
  readonly onShow: (tableId: EntityId) => void;
}

const TYPE_LABELS: Readonly<Record<ChartType, string>> = {
  bar: 'Bars',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  custom: 'Custom',
};

const AGGREGATE_LABELS: Readonly<Record<ChartAggregate, string>> = {
  sum: 'Sum',
  average: 'Average',
  count: 'Row count',
  min: 'Minimum',
  max: 'Maximum',
};

const SORT_LABELS: Readonly<Record<ChartSort, string>> = {
  size: 'Largest first',
  name: 'By name',
  natural: 'As they come',
};

const CURVE_LABELS: Readonly<Record<ChartCurve, string>> = {
  straight: 'Straight',
  smooth: 'Smooth',
  stepped: 'Stepped',
};

const ORIENTATION_LABELS: Readonly<Record<ChartOrientation, string>> = {
  vertical: 'Upright',
  horizontal: 'On its side',
};

const SCALE_LABELS: Readonly<Record<ChartScale, string>> = {
  linear: 'Even steps',
  log: 'Multiples',
};

const LEGEND_LABELS: Readonly<Record<ChartLegend, string>> = {
  auto: 'When useful',
  always: 'Always',
  never: 'Never',
};

/** A labelled dropdown. The workhorse: nearly every setting is a short list. */
interface ChoiceProps<TValue extends string> {
  readonly label: string;
  readonly value: TValue;
  readonly options: readonly TValue[];
  readonly labels: Readonly<Record<TValue, string>>;
  /**
   * Options the model refuses, against the reason it gave.
   *
   * Shown and disabled rather than left out. A dimension that vanishes from the
   * list looks like a dimension that does not exist; one that is there, greyed,
   * and says why is the model explaining itself — which is the whole reason to
   * read a semantic layer rather than guess from column types.
   */
  readonly refused?: Readonly<Record<string, string>>;
  readonly onChange: (value: TValue) => void;
}

const Choice = <TValue extends string>({
  label,
  value,
  options,
  labels,
  refused,
  onChange,
}: ChoiceProps<TValue>): React.JSX.Element => (
  <label className="pn-chart-field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value as TValue)}>
      {options.map((option) => {
        const reason = refused?.[option];
        return (
          <option
            key={option}
            value={option}
            disabled={reason !== undefined}
            title={reason ?? undefined}
          >
            {reason === undefined ? labels[option] : `${labels[option]} — ${reason}`}
          </option>
        );
      })}
    </select>
  </label>
);

interface SwitchProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

const Switch = ({ label, checked, onChange }: SwitchProps): React.JSX.Element => (
  <label className="pn-chart-check">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span>{label}</span>
  </label>
);

interface CountProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}

const Count = ({ label, value, min, max, onChange }: CountProps): React.JSX.Element => (
  <label className="pn-chart-field">
    <span>{label}</span>
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value);
        // A field mid-edit is briefly empty or nonsense; leave the chart alone
        // until it says something that can be drawn.
        if (Number.isFinite(next) && next >= min) onChange(Math.min(max, Math.round(next)));
      }}
    />
  </label>
);

/** One folded group. Native disclosure: keyboard, screen readers, no state. */
interface GroupProps {
  readonly title: string;
  readonly open?: boolean;
  readonly children: React.ReactNode;
}

const Group = ({ title, open, children }: GroupProps): React.JSX.Element => (
  <details className="pn-chart-group" {...(open === true ? { open: true } : {})}>
    <summary>{title}</summary>
    <div className="pn-chart-group-body">{children}</div>
  </details>
);

const ChartEditor = ({
  tableId,
  initialSpec,
  workspace,
  elements,
  onShow,
}: ChartEditorProps): React.JSX.Element => {
  const [spec, setSpec] = useState<ChartSpec>(initialSpec);
  /**
   * Recomputed as the category changes, because a refusal is about a *pair*: a
   * metric is a perfectly good measure until somebody asks for it by a dimension
   * the model cannot attribute it to.
   */
  const columns = useMemo(
    () => workspace.chartColumns(tableId, spec.category),
    [workspace, tableId, spec.category],
  );
  const refusedCategories = useMemo(
    () => workspace.chartCategoryRefusals(tableId, spec.values),
    [workspace, tableId, spec.values],
  );
  const extraError = useMemo(() => parseChartExtra(spec.extra).error, [spec]);

  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) elements.current.delete(tableId);
      else elements.current.set(tableId, element);
    },
    [elements, tableId],
  );

  /** Every change goes the same way: update the draft, and the picture follows. */
  const change = useCallback(
    (patch: Partial<ChartSpec>) => {
      setSpec((current) => {
        const next = { ...current, ...patch };
        workspace.setChartDraft(tableId, next);
        return next;
      });
    },
    [workspace, tableId],
  );

  /**
   * Puts a setting back to not being set at all.
   *
   * Which is not the same as setting it to nothing: a specification without a
   * breakdown reduces one way and one with an empty one would have to be
   * special-cased everywhere it is read.
   */
  const unset = useCallback(
    (key: 'breakdown') => {
      setSpec((current) => {
        const next = { ...current };
        delete next[key];
        workspace.setChartDraft(tableId, next);
        return next;
      });
    },
    [workspace, tableId],
  );

  /**
   * Why a measure cannot be chosen, where it cannot.
   *
   * Two different refusals, and both are the model's rather than Panorama's. A
   * pairing it will not attribute, and a metric that must not be aggregated at
   * all — a margin percentage has to be recomputed per group, and a chart groups
   * more coarsely than the rows it is drawn from, so summing or averaging one is
   * the arithmetic the layer exists to prevent.
   */
  const refusalFor = useCallback(
    (column: ChartColumnChoice): string | undefined =>
      column.refusedBy ??
      (column.aggregate === 'none'
        ? `${column.label} is computed by the model per group; it cannot be summed or averaged`
        : undefined),
    [],
  );

  /**
   * Choosing a measure takes the model's own aggregation with it.
   *
   * The metric already says how it combines, so opening on `sum` and leaving a
   * reader to notice would be offering a decision that has already been made.
   */
  const chooseValues = useCallback(
    (names: readonly string[]) => {
      const declared = names
        .map((name) => columns.find((column) => column.name === name)?.aggregate)
        .find((aggregate) => aggregate !== undefined && aggregate !== 'none');
      change({ values: [...names], ...(declared === undefined ? {} : { aggregate: declared }) });
    },
    [change, columns],
  );

  const counting = spec.aggregate === 'count';
  // A pie shows one measure, and so does a cross-tabulation: two measures split
  // two ways is a cube.
  const singleValue = spec.type === 'pie' || isBrokenDown(spec);
  const measurable = columns.filter((column) =>
    // Where a model has spoken, the measures are its metrics — not every column
    // that happens to hold a number.
    columns.some((entry) => entry.role !== undefined) ? column.role === 'metric' : column.numeric,
  );
  /**
   * A written option needs no controls for how it looks: it says so itself.
   *
   * What is left of the form for it is what shapes the *data* — the column to
   * group by, the measures, the order and the limits — because those decide what
   * arrives in the dataset the option can read. The groups about appearance are
   * not shown rather than shown with every control inside them inert.
   */
  const written = isCustomChart(spec.type);
  /** The dataset's header row, spelled out, so it can be read off the form. */
  const datasetHeader = `[${[spec.category === '' ? 'category' : spec.category, ...(counting ? ['rows'] : spec.values)].join(', ')}]`;

  return (
    <div className="pn-chart-editor" ref={register}>
      <div className="pn-chart-controls">
        <Group title="What to draw" open>
          <Choice
            label="Chart"
            value={spec.type}
            options={CHART_TYPES}
            labels={TYPE_LABELS}
            onChange={(type) => change({ type })}
          />
          <Choice
            label="By"
            value={spec.category}
            options={columns.map((column) => column.name)}
            labels={Object.fromEntries(columns.map((column) => [column.name, column.label]))}
            refused={refusedCategories}
            onChange={(category) => change({ category })}
          />
          <Choice
            label="Measure"
            value={spec.aggregate}
            options={CHART_AGGREGATES}
            labels={AGGREGATE_LABELS}
            onChange={(aggregate) => change({ aggregate })}
          />
          {/*
            A second grouping column, which makes the series its values rather
            than the measured columns: the one way to draw a cross-tabulation.
            "None" is the ordinary case and comes first.
          */}
          <Choice
            label="Split by"
            value={spec.breakdown ?? ''}
            options={[
              '',
              ...columns.map((column) => column.name).filter((name) => name !== spec.category),
            ]}
            labels={{
              '': 'Nothing',
              ...Object.fromEntries(columns.map((column) => [column.name, column.label])),
            }}
            refused={refusedCategories}
            onChange={(breakdown) => {
              if (breakdown === '') unset('breakdown');
              else change({ breakdown, values: spec.values.slice(0, 1) });
            }}
          />
          {/*
            Counting rows needs no column to count, so the list of them is not
            shown rather than shown and ignored.
          */}
          {counting ? null : (
            <fieldset className="pn-chart-values">
              <legend>Of</legend>
              <div className="pn-chart-value-list" role="group" aria-label="Measured columns">
                {measurable.map((column) => {
                  const refusal = refusalFor(column);
                  return (
                    <label
                      key={column.name}
                      className={
                        refusal === undefined ? 'pn-chart-value' : 'pn-chart-value pn-chart-refused'
                      }
                      title={refusal}
                    >
                      <input
                        type={singleValue ? 'radio' : 'checkbox'}
                        name={singleValue ? `chart-value-${tableId}` : undefined}
                        checked={spec.values.includes(column.name)}
                        disabled={refusal !== undefined}
                        onChange={() =>
                          singleValue
                            ? chooseValues([column.name])
                            : chooseValues(
                                spec.values.includes(column.name)
                                  ? spec.values.filter((value) => value !== column.name)
                                  : [...spec.values, column.name],
                              )
                        }
                      />
                      <span>{column.label}</span>
                      {refusal === undefined ? null : (
                        <small className="pn-chart-refusal">{refusal}</small>
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </Group>

        <Group title="Categories">
          <Choice
            label="Order"
            value={spec.sort ?? 'size'}
            options={CHART_SORTS}
            labels={SORT_LABELS}
            onChange={(sort) => change({ sort })}
          />
          <Count
            label="Show"
            value={spec.categoryLimit ?? 24}
            min={1}
            max={200}
            onChange={(categoryLimit) => change({ categoryLimit })}
          />
          <Count
            label="Read rows"
            value={spec.rowLimit ?? 20_000}
            min={100}
            max={1_000_000}
            onChange={(rowLimit) => change({ rowLimit })}
          />
        </Group>

        {written ? null : (
          <>
            <Group title="How it looks">
              {chartSupports(spec.type, 'orientation') ? (
                <Choice
                  label="Direction"
                  value={spec.orientation ?? 'vertical'}
                  options={CHART_ORIENTATIONS}
                  labels={ORIENTATION_LABELS}
                  onChange={(orientation) => change({ orientation })}
                />
              ) : null}
              {chartSupports(spec.type, 'curve') ? (
                <Choice
                  label="Curve"
                  value={spec.curve ?? 'straight'}
                  options={CHART_CURVES}
                  labels={CURVE_LABELS}
                  onChange={(curve) => change({ curve })}
                />
              ) : null}
              {chartSupports(spec.type, 'scale') ? (
                <Choice
                  label="Scale"
                  value={spec.scale ?? 'linear'}
                  options={CHART_SCALES}
                  labels={SCALE_LABELS}
                  onChange={(scale) => change({ scale })}
                />
              ) : null}
              {chartSupports(spec.type, 'stack') ? (
                <Switch
                  label="Stack the series"
                  checked={spec.stacked === true}
                  onChange={(stacked) => change({ stacked })}
                />
              ) : null}
              {chartSupports(spec.type, 'points') ? (
                <Switch
                  label="Mark each point"
                  checked={spec.showPoints !== false}
                  onChange={(showPoints) => change({ showPoints })}
                />
              ) : null}
              {chartSupports(spec.type, 'hole') ? (
                <Switch
                  label="Hole in the middle"
                  checked={spec.hole !== false}
                  onChange={(hole) => change({ hole })}
                />
              ) : null}
            </Group>

            <Group title="What is written on it">
              <Choice
                label="Legend"
                value={spec.legend ?? 'auto'}
                options={CHART_LEGENDS}
                labels={LEGEND_LABELS}
                onChange={(legend) => change({ legend })}
              />
              <Switch
                label="Write the values on"
                checked={spec.showValues === true}
                onChange={(showValues) => change({ showValues })}
              />
              {chartSupports(spec.type, 'grid') ? (
                <Switch
                  label="Grid lines"
                  checked={spec.showGrid !== false}
                  onChange={(showGrid) => change({ showGrid })}
                />
              ) : null}
            </Group>
          </>
        )}

        <Group title={written ? 'The chart' : 'Anything else'} open={written}>
          <p className="pn-chart-hint">
            {written ? (
              <>
                An ECharts option, and the whole of the chart: any series type the library draws,
                configured however it likes. The rows above arrive as <code>dataset.source</code>,
                header row first — {datasetHeader} — so a series can read them through{' '}
                <code>encode</code>, or ignore them and carry its own data.
              </>
            ) : (
              'An ECharts option, merged over the settings above. For whatever the controls do not cover.'
            )}
          </p>
          <textarea
            className="pn-chart-extra"
            aria-label={written ? 'The chart option' : 'Extra chart settings'}
            spellCheck={false}
            rows={written ? 12 : 4}
            value={spec.extra ?? ''}
            onChange={(event) => change({ extra: event.target.value })}
          />
          {extraError === undefined ? null : (
            <p className="pn-chart-error" role="alert">
              {extraError}
            </p>
          )}
        </Group>
      </div>

      <div className="pn-chart-actions">
        <button type="button" className="pn-button" onClick={() => onShow(tableId)}>
          Show chart
        </button>
      </div>
    </div>
  );
};
