import type { TableEntity } from './entities.js';
import type { Vec3 } from './geometry.js';
import type { EntityId } from './ids.js';

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

export interface RemoveEntitiesCommand {
  readonly type: 'RemoveEntities';
  readonly ids: readonly EntityId[];
}

export type Command =
  | CreateTableEntityCommand
  | MoveEntitiesCommand
  | ResizeEntityCommand
  | ResizeColumnCommand
  | ReorderColumnsCommand
  | SetColumnVisibilityCommand
  | RemoveEntitiesCommand;

export type CommandType = Command['type'];

export type CommandErrorCode =
  | 'entity-not-found'
  | 'duplicate-entity'
  | 'wrong-entity-type'
  | 'column-not-found'
  | 'invalid-argument';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export const commandError = (code: CommandErrorCode, message: string): CommandError => ({
  code,
  message,
});

/** Human-readable label used by history UIs and logs. */
export const describeCommand = (command: Command): string => {
  switch (command.type) {
    case 'CreateTableEntity':
      return `Create table ${command.entity.source.schema}.${command.entity.source.table}`;
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
    case 'RemoveEntities':
      return `Remove ${command.ids.length} entit${command.ids.length === 1 ? 'y' : 'ies'}`;
  }
};
