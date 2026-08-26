import type { Binding, Commit, EntityId, TableEntity } from '@panorama/core';
import { bindingsOf, derivedFromOf, describeCommand, tableDisplayName } from '@panorama/core';
import type { AgentCell, AgentHost } from './host.js';
import { MAX_COLUMNS, MAX_ROWS } from './catalogue.js';
import { AgentError } from './schema.js';

/**
 * What the application looks like, written down.
 *
 * Projections rather than the state itself: the world holds `Map`s and the
 * history holds a world per commit, and neither survives `JSON.stringify` —
 * a map serialises as `{}`, so an agent handed the real thing would be told the
 * document is empty. So each of these says, in plain JSON, what its part of the
 * application is.
 *
 * They are also the reading of it, not a dump. A commit carries a whole world
 * snapshot; what an agent wants from the history is the shape of the graph and
 * what each step did, and it can ask for any commit's contents by moving there.
 */

export const entityOr = (host: AgentHost, id: string): TableEntity => {
  const entity = host.core.world.entities.get(id as EntityId);
  if (entity === undefined) {
    throw new AgentError(`There is no entity ${id}. Use "entities" to see what is open.`);
  }
  return entity;
};

const sourceOf = (entity: TableEntity): Record<string, unknown> => {
  const source = entity.source;
  switch (source.kind) {
    case 'relation':
      return {
        kind: 'relation',
        schema: source.schema,
        table: source.table,
        ...(source.selectionOf === undefined ? {} : { selectionOf: source.selectionOf }),
      };
    case 'query':
      return { kind: 'query', label: source.label, sql: source.sql };
    default:
      return { kind: 'chart', label: source.label, spec: source.spec };
  }
};

const bindingJson = (binding: Binding): Record<string, unknown> => ({
  id: binding.id,
  from: binding.fromId,
  to: binding.toId,
  directed: binding.directed,
  ...(binding.label === undefined ? {} : { label: binding.label }),
  ...(binding.meta === undefined ? {} : { meta: binding.meta }),
});

/** One table, at the depth a list wants: what it is and where. */
export const entityBrief = (host: AgentHost, entity: TableEntity): Record<string, unknown> => {
  const view = host.viewOf(entity.id);
  const derivedFrom = derivedFromOf(entity);
  return {
    // On the brief as well as in the detail, because a box that has just been
    // opened is about to have a statement written into it, and this is the one
    // thing that statement has to get right.
    ...(entity.source.kind === 'query' ? { readsFrom: host.readsFrom(entity.id) } : {}),
    id: entity.id,
    name: tableDisplayName(entity),
    source: sourceOf(entity),
    mode: entity.mode,
    at: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
    size: { width: entity.transform.width, height: entity.transform.height },
    columns: entity.columns.length,
    rows: view?.rowCount ?? null,
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
  };
};

/**
 * What the canvas made of a chart.
 *
 * The only feedback there is on a written option: a picture cannot be looked at
 * from here, but it can be asked how big it came out and whether any of its
 * labels ended up outside the box — which is the difference between iterating on
 * a layout and shipping the first guess. Absent until the canvas has drawn it,
 * because these are the real measurements and there are none before then.
 */
export const chartDrawn = (host: AgentHost, entity: TableEntity): Record<string, unknown> => {
  const drawn = host.chartGeometry(entity.id);
  if (drawn === null) {
    return { drawn: null, note: 'Not drawn yet — ask again once the canvas has laid it out.' };
  }
  const rounded = (value: number): number => Math.round(value);
  return {
    drawn: {
      box: { width: rounded(drawn.width), height: rounded(drawn.height) },
      polygons: drawn.polygons,
      labels: drawn.texts,
      ...(drawn.bounds === null
        ? {}
        : {
            covers: {
              x: rounded(drawn.bounds.x),
              y: rounded(drawn.bounds.y),
              width: rounded(drawn.bounds.width),
              height: rounded(drawn.bounds.height),
            },
          }),
      // Named, because "a label is clipped" is only actionable if you know which.
      ...(drawn.clipped.length === 0 ? {} : { clipped: drawn.clipped }),
    },
  };
};

/**
 * One table, described.
 *
 * Terse by default, and deliberately: an answer is read by something with a
 * finite amount of room to think in, and every token spent on a column's
 * identifier and pixel width is one not spent on the analysis. So what comes back
 * is what a next step needs — what it is, how many rows, what the columns are
 * called and what type they are — and the rest is there when it is asked for.
 *
 * The statement is said once. A draft that matches the committed statement is not
 * news, and the composed form of a long chain is the same base transformation
 * echoed back on every call; both are `verbose`, which is where somebody who
 * wants to see exactly what will be sent can find them.
 */
export const entityDetail = (
  host: AgentHost,
  entity: TableEntity,
  verbose = false,
): Record<string, unknown> => {
  const view = host.viewOf(entity.id);
  // A table of five thousand columns is a real thing, and a list of five
  // thousand names is not an answer. The count says what was left out.
  const listed = verbose ? entity.columns : entity.columns.slice(0, MAX_COLUMNS);
  const detail: Record<string, unknown> = {
    ...entityBrief(host, entity),
    // The count as well as the list, because the brief's count is the thing the
    // list replaced — and a capped list read as a whole table is a wrong answer.
    columnCount: entity.columns.length,
    columns: listed.map((column) =>
      verbose
        ? {
            id: column.id,
            name: column.sourceColumn.name,
            type: column.sourceColumn.type,
            width: column.width,
            visible: column.visible,
            ...(column.sourceColumn.foreignKey === undefined
              ? {}
              : { foreignKey: column.sourceColumn.foreignKey }),
          }
        : {
            name: column.sourceColumn.name,
            type: column.sourceColumn.type.name,
            ...(column.visible ? {} : { hidden: true }),
            ...(column.sourceColumn.foreignKey === undefined
              ? {}
              : { foreignKey: column.sourceColumn.foreignKey }),
          },
    ),
    ...(verbose
      ? {
          scroll: view === null ? null : { top: view.scrollTop, left: view.scrollLeft },
          bindings: bindingsOf(host.core.world, entity.id).map(bindingJson),
        }
      : {}),
  };
  if (entity.source.kind === 'query') {
    // What to put after FROM. Said outright because the alternative is working
    // it out from `derivedFrom`, and the answer to guess at — `derived_table` —
    // is the wrong one for a box that reads a relation with a name.
    detail['readsFrom'] = host.readsFrom(entity.id);
    // Only when it is not the statement already shown: an unrun edit is news,
    // and a copy of what is three lines above it is not.
    const draft = host.queryDraft(entity.id);
    if (draft !== entity.source.sql) detail['draft'] = draft;
    // What it would actually send: one step is what the user wrote, and the
    // chain of them is what the database sees — which on a long chain is the
    // same base transformation on every single answer.
    if (verbose) detail['composed'] = host.composedQuery(entity.id);
  }
  if (entity.source.kind === 'chart') {
    detail['chart'] = host.chartState(entity.id) ?? null;
    // What the canvas made of it, on a plain read as well as after setting it up:
    // the geometry settles a frame or two later, and asking again should not mean
    // drawing it again.
    Object.assign(detail, chartDrawn(host, entity));
    if (verbose) {
      detail['draft'] = host.chartDraft(entity.id);
      detail['chartColumns'] = host.chartColumns(entity.id);
    }
  }
  return detail;
};

/**
 * The commit graph.
 *
 * Every commit, with its parent and children, so an agent can see the branches
 * rather than a list — Panorama has no undo stack, and a history that reads as
 * one would be a lie about what undo does here. The path from the root to the
 * head is marked, because "where am I" is the first question about a graph.
 */
export const historyJson = (host: AgentHost): Record<string, unknown> => {
  const history = host.core.history;
  const onPath = new Set<string>();
  let walk: Commit | undefined = history.commits.get(history.head);
  while (walk !== undefined) {
    onPath.add(walk.id);
    walk = walk.parent === null ? undefined : history.commits.get(walk.parent);
  }
  const commits = [...history.commits.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((commit) => ({
      id: commit.id,
      parent: commit.parent,
      children: history.children.get(commit.id) ?? [],
      timestamp: commit.timestamp,
      did: commit.command === null ? 'The empty document' : describeCommand(commit.command),
      ...(commit.command === null ? {} : { command: commit.command }),
      head: commit.id === history.head,
      ancestorOfHead: onPath.has(commit.id) && commit.id !== history.head,
      entities: commit.world.entities.size,
    }));
  return {
    head: history.head,
    root: history.root,
    commits,
    /** A tip is a commit with no children: the end of a branch. */
    tips: commits.filter((commit) => commit.children.length === 0).map((commit) => commit.id),
    canUndo: host.core.canUndo,
    canRedo: host.core.canRedo,
  };
};

/** Session state: what is selected, hovered, dragged, pointed at. */
export const sessionJson = (host: AgentHost): Record<string, unknown> => {
  const session = host.core.session;
  return {
    selection: session.selection,
    focusedTable: session.focusedTable,
    hovered: session.hovered,
    selectedColumns: session.selectedColumns,
    hoveredMark: session.hoveredMark,
    selectedMarks: session.selectedMarks,
    hoveredAction: session.hoveredAction,
    pressedAction: session.pressedAction,
    expandedAction: session.expandedAction,
    hoveredBinding: session.hoveredBinding,
    pressedBinding: session.pressedBinding,
    drag: session.drag,
    pointer: session.pointer,
  };
};

/** The whole application at a glance: enough to know where to look next. */
export const overviewJson = (host: AgentHost): Record<string, unknown> => {
  const world = host.core.world;
  const tables = [...world.entities.values()];
  const reached = host.reachedDatabase();
  return {
    connected: host.connected(),
    /**
     * Which database is behind these tables, where there is one.
     *
     * First, because it is the first thing to establish: another way into a
     * database is usually faster than a canvas session, and this is what says
     * whether it is the same database.
     */
    ...(reached === null ? {} : { database: reached }),
    tables: tables.length,
    bindings: world.bindings.size,
    kinds: {
      relation: tables.filter((entity) => entity.source.kind === 'relation').length,
      query: tables.filter((entity) => entity.source.kind === 'query').length,
      chart: tables.filter((entity) => entity.source.kind === 'chart').length,
    },
    editing: {
      queries: host.editingQueryTables(),
      charts: host.editingCharts(),
    },
    history: {
      head: host.core.history.head,
      commits: host.core.history.commits.size,
      canUndo: host.core.canUndo,
      canRedo: host.core.canRedo,
    },
    selection: host.core.session.selection,
    exports: host.exportJobs(),
    metrics: host.metrics(),
  };
};

export interface RowsRequest {
  readonly tableId: EntityId;
  readonly from: number;
  readonly limit: number;
}

/**
 * Cells, as the table has them.
 *
 * Only what has been fetched: a table is a window onto a result set, and rows
 * outside the window are not "empty", they are *not here yet* — so a cell that
 * has not arrived is reported as absent rather than as null, which is a value a
 * database can also return.
 */
export const rowsJson = (host: AgentHost, request: RowsRequest): Record<string, unknown> => {
  const entity = entityOr(host, request.tableId);
  const view = host.viewOf(entity.id);
  const columns = entity.columns.filter((column) => column.visible);
  const limit = Math.min(Math.max(0, request.limit), MAX_ROWS);
  const rows: Record<string, unknown>[] = [];
  let waiting = 0;
  for (let offset = 0; offset < limit; offset += 1) {
    const row = request.from + offset;
    if (view?.rowCount !== null && view !== null && row >= view.rowCount) break;
    const cells: Record<string, AgentCell | undefined> = {};
    let arrived = false;
    for (const [index, column] of entity.columns.entries()) {
      if (!column.visible) continue;
      const value = host.cellAt(entity.id, row, index);
      if (value !== undefined) arrived = true;
      cells[column.sourceColumn.name] = value;
    }
    if (!arrived) {
      waiting += 1;
      continue;
    }
    rows.push({ row, ...cells });
  }
  return {
    table: tableDisplayName(entity),
    columns: columns.map((column) => column.sourceColumn.name),
    totalRows: view?.rowCount ?? null,
    from: request.from,
    rows,
    // Said plainly, because an agent that reads a short answer as "the table
    // ends here" would draw a conclusion about the data from the cache.
    ...(waiting === 0 ? {} : { notFetchedYet: waiting }),
  };
};
