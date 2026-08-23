import { describe, expect, it } from 'vitest';
import type { Binding, BindingId, TableEntity, WorldState } from '@panorama/core';
import {
  AUTO_ANCHOR,
  resolveAnchor,
  applyCommand,
  bindingsFrom,
  bindingsOf,
  borderPointToward,
  emptyWorld,
  entityRect,
  getBinding,
  resolveBinding,
  unwrap,
  withEntity,
} from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

const ids = testIds();

const place = (table: TableEntity, x: number, y: number): TableEntity => ({
  ...table,
  transform: { ...table.transform, x, y, width: 200, height: 100 },
});

const left = place(makeTable(ids), 0, 0);
const right = place(makeTable(ids), 500, 0);
const below = place(makeTable(ids), 0, 400);

const worldWith = (...entities: readonly TableEntity[]): WorldState =>
  entities.reduce<WorldState>((world, entity) => withEntity(world, entity), emptyWorld());

const connector = (
  from: TableEntity,
  to: TableEntity,
  overrides: Partial<Binding> = {},
): Binding => ({
  id: ids.binding(),
  kind: 'connector',
  fromId: from.id,
  toId: to.id,
  from: AUTO_ANCHOR,
  to: AUTO_ANCHOR,
  directed: true,
  ...overrides,
});

describe('borderPointToward', () => {
  const rect = { x: 0, y: 0, width: 200, height: 100 };

  it('finds the border point along the ray from the centre, and its normal', () => {
    expect(borderPointToward(rect, { x: 1_000, y: 50 })).toEqual({
      point: { x: 200, y: 50 },
      normal: { x: 1, y: 0 },
    });
    expect(borderPointToward(rect, { x: -1_000, y: 50 })).toEqual({
      point: { x: 0, y: 50 },
      normal: { x: -1, y: 0 },
    });
    expect(borderPointToward(rect, { x: 100, y: -1_000 })).toEqual({
      point: { x: 100, y: 0 },
      normal: { x: 0, y: -1 },
    });
    expect(borderPointToward(rect, { x: 100, y: 1_000 })).toEqual({
      point: { x: 100, y: 100 },
      normal: { x: 0, y: 1 },
    });
  });

  it('leaves through the nearer edge on a diagonal', () => {
    // A wide rectangle aimed at 45° exits through the top, not the side.
    expect(borderPointToward(rect, { x: 200, y: -50 })).toEqual({
      point: { x: 150, y: 0 },
      normal: { x: 0, y: -1 },
    });
  });

  it('returns the centre, facing right, when the target is the centre', () => {
    expect(borderPointToward(rect, { x: 100, y: 50 })).toEqual({
      point: { x: 100, y: 50 },
      normal: { x: 1, y: 0 },
    });
  });
});

describe('resolveAnchor', () => {
  const rect = { x: 10, y: 20, width: 200, height: 100 };

  it('tracks the border for an auto anchor', () => {
    expect(resolveAnchor(rect, AUTO_ANCHOR, { x: 5_000, y: 70 })).toEqual({
      point: { x: 210, y: 70 },
      normal: { x: 1, y: 0 },
    });
  });

  it('stays put for a fixed anchor, wherever the entity is aimed', () => {
    const anchor = { mode: 'fixed', x: 0.5, y: 1 } as const;
    expect(resolveAnchor(rect, anchor, { x: 5_000, y: 70 }).point).toEqual({ x: 110, y: 120 });
    expect(resolveAnchor(rect, anchor, { x: -5_000, y: 70 }).point).toEqual({ x: 110, y: 120 });
  });

  it('gives a fixed anchor the normal of the edge it sits nearest', () => {
    expect(resolveAnchor(rect, { mode: 'fixed', x: 0.5, y: 1 }, { x: 0, y: 0 }).normal).toEqual({
      x: 0,
      y: 1,
    });
    expect(resolveAnchor(rect, { mode: 'fixed', x: 0, y: 0.5 }, { x: 0, y: 0 }).normal).toEqual({
      x: -1,
      y: 0,
    });
    expect(resolveAnchor(rect, { mode: 'fixed', x: 1, y: 0.5 }, { x: 0, y: 0 }).normal).toEqual({
      x: 1,
      y: 0,
    });
    expect(resolveAnchor(rect, { mode: 'fixed', x: 0.5, y: 0 }, { x: 0, y: 0 }).normal).toEqual({
      x: 0,
      y: -1,
    });
  });
});

describe('resolveBinding', () => {
  it('connects facing borders, and follows the entities as they move', () => {
    const binding = connector(left, right);
    const world = withEntity(worldWith(left, right), left);
    const resolved = resolveBinding(world, binding);

    expect(resolved?.from).toEqual({ x: 200, y: 50 });
    expect(resolved?.to).toEqual({ x: 500, y: 50 });
    expect(resolved?.degenerate).toBe(false);

    // Move the right-hand table below instead: the anchors slide to the
    // facing edges with no binding update at all.
    const moved = withEntity(world, place(right, 0, 400));
    const after = resolveBinding(moved, binding);
    expect(after?.from).toEqual({ x: 100, y: 100 });
    expect(after?.to).toEqual({ x: 100, y: 400 });
  });

  it('honours fixed anchors', () => {
    const binding = connector(left, right, {
      from: { mode: 'fixed', x: 1, y: 0 },
      to: { mode: 'fixed', x: 0, y: 1 },
    });
    const resolved = resolveBinding(worldWith(left, right), binding);
    expect(resolved?.from).toEqual({ x: 200, y: 0 });
    expect(resolved?.to).toEqual({ x: 500, y: 100 });
  });

  it('reports a degenerate line for coincident entities', () => {
    const stacked = place(makeTable(ids), 0, 0);
    const world = withEntity(worldWith(left), stacked);
    const resolved = resolveBinding(world, connector(left, stacked));
    expect(resolved?.degenerate).toBe(true);
  });

  it('returns null when either end is missing', () => {
    expect(resolveBinding(worldWith(left), connector(left, right))).toBeNull();
    expect(resolveBinding(worldWith(right), connector(left, right))).toBeNull();
  });

  it('resolves against drawn transforms so a drag previews live', () => {
    const binding = connector(left, right);
    const world = worldWith(left, right);
    const dragged = resolveBinding(world, binding, (id) =>
      id === right.id
        ? { x: 900, y: 0, z: 0, width: 200, height: 100 }
        : world.entities.get(id)?.transform,
    );
    expect(dragged?.to).toEqual({ x: 900, y: 50 });
    // The committed world is untouched.
    expect(resolveBinding(world, binding)?.to).toEqual({ x: 500, y: 50 });
  });
});

describe('entityRect', () => {
  it('drops the z coordinate', () => {
    expect(entityRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });
});

describe('CreateBinding', () => {
  it('adds a binding between two entities', () => {
    const binding = connector(left, right);
    const next = unwrap(applyCommand(worldWith(left, right), { type: 'CreateBinding', binding }));
    expect(getBinding(next, binding.id)).toEqual(binding);
    expect(bindingsOf(next, left.id)).toEqual([binding]);
    expect(bindingsOf(next, right.id)).toEqual([binding]);
    expect(bindingsFrom(next, left.id)).toEqual([binding]);
    expect(bindingsFrom(next, right.id)).toEqual([]);
  });

  const expectError = (world: WorldState, binding: Binding, code: string): void => {
    const result = applyCommand(world, { type: 'CreateBinding', binding });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  };

  it('rejects a duplicate id', () => {
    const binding = connector(left, right);
    const world = unwrap(applyCommand(worldWith(left, right), { type: 'CreateBinding', binding }));
    expectError(world, binding, 'duplicate-binding');
  });

  it('rejects binding an entity to itself', () => {
    expectError(worldWith(left), connector(left, left), 'invalid-argument');
  });

  it('rejects unknown entities', () => {
    expectError(worldWith(left), connector(left, right), 'entity-not-found');
    expectError(worldWith(right), connector(left, right), 'entity-not-found');
  });

  it('rejects anchors outside the normalised range', () => {
    const world = worldWith(left, right);
    for (const anchor of [
      { mode: 'fixed', x: -0.1, y: 0 },
      { mode: 'fixed', x: 1.1, y: 0 },
      { mode: 'fixed', x: 0, y: -0.1 },
      { mode: 'fixed', x: 0, y: 1.1 },
      { mode: 'fixed', x: Number.NaN, y: 0 },
      { mode: 'fixed', x: 0, y: Number.NaN },
    ] as const) {
      expectError(world, connector(left, right, { from: anchor }), 'invalid-argument');
      expectError(world, connector(left, right, { to: anchor }), 'invalid-argument');
    }
  });

  it('accepts anchors on the boundary', () => {
    const world = worldWith(left, right);
    expect(
      applyCommand(world, {
        type: 'CreateBinding',
        binding: connector(left, right, {
          from: { mode: 'fixed', x: 0, y: 0 },
          to: { mode: 'fixed', x: 1, y: 1 },
        }),
      }).ok,
    ).toBe(true);
  });
});

describe('RemoveBindings', () => {
  it('removes bindings and leaves the entities alone', () => {
    const binding = connector(left, right);
    const world = unwrap(applyCommand(worldWith(left, right), { type: 'CreateBinding', binding }));
    const next = unwrap(applyCommand(world, { type: 'RemoveBindings', ids: [binding.id] }));

    expect(next.bindings.size).toBe(0);
    expect(next.entities.size).toBe(2);
  });

  it('rejects empty and unknown id lists', () => {
    const world = worldWith(left, right);
    expect(applyCommand(world, { type: 'RemoveBindings', ids: [] }).ok).toBe(false);
    const missing = applyCommand(world, {
      type: 'RemoveBindings',
      ids: ['binding:none' as BindingId],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('binding-not-found');
  });
});

describe('removing a bound entity', () => {
  it('cascades to every binding that referenced it', () => {
    const first = connector(left, right);
    const second = connector(right, below);
    let world = worldWith(left, right, below);
    world = unwrap(applyCommand(world, { type: 'CreateBinding', binding: first }));
    world = unwrap(applyCommand(world, { type: 'CreateBinding', binding: second }));
    expect(world.bindings.size).toBe(2);

    // Removing the middle table takes both of its bindings with it.
    const next = unwrap(applyCommand(world, { type: 'RemoveEntities', ids: [right.id] }));
    expect(next.bindings.size).toBe(0);
    expect(next.entities.size).toBe(2);
  });

  it('leaves unrelated bindings in place', () => {
    const binding = connector(left, right);
    let world = worldWith(left, right, below);
    world = unwrap(applyCommand(world, { type: 'CreateBinding', binding }));
    const next = unwrap(applyCommand(world, { type: 'RemoveEntities', ids: [below.id] }));
    expect(next.bindings.size).toBe(1);
  });

  it('keeps bindings out of the way of ordinary moves', () => {
    const binding = connector(left, right);
    const world = unwrap(applyCommand(worldWith(left, right), { type: 'CreateBinding', binding }));
    const moved = unwrap(
      applyCommand(world, {
        type: 'MoveEntities',
        ids: [left.id],
        position: { x: -900, y: 0, z: 0 },
      }),
    );
    // The binding record is untouched; only the resolved geometry differs.
    expect(moved.bindings.get(binding.id)).toBe(binding);
    expect(resolveBinding(moved, binding)?.from.x).toBe(-700);
  });
});
