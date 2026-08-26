import type { Binding } from './bindings.js';
import type { ChartSpec } from './chart-spec.js';
import { describeChartSpec } from './chart-spec.js';
import type { TableColumnView, TableEntity, TableMode, TableSource } from './entities.js';
import type { Vec3 } from './geometry.js';
import type { BindingId, EntityId } from './ids.js';

/**
 * Semantic document commands.
 *
 * Every persistent change — whether it originates from a pointer drag, an
 * agent, or a replayed history commit — is expressed as one of these values.
 * They are plain JSON so they can cross a worker boundary, be logged, or be
 * produced by a future MCP adapter without change.
 */

export interface CreateTableEntityCommand {
  readonly type: 'CreateTableEntity';
  readonly entity: TableEntity;
}

/** Moves entities to an absolute world position. */
export interface MoveEntitiesCommand {
  readonly type: 'MoveEntities';
  readonly ids: readonly EntityId[];
  readonly position: Vec3;
}

/** Resizes an entity; `position` is supplied when dragging a top/left handle. */
export interface ResizeEntityCommand {
  readonly type: 'ResizeEntity';
  readonly id: EntityId;
  readonly width: number;
  readonly height: number;
  readonly position?: Vec3;
}

export interface ResizeColumnCommand {
  readonly type: 'ResizeColumn';
  readonly tableId: EntityId;
  readonly columnId: EntityId;
  readonly width: number;
}

/** Replaces the column order with a full permutation of the existing columns. */
export interface ReorderColumnsCommand {
  readonly type: 'ReorderColumns';
  readonly tableId: EntityId;
  readonly columnIds: readonly EntityId[];
}

export interface SetColumnVisibilityCommand {
  readonly type: 'SetColumnVisibility';
  readonly tableId: EntityId;
  readonly columnId: EntityId;
  readonly visible: boolean;
}

/**
 * Replaces the statement behind a query table.
 *
 * Only the *committed* SQL is a command. The text as it is being typed lives in
 * session state, so writing a query costs one entry in history rather than one
 * per keystroke — the same split that keeps a drag from flooding the DAG.
 */
export interface SetTableQueryCommand {
  readonly type: 'SetTableQuery';
  readonly tableId: EntityId;
  readonly sql: string;
}

/**
 * Replaces a table's columns wholesale.
 *
 * A query's shape is not known until it runs, and changes when the statement
 * does — so unlike a stored relation, a query table's columns are set after
 * creation rather than at it.
 */
export interface SetTableColumnsCommand {
  readonly type: 'SetTableColumns';
  readonly tableId: EntityId;
  readonly columns: readonly TableColumnView[];
}

/**
 * Replaces a chart's specification.
 *
 * One command for the whole specification rather than one per control, for the
 * same reason a query is one commit rather than one per keystroke: the thing the
 * user did was "set this chart up", and history should say that once.
 */
export interface SetChartSpecCommand {
  readonly type: 'SetChartSpec';
  readonly tableId: EntityId;
  readonly spec: ChartSpec;
}

/**
 * Replaces a table's source.
 *
 * Used once: to mark a freshly opened relation as showing the rows behind a
 * chart's selection. A source is document state, so changing it is a command like
 * any other rather than something quietly written over the entity.
 */
export interface SetTableSourceCommand {
  readonly type: 'SetTableSource';
  readonly tableId: EntityId;
  readonly source: TableSource;
}

/**
 * Renames a box.
 *
 * A query or a chart is titled by what it was made from — `SALES.ORDERS · SQL` —
 * which is right for the first one and useless for the seventh: a canvas of boxes
 * that all say the same thing is a canvas you have to read the statements to
 * navigate. So a box can be given a name of its own, and the asymmetry with
 * `SetBindingLabel` goes away — the box is the thing you look at.
 *
 * Not offered for a stored relation: it has a name, and the name is the
 * relation's rather than this box's to change.
 */
export interface SetTableLabelCommand {
  readonly type: 'SetTableLabel';
  readonly tableId: EntityId;
  readonly label: string;
}

/** Switches a configurable table between its editor and what it produced. */
export interface SetTableModeCommand {
  readonly type: 'SetTableMode';
  readonly tableId: EntityId;
  readonly mode: TableMode;
}

export interface RemoveEntitiesCommand {
  readonly type: 'RemoveEntities';
  readonly ids: readonly EntityId[];
}

/** Connects two entities so the relationship survives either of them moving. */
export interface CreateBindingCommand {
  readonly type: 'CreateBinding';
  readonly binding: Binding;
}

/**
 * Retitles a binding.
 *
 * A connector's label is the detail it reveals when asked, so it has to stay
 * true: a query box that has been re-run describes a different statement than
 * the one its line was created with.
 */
export interface SetBindingLabelCommand {
  readonly type: 'SetBindingLabel';
  readonly bindingId: BindingId;
  readonly label: string;
}

export interface RemoveBindingsCommand {
  readonly type: 'RemoveBindings';
  readonly ids: readonly BindingId[];
}

export type Command =
  | CreateTableEntityCommand
  | MoveEntitiesCommand
  | ResizeEntityCommand
  | ResizeColumnCommand
  | ReorderColumnsCommand
  | SetColumnVisibilityCommand
  | SetTableColumnsCommand
  | SetTableQueryCommand
  | SetChartSpecCommand
  | SetTableSourceCommand
  | SetTableLabelCommand
  | SetTableModeCommand
  | RemoveEntitiesCommand
  | CreateBindingCommand
  | SetBindingLabelCommand
  | RemoveBindingsCommand;

export type CommandType = Command['type'];

export type CommandErrorCode =
  | 'entity-not-found'
  | 'duplicate-entity'
  | 'wrong-entity-type'
  | 'column-not-found'
  | 'not-a-query'
  | 'not-a-chart'
  | 'binding-not-found'
  | 'duplicate-binding'
  | 'invalid-argument';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export const commandError = (code: CommandErrorCode, message: string): CommandError => ({
  code,
  message,
});

const sourceLabel = (source: TableSource): string =>
  source.kind === 'relation' ? `${source.schema}.${source.table}` : source.label;

/** Human-readable label used by history UIs and logs. */
export const describeCommand = (command: Command): string => {
  switch (command.type) {
    case 'CreateTableEntity':
      return `Create table ${sourceLabel(command.entity.source)}`;
    case 'MoveEntities':
      return `Move ${command.ids.length} entit${command.ids.length === 1 ? 'y' : 'ies'}`;
    case 'ResizeEntity':
      return `Resize entity to ${Math.round(command.width)}×${Math.round(command.height)}`;
    case 'ResizeColumn':
      return `Resize column to ${Math.round(command.width)}`;
    case 'ReorderColumns':
      return 'Reorder columns';
    case 'SetColumnVisibility':
      return command.visible ? 'Show column' : 'Hide column';
    case 'SetTableColumns':
      return `Set ${command.columns.length} column${command.columns.length === 1 ? '' : 's'}`;
    case 'SetTableQuery':
      return 'Edit query';
    case 'SetChartSpec':
      return `Set up chart (${describeChartSpec(command.spec)})`;
    case 'SetTableSource':
      return `Retarget table to ${sourceLabel(command.source)}`;
    case 'SetTableLabel':
      return `Rename to ${command.label}`;
    case 'SetTableMode':
      return command.mode === 'editing' ? 'Edit query' : 'Show result';
    case 'RemoveEntities':
      return `Remove ${command.ids.length} entit${command.ids.length === 1 ? 'y' : 'ies'}`;
    case 'CreateBinding':
      return command.binding.label === undefined
        ? 'Connect entities'
        : `Connect entities (${command.binding.label})`;
    case 'SetBindingLabel':
      return 'Retitle connection';
    case 'RemoveBindings':
      return `Disconnect ${command.ids.length} binding${command.ids.length === 1 ? '' : 's'}`;
  }
};
