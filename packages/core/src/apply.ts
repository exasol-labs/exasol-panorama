import { dataSourcesOf, filterSourcesOf } from './bindings.js';
import { PRIMARY_FRAME } from './chart-spec.js';
import type { Command, CommandError } from './commands.js';
import { commandError } from './commands.js';
import type { WorldConstraints } from './constraints.js';
import { DEFAULT_CONSTRAINTS } from './constraints.js';
import type { Entity, QuerySource, TableColumnView, TableEntity } from './entities.js';
import { isChartTable, isConfigurableTable, isQueryTable, isTableEntity } from './entities.js';
import { clamp } from './geometry.js';
import { derivedTreeOf, isPlaceholderName } from './query-chain.js';
import type { EntityId } from './ids.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import type { WorldState } from './world.js';
import { bringToFront, withBinding, withEntity, withoutBinding, withoutEntity } from './world.js';

const isFinitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * A query table, specifically. Editing the SQL of a stored relation is not a
 * partial success to be ignored — it is a mistake, so it is an error.
 */
const requireQueryTable = (
  world: WorldState,
  id: EntityId,
): Result<TableEntity & { readonly source: QuerySource }, CommandError> => {
  const found = requireTable(world, id);
  if (!found.ok) return found;
  if (!isQueryTable(found.value)) {
    return err(commandError('not-a-query', `Table ${id} is not backed by a query`));
  }
  return ok(found.value);
};

const requireTable = (world: WorldState, id: EntityId): Result<TableEntity, CommandError> => {
  const entity = world.entities.get(id);
  if (entity === undefined) {
    return err(commandError('entity-not-found', `No entity with id ${id}`));
  }
  if (entity.type !== 'table') {
    return err(commandError('wrong-entity-type', `Entity ${id} is not a table`));
  }
  return ok(entity);
};

const clampColumnWidth = (width: number, constraints: WorldConstraints): number =>
  clamp(width, constraints.minColumnWidth, constraints.maxColumnWidth);

const validateNewTable = (entity: TableEntity, world: WorldState): CommandError | null => {
  if (world.entities.has(entity.id)) {
    return commandError('duplicate-entity', `Entity ${entity.id} already exists`);
  }
  const { transform, view } = entity;
  if (
    !Number.isFinite(transform.x) ||
    !Number.isFinite(transform.y) ||
    !Number.isFinite(transform.z)
  ) {
    return commandError('invalid-argument', 'Table position must be finite');
  }
  if (!isFinitePositive(transform.width) || !isFinitePositive(transform.height)) {
    return commandError('invalid-argument', 'Table size must be finite and positive');
  }
  if (!isFinitePositive(view.rowHeight) || !isFinitePositive(view.headerHeight)) {
    return commandError('invalid-argument', 'Row and header heights must be finite and positive');
  }
  if (!Number.isFinite(view.horizontalOffset) || view.horizontalOffset < 0) {
    return commandError('invalid-argument', 'Horizontal offset must be a non-negative number');
  }
  const seen = new Set<EntityId>();
  for (const column of entity.columns) {
    if (seen.has(column.id)) {
      return commandError('invalid-argument', `Duplicate column id ${column.id}`);
    }
    seen.add(column.id);
    if (!isFinitePositive(column.width)) {
      return commandError('invalid-argument', `Column ${column.id} has a non-positive width`);
    }
  }
  return null;
};

const normaliseTable = (entity: TableEntity, constraints: WorldConstraints): TableEntity => ({
  ...entity,
  transform: {
    ...entity.transform,
    width: clamp(entity.transform.width, constraints.minTableWidth, constraints.maxTableWidth),
    height: clamp(entity.transform.height, constraints.minTableHeight, constraints.maxTableHeight),
  },
  columns: entity.columns.map((column) => ({
    ...column,
    width: clampColumnWidth(column.width, constraints),
  })),
});

const mapColumns = (
  entity: TableEntity,
  update: (column: TableColumnView) => TableColumnView,
): TableEntity => ({ ...entity, columns: entity.columns.map(update) });

/**
 * Applies a command to the world, returning either the next world state or a
 * machine-readable error. Never mutates its input and never throws for
 * expected failures.
 */
export const applyCommand = (
  world: WorldState,
  command: Command,
  constraints: WorldConstraints = DEFAULT_CONSTRAINTS,
): Result<WorldState, CommandError> => {
  switch (command.type) {
    case 'CreateTableEntity': {
      const invalid = validateNewTable(command.entity, world);
      if (invalid !== null) return err(invalid);
      return ok(withEntity(world, normaliseTable(command.entity, constraints)));
    }

    case 'MoveEntities': {
      if (command.ids.length === 0) {
        return err(commandError('invalid-argument', 'MoveEntities requires at least one id'));
      }
      const { x, y, z } = command.position;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return err(commandError('invalid-argument', 'Target position must be finite'));
      }
      let next = world;
      for (const id of command.ids) {
        const entity = next.entities.get(id);
        if (entity === undefined) {
          return err(commandError('entity-not-found', `No entity with id ${id}`));
        }
        const moved: Entity = { ...entity, transform: { ...entity.transform, x, y, z } };
        // Moving an entity raises it: direct manipulation implies focus, and the
        // stacking order is part of the document so undo restores it too.
        next = bringToFront(withEntity(next, moved), id);
      }
      return ok(next);
    }

    case 'ResizeEntity': {
      const found = requireTable(world, command.id);
      if (!found.ok) return found;
      if (!isFinitePositive(command.width) || !isFinitePositive(command.height)) {
        return err(commandError('invalid-argument', 'Size must be finite and positive'));
      }
      const position = command.position ?? found.value.transform;
      if (
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(position.z)
      ) {
        return err(commandError('invalid-argument', 'Target position must be finite'));
      }
      const resized: TableEntity = {
        ...found.value,
        transform: {
          x: position.x,
          y: position.y,
          z: position.z,
          width: clamp(command.width, constraints.minTableWidth, constraints.maxTableWidth),
          height: clamp(command.height, constraints.minTableHeight, constraints.maxTableHeight),
        },
      };
      return ok(withEntity(world, resized));
    }

    case 'ResizeColumn': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      if (!isFinitePositive(command.width)) {
        return err(commandError('invalid-argument', 'Column width must be finite and positive'));
      }
      const table = found.value;
      if (!table.columns.some((column) => column.id === command.columnId)) {
        return err(
          commandError('column-not-found', `Table ${table.id} has no column ${command.columnId}`),
        );
      }
      const width = clampColumnWidth(command.width, constraints);
      return ok(
        withEntity(
          world,
          mapColumns(table, (column) =>
            column.id === command.columnId ? { ...column, width } : column,
          ),
        ),
      );
    }

    case 'ReorderColumns': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      const table = found.value;
      const byId = new Map(table.columns.map((column) => [column.id, column]));
      if (command.columnIds.length !== table.columns.length) {
        return err(
          commandError('invalid-argument', 'ReorderColumns requires a full column permutation'),
        );
      }
      const reordered: TableColumnView[] = [];
      const seen = new Set<EntityId>();
      for (const id of command.columnIds) {
        const column = byId.get(id);
        if (column === undefined) {
          return err(commandError('column-not-found', `Table ${table.id} has no column ${id}`));
        }
        if (seen.has(id)) {
          return err(commandError('invalid-argument', `Duplicate column id ${id}`));
        }
        seen.add(id);
        reordered.push(column);
      }
      return ok(withEntity(world, { ...table, columns: reordered }));
    }

    case 'SetColumnVisibility': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      const table = found.value;
      if (!table.columns.some((column) => column.id === command.columnId)) {
        return err(
          commandError('column-not-found', `Table ${table.id} has no column ${command.columnId}`),
        );
      }
      return ok(
        withEntity(
          world,
          mapColumns(table, (column) =>
            column.id === command.columnId ? { ...column, visible: command.visible } : column,
          ),
        ),
      );
    }

    case 'SetTableColumns': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      const seen = new Set<EntityId>();
      for (const column of command.columns) {
        if (seen.has(column.id)) {
          return err(commandError('invalid-argument', `Duplicate column id ${column.id}`));
        }
        seen.add(column.id);
      }
      return ok(withEntity(world, { ...found.value, columns: [...command.columns] }));
    }

    case 'SetTableQuery': {
      const found = requireQueryTable(world, command.tableId);
      if (!found.ok) return found;
      if (command.sql.trim() === '') {
        return err(commandError('invalid-argument', 'A query table needs a statement'));
      }
      const table = found.value;
      return ok(withEntity(world, { ...table, source: { ...table.source, sql: command.sql } }));
    }

    case 'SetChartSpec': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      const table = found.value;
      if (!isChartTable(table)) {
        return err(commandError('not-a-chart', `Table ${command.tableId} is not a chart`));
      }
      return ok(withEntity(world, { ...table, source: { ...table.source, spec: command.spec } }));
    }

    case 'SetTableSource': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      return ok(withEntity(world, { ...found.value, source: command.source }));
    }

    case 'SetTableMode': {
      const found = requireTable(world, command.tableId);
      if (!found.ok) return found;
      const table = found.value;
      // A statement to write or a chart to set up: either way there is something
      // to switch between. A stored relation has nothing to configure.
      if (!isConfigurableTable(table)) {
        return err(
          commandError('not-a-query', `Table ${command.tableId} has nothing to configure`),
        );
      }
      return ok(withEntity(world, { ...table, mode: command.mode }));
    }

    case 'RemoveEntities': {
      if (command.ids.length === 0) {
        return err(commandError('invalid-argument', 'RemoveEntities requires at least one id'));
      }
      let next = world;
      for (const id of command.ids) {
        if (!next.entities.has(id)) {
          return err(commandError('entity-not-found', `No entity with id ${id}`));
        }
        // Removal cascades to bindings; a binding to a missing entity would be
        // a dangling reference.
        next = withoutEntity(next, id);
      }
      return ok(next);
    }

    case 'CreateBinding': {
      const { binding } = command;
      if (world.bindings.has(binding.id)) {
        return err(commandError('duplicate-binding', `Binding ${binding.id} already exists`));
      }
      if (binding.fromId === binding.toId) {
        return err(commandError('invalid-argument', 'A binding needs two different entities'));
      }
      for (const id of [binding.fromId, binding.toId]) {
        if (!world.entities.has(id)) {
          return err(commandError('entity-not-found', `No entity with id ${id}`));
        }
      }
      // A data binding says more than "there is a line here": it supplies one of
      // a chart's named data sets, and the name is the label. So the things that
      // make that meaningful are checked here rather than discovered as a data
      // set that reads nothing.
      if (binding.kind === 'data') {
        const target = world.entities.get(binding.toId);
        if (target === undefined || !isTableEntity(target) || !isChartTable(target)) {
          return err(
            commandError(
              'wrong-entity-type',
              `A data binding feeds a chart; ${binding.toId} is not one`,
            ),
          );
        }
        const name = binding.label ?? '';
        if (name.trim() === '') {
          return err(
            commandError('invalid-argument', 'A data binding is named by its label: the data set'),
          );
        }
        if (name === PRIMARY_FRAME) {
          return err(
            commandError(
              'invalid-argument',
              `"${PRIMARY_FRAME}" is the chart's own reduction; a data set needs another name`,
            ),
          );
        }
        const taken = dataSourcesOf(world, binding.toId).get(name);
        if (taken !== undefined) {
          return err(
            commandError(
              'invalid-argument',
              `${binding.toId} already reads a data set called "${name}"`,
            ),
          );
        }
      }
      // A filter binding says what *scopes* what: the box it comes from decides a
      // predicate, and the box it points at writes that name in its statement. The
      // things that make that meaningful are checked here rather than discovered
      // as a statement the database refuses.
      if (binding.kind === 'filter') {
        const source = world.entities.get(binding.fromId);
        if (source === undefined || !isTableEntity(source) || !isChartTable(source)) {
          return err(
            commandError(
              'wrong-entity-type',
              `A filter comes from what is picked out in a chart; ${binding.fromId} is not one`,
            ),
          );
        }
        const target = world.entities.get(binding.toId);
        if (target === undefined || !isTableEntity(target) || !isQueryTable(target)) {
          return err(
            commandError(
              'wrong-entity-type',
              `A filter fills in a {{name}} in a statement; ${binding.toId} has none to fill`,
            ),
          );
        }
        const name = binding.label ?? '';
        if (!isPlaceholderName(name)) {
          return err(
            commandError(
              'invalid-argument',
              'A filter is named by its label, which is the {{name}} it fills in: a letter or an underscore, then letters, digits or underscores',
            ),
          );
        }
        if (filterSourcesOf(world, binding.toId).has(name)) {
          return err(
            commandError(
              'invalid-argument',
              `${binding.toId} already has a filter called "${name}"`,
            ),
          );
        }
        // The one loop worth refusing: a chart built on the box it scopes would
        // re-scope itself every time it re-read its own rows, and what settled
        // would depend on which frame won.
        if (derivedTreeOf(world, binding.toId).some((entity) => entity.id === binding.fromId)) {
          return err(
            commandError(
              'invalid-argument',
              `${binding.fromId} is built on ${binding.toId}, so it cannot also decide what ${binding.toId} reads`,
            ),
          );
        }
      }
      for (const anchor of [binding.from, binding.to]) {
        if (anchor.mode !== 'fixed') continue;
        if (
          !Number.isFinite(anchor.x) ||
          !Number.isFinite(anchor.y) ||
          anchor.x < 0 ||
          anchor.x > 1 ||
          anchor.y < 0 ||
          anchor.y > 1
        ) {
          return err(
            commandError('invalid-argument', 'A fixed anchor must be normalised within 0..1'),
          );
        }
      }
      return ok(withBinding(world, binding));
    }

    case 'SetTableLabel': {
      const entity = world.entities.get(command.tableId);
      if (entity === undefined || !isTableEntity(entity)) {
        return err(commandError('entity-not-found', `No table with id ${command.tableId}`));
      }
      if (entity.source.kind === 'relation') {
        return err(
          commandError(
            'wrong-entity-type',
            `${command.tableId} shows a stored relation, whose name is the relation's`,
          ),
        );
      }
      if (command.label.trim() === '') {
        return err(commandError('invalid-argument', 'A label cannot be blank'));
      }
      return ok(
        withEntity(world, {
          ...entity,
          source: { ...entity.source, label: command.label },
        }),
      );
    }

    case 'SetBindingLabel': {
      const binding = world.bindings.get(command.bindingId);
      if (binding === undefined) {
        return err(commandError('binding-not-found', `No binding with id ${command.bindingId}`));
      }
      return ok(withBinding(world, { ...binding, label: command.label }));
    }

    case 'RemoveBindings': {
      if (command.ids.length === 0) {
        return err(commandError('invalid-argument', 'RemoveBindings requires at least one id'));
      }
      let next = world;
      for (const id of command.ids) {
        if (!next.bindings.has(id)) {
          return err(commandError('binding-not-found', `No binding with id ${id}`));
        }
        next = withoutBinding(next, id);
      }
      return ok(next);
    }
  }
};
