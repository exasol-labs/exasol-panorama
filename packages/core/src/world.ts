import type { Binding } from './bindings.js';
import type { Entity } from './entities.js';
import type { BindingId, EntityId } from './ids.js';

/**
 * The canonical document state.
 *
 * `WorldState` is immutable: every command produces a new value that shares
 * structure with the previous one, which is what makes storing a snapshot per
 * history commit affordable.
 */
export interface WorldState {
  readonly entities: ReadonlyMap<EntityId, Entity>;
  /** Stacking order, back to front. The last id is the topmost entity. */
  readonly order: readonly EntityId[];
  /** Relationships between entities; see `bindings.ts`. */
  readonly bindings: ReadonlyMap<BindingId, Binding>;
}

export const emptyWorld = (): WorldState => ({
  entities: new Map(),
  order: [],
  bindings: new Map(),
});

export const getEntity = (world: WorldState, id: EntityId): Entity | undefined =>
  world.entities.get(id);

export const hasEntity = (world: WorldState, id: EntityId): boolean => world.entities.has(id);

/** Entities in stacking order, back to front. */
export const entitiesInOrder = (world: WorldState): readonly Entity[] =>
  world.order.flatMap((id) => {
    const entity = world.entities.get(id);
    return entity === undefined ? [] : [entity];
  });

/** Inserts a new entity at the front, or replaces an existing one in place. */
export const withEntity = (world: WorldState, entity: Entity): WorldState => {
  const entities = new Map(world.entities);
  const existed = entities.has(entity.id);
  entities.set(entity.id, entity);
  return {
    ...world,
    entities,
    order: existed ? world.order : [...world.order, entity.id],
  };
};

/**
 * Removes an entity and every binding that referenced it. A binding to a
 * missing entity would be a dangling reference, so removal always cascades.
 */
export const withoutEntity = (world: WorldState, id: EntityId): WorldState => {
  if (!world.entities.has(id)) return world;
  const entities = new Map(world.entities);
  entities.delete(id);
  const bindings = new Map(world.bindings);
  for (const [bindingId, binding] of world.bindings) {
    if (binding.fromId === id || binding.toId === id) bindings.delete(bindingId);
  }
  return {
    entities,
    order: world.order.filter((entityId) => entityId !== id),
    bindings,
  };
};

export const getBinding = (world: WorldState, id: BindingId): Binding | undefined =>
  world.bindings.get(id);

export const withBinding = (world: WorldState, binding: Binding): WorldState => {
  const bindings = new Map(world.bindings);
  bindings.set(binding.id, binding);
  return { ...world, bindings };
};

export const withoutBinding = (world: WorldState, id: BindingId): WorldState => {
  if (!world.bindings.has(id)) return world;
  const bindings = new Map(world.bindings);
  bindings.delete(id);
  return { ...world, bindings };
};

/** Moves an entity to the top of the stacking order. */
export const bringToFront = (world: WorldState, id: EntityId): WorldState => {
  if (!world.entities.has(id)) return world;
  const last = world.order.at(-1);
  if (last === id) return world;
  return {
    ...world,
    order: [...world.order.filter((entityId) => entityId !== id), id],
  };
};
