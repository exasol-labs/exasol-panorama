import type { CommitId, EntityActionId, EntityId } from '@panorama/core';
import { DERIVED_TABLE, describeCommand } from '@panorama/core';
import { MAX_ROWS, toolNamed } from './catalogue.js';
import { readChartSpec, readCommand, readSessionCommand } from './commands.js';
import type { AgentHost } from './host.js';
import { AgentError, obj, optional, readArgs, str } from './schema.js';
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
    host.setChartDraft(tableId, readChartSpec(obj(args, 'spec')));
    host.showChart(tableId);
    return {
      ...entityDetail(host, entityOr(host, tableId), optional(args, 'verbose', false)),
      // What the canvas made of it, which is the only feedback there is on a
      // written option: a picture cannot be looked at from here.
      ...chartDrawn(host, entityOr(host, tableId)),
    };
  },
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
