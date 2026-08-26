import type { ChartSpec, ChartType, Command, SessionCommand } from '@panorama/core';
import {
  isCustomChart,
  parseChartExtra,
  CHART_AGGREGATES,
  CHART_CURVES,
  CHART_LEGENDS,
  CHART_ORIENTATIONS,
  CHART_SCALES,
  CHART_SORTS,
  CHART_TYPES,
} from '@panorama/core';
import { COMMAND_FIELDS, COMMAND_INSTEAD, describeCommands } from './catalogue.js';
import type { ArgsSpec } from './schema.js';
import { AgentError, readArgs } from './schema.js';

/**
 * Which commands an agent may send, and what each one takes.
 *
 * The command union is how *every* persistent change is expressed already — a
 * drag, a keystroke, a replayed commit — so an agent that can send commands can
 * edit the document as completely as a person can, and the history it leaves is
 * indistinguishable from theirs. This table adds the one thing the type system
 * cannot: a check at the boundary, because an agent's message is JSON that has
 * been through a pipe and not a value the compiler ever saw.
 *
 * Three commands are deliberately not here. `CreateTableEntity`,
 * `SetTableColumns` and `SetTableSource` describe a table's *identity* — what it
 * reads and what shape that has — and none of it can be invented: the columns
 * come from a result set, the source needs a connection behind it, and an entity
 * assembled by hand would be a box with nothing to draw. The tools that do those
 * jobs properly are named in the refusal, which is more use than a valid-looking
 * command that leaves the application holding a table it cannot fill.
 */

const spec = (type: string): ArgsSpec => {
  const found = COMMAND_FIELDS[type];
  if (found !== undefined) return found;
  const instead = COMMAND_INSTEAD[type];
  if (instead !== undefined) {
    throw new AgentError(
      `${type} cannot be sent directly, because it describes what a table reads and that has to come from the database. Use ${instead}.`,
    );
  }
  throw new AgentError(`${type} is not a command. The commands are:\n${describeCommands()}`);
};

const enumOr = (values: readonly string[], value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AgentError(`spec.${field} must be one of ${values.join(', ')}`);
  }
  return value;
};

const numberOr = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentError(`spec.${field} must be a number`);
  }
  return value;
};

const boolOr = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new AgentError(`spec.${field} must be true or false`);
  return value;
};

/**
 * Checks a chart specification.
 *
 * Checked field by field rather than waved through as an object: a chart is the
 * one thing here an agent will write from scratch rather than read first, and a
 * misspelt `type` produces a picture of nothing with no explanation of why.
 *
 * A `custom` chart is checked differently, because it is a different kind of
 * thing: the option is the chart, so that is what has to be there and be JSON,
 * and the columns become optional — a written option may read the dataset beside
 * it or carry its own numbers.
 */
export const readChartSpec = (value: Readonly<Record<string, unknown>>): ChartSpec => {
  const type = enumOr(CHART_TYPES, value['type'], 'type');
  if (type === undefined)
    throw new AgentError(`spec.type must be one of ${CHART_TYPES.join(', ')}`);
  const written = isCustomChart(type as ChartType);
  const category = value['category'];
  if (typeof category !== 'string' || (category === '' && !written)) {
    throw new AgentError(
      written
        ? 'spec.category must be a string where it is given at all'
        : 'spec.category must name the column to group by',
    );
  }
  const values = value['values'];
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string')) {
    throw new AgentError('spec.values must be a list of column names to measure');
  }
  const aggregate = enumOr(CHART_AGGREGATES, value['aggregate'], 'aggregate');
  if (aggregate === undefined) {
    throw new AgentError(`spec.aggregate must be one of ${CHART_AGGREGATES.join(', ')}`);
  }
  const breakdown = value['breakdown'];
  if (breakdown !== undefined && breakdown !== null && typeof breakdown !== 'string') {
    throw new AgentError('spec.breakdown must name a second column to group by');
  }
  if (typeof breakdown === 'string' && breakdown !== '' && values.length > 1) {
    // Two measures broken down two ways is a cube, and a cube is not a picture.
    throw new AgentError(
      'A breakdown measures one column: spec.values must name one, or none with aggregate "count".',
    );
  }
  const optionals = {
    sort: enumOr(CHART_SORTS, value['sort'], 'sort'),
    orientation: enumOr(CHART_ORIENTATIONS, value['orientation'], 'orientation'),
    curve: enumOr(CHART_CURVES, value['curve'], 'curve'),
    scale: enumOr(CHART_SCALES, value['scale'], 'scale'),
    legend: enumOr(CHART_LEGENDS, value['legend'], 'legend'),
    rowLimit: numberOr(value['rowLimit'], 'rowLimit'),
    categoryLimit: numberOr(value['categoryLimit'], 'categoryLimit'),
    hole: numberOr(value['hole'], 'hole'),
    stacked: boolOr(value['stacked'], 'stacked'),
    showPoints: boolOr(value['showPoints'], 'showPoints'),
    showValues: boolOr(value['showValues'], 'showValues'),
    showGrid: boolOr(value['showGrid'], 'showGrid'),
  };
  const extra = value['extra'];
  if (extra !== undefined && extra !== null && typeof extra !== 'string') {
    throw new AgentError('spec.extra must be a string of ECharts options as JSON');
  }
  if (written) {
    // Refused here rather than drawn as nothing: for a custom chart this *is*
    // the chart, so an agent that sent broken JSON should be told which
    // character, now, instead of reading back a picture with no series in it.
    const parsed = parseChartExtra(typeof extra === 'string' ? extra : undefined);
    if (parsed.option === undefined) {
      throw new AgentError(
        parsed.error === undefined
          ? 'A custom chart needs spec.extra: the ECharts option, as a JSON string. It is the chart.'
          : `spec.extra is not JSON: ${parsed.error}`,
      );
    }
  }
  return {
    type,
    category,
    values: values as readonly string[],
    aggregate,
    ...(typeof breakdown === 'string' && breakdown !== '' ? { breakdown } : {}),
    ...Object.fromEntries(Object.entries(optionals).filter(([, entry]) => entry !== undefined)),
    ...(typeof extra === 'string' ? { extra } : {}),
  } as ChartSpec;
};

/**
 * Reads a document command, or refuses it in terms the sender can act on.
 *
 * The fields are checked; the *meaning* is not. Whether the entity exists, or
 * the column belongs to that table, is `applyCommand`'s answer to give — it is
 * the same answer a pointer gets, and duplicating it here would be a second
 * opinion that could disagree with the first.
 */
export const readCommand = (value: Readonly<Record<string, unknown>>): Command => {
  const type = value['type'];
  if (typeof type !== 'string') {
    throw new AgentError(`command.type must name a command:\n${describeCommands()}`);
  }
  const fields = { ...value };
  delete fields['type'];
  const checked = readArgs(spec(type), fields);
  // A position with no depth is on the ground, which is where a box goes unless
  // somebody has a view about what it should be under.
  const point = checked['position'] as Record<string, unknown> | undefined;
  const read =
    point === undefined || point['z'] !== undefined
      ? checked
      : { ...checked, position: { ...point, z: 0 } };
  if (type === 'SetChartSpec') {
    return {
      type: 'SetChartSpec',
      tableId: read['tableId'],
      spec: readChartSpec(read['spec'] as Readonly<Record<string, unknown>>),
    } as Command;
  }
  return { type, ...read } as unknown as Command;
};

const SESSION_FIELDS: Readonly<Record<string, ArgsSpec>> = {
  SetSelection: { ids: { kind: 'string-array', describe: 'Entities to select' } },
  SetHovered: {
    id: { kind: 'string', describe: 'Entity to activate, or omit for none', optional: true },
  },
  SetFocusedTable: {
    id: { kind: 'string', describe: 'Table to focus, or omit for none', optional: true },
  },
  SetSelectedColumns: {
    ids: { kind: 'string-array', describe: 'Column view ids to pick out' },
  },
  SetSelectedMarks: {
    targets: {
      kind: 'mark-array',
      describe:
        'Pieces of a chart to pick out, as {entityId, series, data}: which chart, which measure, which category. Send an empty list to let them all go.',
    },
  },
  EndDrag: {},
};

/**
 * What an omitted field means, where absent and nothing are different things.
 *
 * The convention everywhere else here is that an optional field left out stays
 * out — the difference between "leave the size alone" and "set it to none". A
 * session command is the one place that does not hold: `hovered` is *either* an
 * entity or `null`, never missing, and a command that left it missing would put
 * `undefined` into state that everything downstream compares against `null`.
 */
const NOTHING: Readonly<Record<string, Readonly<Record<string, null>>>> = {
  SetHovered: { id: null },
  SetFocusedTable: { id: null },
};

/**
 * Reads a session command.
 *
 * A smaller vocabulary than the session has, and on purpose: hover, presses and
 * pointer positions are what a pointer device says about itself frame by frame,
 * and an agent writing them would be describing a hand that is not there. What
 * is worth saying — what is selected, what has focus, which columns are picked
 * out — is here.
 */
export const readSessionCommand = (value: Readonly<Record<string, unknown>>): SessionCommand => {
  const type = value['type'];
  if (typeof type !== 'string') {
    throw new AgentError('command.type must name a session command');
  }
  const fields = { ...value };
  delete fields['type'];
  const found = SESSION_FIELDS[type];
  if (found === undefined) {
    throw new AgentError(
      `${type} is not a session command an agent may send. Those are: ${Object.keys(SESSION_FIELDS).join(', ')}.`,
    );
  }
  const read = readArgs(found, fields);
  return { type, ...NOTHING[type], ...read } as unknown as SessionCommand;
};
