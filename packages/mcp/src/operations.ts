import type { CommitId, EntityActionId, EntityId } from '@panorama/core';
import type { ChartSpec, TableEntity } from '@panorama/core';
import {
  AUTO_ANCHOR,
  DERIVED_TABLE,
  chartFramesOf,
  describeCommand,
  shiftedWindow,
} from '@panorama/core';
import { MAX_ROWS, toolNamed } from './catalogue.js';
import { readChartSources, readChartSpec, readCommand, readSessionCommand } from './commands.js';
import type { AgentHost } from './host.js';
import { AgentError, isRecord, obj, optional, readArgs, str } from './schema.js';
import {
  chartDrawn,
  entityBrief,
  entityDetail,
  entityOr,
  historyJson,
  overviewJson,
  rowsJson,
  sessionJson,
} from './snapshot.js';

/**
 * What each tool does.
 *
 * A handler per name in the catalogue, run in the page against the live
 * application — which is why this half is separate: everything here reaches for
 * the document, and the half that offers the tools to the agent runs in a
 * process that has no document to reach for.
 */

/** Rows returned with a result unless asked otherwise: enough to see it worked. */
const DEFAULT_PREVIEW = 5;

export type AgentHandler = (
  host: AgentHost,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown> | unknown;

export const AGENT_HANDLERS: Readonly<Record<string, AgentHandler>> = {
  overview: (host) => overviewJson(host),
  entities: (host) =>
    host.core.world.order.flatMap((id) => {
      const entity = host.core.world.entities.get(id);
      return entity === undefined ? [] : [entityBrief(host, entity)];
    }),
  entity: (host, args) =>
    entityDetail(host, entityOr(host, str(args, 'tableId')), optional(args, 'verbose', false)),
  rows: async (host, args) => {
    const tableId = str(args, 'tableId') as EntityId;
    const from = optional(args, 'from', 0);
    const limit = optional(args, 'limit', 20);
    // Asked for and waited for, rather than read out of whatever the frame loop
    // happened to have fetched.
    await host.ensureRows(tableId, from, Math.min(limit, MAX_ROWS));
    return rowsJson(host, { tableId, from, limit });
  },
  history: (host) => historyJson(host),
  session: (host) => sessionJson(host),
  catalogue: async (host, args) => {
    if (!host.connected()) {
      throw new AgentError('There is no database connected. Connect one in the app first.');
    }
    const schema = optional<string | undefined>(args, 'schema', undefined);
    return schema === undefined
      ? { schemas: await host.listSchemas() }
      : { schema, relations: await host.listTables(schema) };
  },
  dispatch: (host, args) => {
    const one = args['command'];
    const many = args['commands'];
    if (one === undefined && many === undefined) {
      throw new AgentError('Send either command or commands.');
    }
    const sent = (
      many === undefined
        ? [obj(args, 'command')]
        : (many as readonly Readonly<Record<string, unknown>>[])
    ).map(readCommand);
    // Applied in order, and stopped at the first refusal: half of a tidy-up is
    // easier to reason about than an unknown fraction of it.
    const applied: { commit: string; did: string }[] = [];
    for (const command of sent) {
      const result = host.core.dispatch(command);
      if (!result.ok) {
        throw new AgentError(
          applied.length === 0
            ? `${result.error.code}: ${result.error.message}`
            : `${result.error.code}: ${result.error.message} (after ${applied.length} of ${sent.length})`,
        );
      }
      applied.push({ commit: result.value.id, did: describeCommand(command) });
    }
    return applied.length === 1
      ? { ...applied[0], head: host.core.history.head }
      : {
          applied: applied.length,
          did: applied.map((entry) => entry.did),
          head: host.core.history.head,
        };
  },
  session_dispatch: (host, args) => {
    host.core.dispatchSession(readSessionCommand(obj(args, 'command')));
    return sessionJson(host);
  },
  checkout: (host, args) => {
    const to = str(args, 'to');
    if (to === 'undo' || to === 'redo') {
      const moved = to === 'undo' ? host.core.undo() : host.core.redo();
      if (!moved) {
        throw new AgentError(
          to === 'undo'
            ? 'Already at the root commit; there is nothing to undo.'
            : 'Nothing to redo: the head has no children.',
        );
      }
    } else {
      const result = host.core.setHead(to as CommitId);
      if (!result.ok) throw new AgentError(`${result.error.code}: ${result.error.message}`);
    }
    // Where it landed, said as what that commit did: a commit id alone tells
    // an agent it moved but not where to.
    const landed = host.core.history.commits.get(host.core.history.head)?.command ?? null;
    return {
      head: host.core.history.head,
      did: landed === null ? 'The empty document' : describeCommand(landed),
      tables: host.core.world.entities.size,
    };
  },
  label: (host, args) => {
    const tableId = str(args, 'tableId') as EntityId;
    entityOr(host, tableId);
    host.setTableLabel(tableId, str(args, 'label'));
    return entityBrief(host, entityOr(host, tableId));
  },
  open_table: async (host, args) => {
    const id = await host.openTable({ schema: str(args, 'schema'), table: str(args, 'table') });
    return entityBrief(host, entityOr(host, id));
  },
  action: async (host, args) => {
    const tableId = str(args, 'tableId') as EntityId;
    entityOr(host, tableId);
    const before = new Set(host.core.world.entities.keys());
    await host.performAction(tableId, str(args, 'action') as EntityActionId);
    const opened = [...host.core.world.entities.keys()].filter((id) => !before.has(id));
    return {
      did: str(args, 'action'),
      // What it left behind: an action that opens a box is only useful if the
      // caller is told which box.
      opened: opened.map((id) => entityBrief(host, entityOr(host, id))),
      tables: host.core.world.entities.size,
    };
  },
  query: async (host, args) => {
    const asked = str(args, 'tableId') as EntityId;
    const entity = entityOr(host, asked);
    if (entity.source.kind !== 'query') {
      throw new AgentError(
        `${asked} is a ${entity.source.kind} box, not a query. Use action(tableId, "sql") to derive a query box from it.`,
      );
    }
    /**
     * A sibling, when the box being asked is worth keeping.
     *
     * Derived from the same parent rather than from this box, so it reads what
     * this one reads and is a *variant* of it — running one statement should not
     * cost the last one, and a box holds one statement at a time.
     */
    let tableId = asked;
    if (optional(args, 'newBox', false)) {
      const parent = entity.source.derivedFrom;
      if (parent === undefined) {
        throw new AgentError(
          `${asked} has nothing behind it, so there is no parent to open a sibling from.`,
        );
      }
      const before = new Set(host.core.world.entities.keys());
      await host.performAction(parent, 'sql');
      const opened = [...host.core.world.entities.keys()].find((id) => !before.has(id));
      if (opened === undefined) throw new AgentError('The new box was not opened.');
      tableId = opened;
    }
    const label = optional<string | undefined>(args, 'label', undefined);
    if (label !== undefined) host.setTableLabel(tableId, label);
    const sql = str(args, 'sql');
    const reads = host.readsFrom(tableId);
    // The arrows before the statement runs: a `{{name}}` with nothing to fill it
    // in is a statement the database refuses, and drawing the arrow afterwards
    // would mean refusing it once on purpose.
    const scoped = wireFilters(host, tableId, args);
    host.setQueryDraft(tableId, sql);
    await host.runQuery(tableId, sql);
    const verbose = optional(args, 'verbose', false);
    const preview = Math.min(optional(args, 'preview', DEFAULT_PREVIEW), MAX_ROWS);
    // The rows with the shape, because "run it then read it" was two calls for
    // every analytical step, and the first thing anybody does with a result is
    // look at it.
    if (preview > 0) await host.ensureRows(tableId, 0, preview);
    const detail = {
      ...entityDetail(host, entityOr(host, tableId), verbose),
      ...(scoped.length === 0 ? {} : { scopedBy: scoped }),
      ...(preview > 0
        ? {
            preview: (rowsJson(host, { tableId, from: 0, limit: preview }) as { rows: unknown })
              .rows,
          }
        : {}),
    };
    // It ran; the note says why it could have been written more plainly. This
    // box reads a relation with a name, and calling it `derived_table` is a step
    // of indirection that hides which table is being read.
    return reads === DERIVED_TABLE || !/\bderived_table\b/iu.test(sql)
      ? detail
      : {
          ...detail,
          note: `This box reads ${reads}; naming it is clearer than "derived_table".`,
        };
  },
  chart: (host, args) => {
    const tableId = str(args, 'tableId') as EntityId;
    const entity = entityOr(host, tableId);
    if (entity.source.kind !== 'chart') {
      throw new AgentError(
        `${tableId} is a ${entity.source.kind} box, not a chart. Use action(tableId, "chart") to open a chart of it.`,
      );
    }
    const label = optional<string | undefined>(args, 'label', undefined);
    if (label !== undefined) host.setTableLabel(tableId, label);
    const panned = optional<Readonly<Record<string, unknown>> | undefined>(args, 'pan', undefined);
    const asked = optional<Readonly<Record<string, unknown>> | undefined>(args, 'spec', undefined);
    if (asked === undefined && panned === undefined) {
      throw new AgentError('Send a spec, or a pan to move a window of the one it has.');
    }
    /**
     * A move along a series, or a new question about it.
     *
     * A pan changes one window of the specification the box already has, and
     * nothing else about it: not the arrows, which are the same boxes; not the
     * mode, which is already showing; not the line's label, which says what the
     * chart is and not where it is looking. So it is one commit rather than the
     * handful that setting a chart up costs, and undoing it is one step back
     * along the series.
     */
    let bound: readonly { name: string; from: string; did: string }[] = [];
    if (panned !== undefined) {
      const wanted = panChart(entity, panned);
      host.setChartDraft(tableId, wanted);
      const applied = host.core.dispatch({ type: 'SetChartSpec', tableId, spec: wanted });
      if (!applied.ok) throw new AgentError(applied.error.message);
    } else {
      const spec = asked as Readonly<Record<string, unknown>>;
      host.setChartDraft(tableId, readChartSpec(spec));
      // The arrows a data set asked for, drawn before the picture is shown: a
      // data set with no arrow reads the chart's own box, so drawing them second
      // would mean a first frame made of the wrong rows.
      bound = wireDataSources(host, tableId, readChartSources(spec));
      host.showChart(tableId);
    }
    return {
      ...entityDetail(host, entityOr(host, tableId), optional(args, 'verbose', false)),
      ...(bound.length === 0 ? {} : { reading: bound }),
      // What the canvas made of it, which is the only feedback there is on a
      // written option: a picture cannot be looked at from here.
      ...chartDrawn(host, entityOr(host, tableId)),
    };
  },
};

/**
 * The same chart, looking at the next part of a series.
 *
 * Where a picture is looking is part of what the picture *is*, so this produces a
 * specification to commit rather than a piece of session state — it undoes, it
 * branches, and a gesture doing the same thing would leave the same history.
 */
const panChart = (entity: TableEntity, pan: Readonly<Record<string, unknown>>): ChartSpec => {
  const name = pan['frame'];
  const pages = pan['pages'];
  if (typeof name !== 'string' || typeof pages !== 'number' || !Number.isFinite(pages)) {
    throw new AgentError('pan is {frame, pages}: which data set, and how many windows to move it');
  }
  const spec = entity.source.kind === 'chart' ? entity.source.spec : undefined;
  if (spec === undefined) throw new AgentError('Only a chart has a window to move.');
  const frames = chartFramesOf(spec);
  const found = frames.find((frame) => frame.name === name);
  if (found === undefined) {
    throw new AgentError(
      `This chart has no data set called "${name}". It has: ${frames.map((frame) => frame.name).join(', ') || 'none'}.`,
    );
  }
  if (found.kind !== 'rows' && found.kind !== 'resample') {
    throw new AgentError(`The data set "${name}" is a ${found.kind}, which reads no window.`);
  }
  if (found.window === undefined) {
    throw new AgentError(
      `The data set "${name}" has no window to move. Give it one — {by: "position", from, count} — and it can be moved along.`,
    );
  }
  const moved = shiftedWindow(found.window, pages);
  if (moved === null) {
    throw new AgentError(
      `The data set "${name}" is windowed by value, and what comes after a range is a question about the data: send the next range instead.`,
    );
  }
  return {
    ...spec,
    frames: frames.map((frame) => (frame.name === name ? { ...frame, window: moved } : frame)),
  };
};

/**
 * Draws the arrows a statement's `{{name}}`s asked for.
 *
 * One binding per name, labelled with it, from the chart that decides it — the
 * same mechanism as a data set's arrow and for the same reasons: the canvas shows
 * what scopes what, cutting the line stops it, and it is in the history.
 */
const wireFilters = (
  host: AgentHost,
  tableId: EntityId,
  args: Readonly<Record<string, unknown>>,
): readonly { readonly name: string; readonly from: string; readonly did: string }[] => {
  const asked = optional<readonly unknown[]>(args, 'filters', []);
  const done: { name: string; from: string; did: string }[] = [];
  for (const entry of asked) {
    if (!isRecord(entry)) throw new AgentError('each filter is {name, from}');
    const name = entry['name'];
    const from = entry['from'];
    if (typeof name !== 'string' || name === '' || typeof from !== 'string' || from === '') {
      throw new AgentError('each filter needs a name and the chart it comes from: {name, from}');
    }
    const existing = [...host.core.world.bindings.values()].find(
      (binding) => binding.kind === 'filter' && binding.toId === tableId && binding.label === name,
    );
    if (existing !== undefined && existing.fromId === (from as EntityId)) {
      done.push({ name, from, did: 'was already scoping it' });
      continue;
    }
    if (!host.core.world.entities.has(from as EntityId)) {
      throw new AgentError(
        `{{${name}}} cannot be decided by ${from}: there is no such box. Use "entities" to see what is open.`,
      );
    }
    // Cut without checking: the id came from the world a line ago, and removing a
    // binding that is there is the one command that cannot be refused.
    if (existing !== undefined) {
      host.core.dispatch({ type: 'RemoveBindings', ids: [existing.id] });
    }
    const made = host.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: host.core.ids.binding(),
        kind: 'filter',
        fromId: from as EntityId,
        toId: tableId,
        from: AUTO_ANCHOR,
        to: AUTO_ANCHOR,
        directed: true,
        label: name,
        meta: { kind: 'filter' },
      },
    });
    if (!made.ok) {
      throw new AgentError(`{{${name}}} cannot be decided by ${from}: ${made.error.message}`);
    }
    done.push({
      name,
      from,
      did: existing === undefined ? 'now scopes it' : 'now scopes it instead',
    });
  }
  return done;
};

/**
 * Draws the arrows a chart's data sets asked for.
 *
 * One binding per named data set, labelled with the name — which is the whole
 * mechanism: the chart's specification says what shape each data set has, and the
 * arrow says which box it reads. Done through commands like everything else, so
 * the arrows are in the history and undo with the chart.
 *
 * A name already reading the box asked for is left alone; one reading a different
 * box is cut and redrawn, because a data set answers to one box at a time.
 */
const wireDataSources = (
  host: AgentHost,
  chartId: EntityId,
  sources: ReadonlyMap<string, string>,
): readonly { readonly name: string; readonly from: string; readonly did: string }[] => {
  const done: { name: string; from: string; did: string }[] = [];
  for (const [name, from] of sources) {
    const existing = [...host.core.world.bindings.values()].find(
      (binding) => binding.kind === 'data' && binding.toId === chartId && binding.label === name,
    );
    if (existing !== undefined && existing.fromId === (from as EntityId)) {
      done.push({ name, from, did: 'was already reading it' });
      continue;
    }
    // Checked before anything is cut: a name that ends up reading nothing because
    // its new box does not exist is worse than one still reading its old box.
    if (!host.core.world.entities.has(from as EntityId)) {
      throw new AgentError(
        `The data set "${name}" cannot read ${from}: there is no such box. Use "entities" to see what is open. Everything else was set up.`,
      );
    }
    // Cut without checking: the id came from the world a line ago, and removing a
    // binding that is there is the one command that cannot be refused.
    if (existing !== undefined) {
      host.core.dispatch({ type: 'RemoveBindings', ids: [existing.id] });
    }
    const made = host.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: host.core.ids.binding(),
        kind: 'data',
        fromId: from as EntityId,
        toId: chartId,
        from: AUTO_ANCHOR,
        to: AUTO_ANCHOR,
        directed: true,
        label: name,
        meta: { kind: 'data-set' },
      },
    });
    if (!made.ok) {
      throw new AgentError(
        `The data set "${name}" cannot read ${from}: ${made.error.message}. Everything else was set up.`,
      );
    }
    done.push({
      name,
      from,
      did: existing === undefined ? 'now reads it' : 'now reads it instead',
    });
  }
  return done;
};

/** Runs a tool against the live application. */
export const runOperation = async (
  host: AgentHost,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const tool = toolNamed(name);
  // Present by construction: the two lists are checked against each other.
  const handler = AGENT_HANDLERS[tool.name] as AgentHandler;
  return handler(host, readArgs(tool.args, args));
};
