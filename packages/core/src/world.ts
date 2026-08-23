import type { Entity } from './entities.js';
import type { EntityId } from './ids.js';

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
}

export const emptyWorld = (): WorldState => ({ entities: new Map(), order: [] });

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
    entities,
    order: existed ? world.order : [...world.order, entity.id],
  };
};

export const withoutEntity = (world: WorldState, id: EntityId): WorldState => {
  if (!world.entities.has(id)) return world;
  const entities = new Map(world.entities);
  entities.delete(id);
  return { entities, order: world.order.filter((entityId) => entityId !== id) };
};

/** Moves an entity to the top of the stacking order. */
export const bringToFront = (world: WorldState, id: EntityId): WorldState => {
  if (!world.entities.has(id)) return world;
  const last = world.order.at(-1);
  if (last === id) return world;
  return {
    entities: world.entities,
    order: [...world.order.filter((entityId) => entityId !== id), id],
  };
};
