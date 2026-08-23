import { describe, expect, it } from 'vitest';
import type { EntityId } from '@panorama/core';
import {
  bringToFront,
  emptyWorld,
  entitiesInOrder,
  getEntity,
  hasEntity,
  withEntity,
  withoutEntity,
} from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

describe('world state', () => {
  const ids = testIds();
  const a = makeTable(ids);
  const b = makeTable(ids);
  const c = makeTable(ids);
  const populated = withEntity(withEntity(withEntity(emptyWorld(), a), b), c);

  it('starts empty', () => {
    const world = emptyWorld();
    expect(world.entities.size).toBe(0);
    expect(world.order).toEqual([]);
    expect(getEntity(world, a.id)).toBeUndefined();
    expect(hasEntity(world, a.id)).toBe(false);
  });

  it('appends new entities to the stacking order', () => {
    expect(populated.order).toEqual([a.id, b.id, c.id]);
    expect(entitiesInOrder(populated)).toEqual([a, b, c]);
  });

  it('replaces existing entities in place', () => {
    const moved = { ...a, transform: { ...a.transform, x: 500 } };
    const next = withEntity(populated, moved);
    expect(next.order).toEqual([a.id, b.id, c.id]);
    expect(getEntity(next, a.id)?.transform.x).toBe(500);
    // The original world is untouched.
    expect(getEntity(populated, a.id)?.transform.x).toBe(0);
  });

  it('removes entities', () => {
    const next = withoutEntity(populated, b.id);
    expect(next.order).toEqual([a.id, c.id]);
    expect(hasEntity(next, b.id)).toBe(false);
  });

  it('returns the same world when removing an unknown entity', () => {
    expect(withoutEntity(populated, 'table:missing' as EntityId)).toBe(populated);
  });

  it('raises an entity to the front', () => {
    const next = bringToFront(populated, a.id);
    expect(next.order).toEqual([b.id, c.id, a.id]);
  });

  it('does nothing when raising the topmost or an unknown entity', () => {
    expect(bringToFront(populated, c.id)).toBe(populated);
    expect(bringToFront(populated, 'table:missing' as EntityId)).toBe(populated);
  });

  it('skips dangling ids when listing entities in order', () => {
    const dangling = {
      entities: populated.entities,
      order: [...populated.order, 'table:x' as EntityId],
      bindings: new Map(),
    };
    expect(entitiesInOrder(dangling)).toEqual([a, b, c]);
  });
});
