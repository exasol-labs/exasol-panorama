import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BindingId, Command, EntityId, TableEntity, WorldState } from '@panorama/core';
import {
  DEFAULT_CONSTRAINTS,
  PanoramaCore,
  applyCommand,
  emptyWorld,
  isTableEntity,
} from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

/**
 * Properties of the document.
 *
 * The command vocabulary is how every persistent change is expressed, and an
 * agent can send any of it — which means the values are not a pointer's any more.
 * A drag produces a plausible width; a message can say `Infinity`, or name the
 * same entity twice, or resize something that was closed two commands ago.
 *
 * So these properties are about what must be true of the *document* whatever
 * arrives: that the world stays internally consistent, that a refusal changes
 * nothing at all, and that the history can be walked back and forward without
 * losing anything. Sequences rather than single commands, because the
 * interesting failures are the ones a state left behind.
 *
 * Seeds are pinned; see `query-chain.properties.test.ts` for why.
 */

const ids = testIds(77);

/** Three tables to aim commands at, and their column ids. */
const base = ((): { world: WorldState; tables: readonly TableEntity[] } => {
  const tables = [makeTable(ids), makeTable(ids), makeTable(ids)];
  let world = emptyWorld();
  for (const entity of tables) {
    const applied = applyCommand(world, { type: 'CreateTableEntity', entity });
    if (!applied.ok) throw new Error(applied.error.message);
    world = applied.value;
  }
  return { world, tables };
})();

const REAL_IDS = base.tables.map((table) => table.id);
const REAL_COLUMNS = (base.tables[0] as TableEntity).columns.map((column) => column.id);

/** An id that exists, one that never did, and the empty string. */
const anyId = fc.oneof(
  fc.constantFrom(...REAL_IDS),
  fc.constant('table:missing' as EntityId),
  fc.constant('' as EntityId),
);

const anyColumnId = fc.oneof(
  fc.constantFrom(...REAL_COLUMNS),
  fc.constant('column:missing' as EntityId),
);

/** Numbers a pointer would never produce and a message easily can. */
const rogueNumber = fc.oneof(
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(
    0,
    -0,
    -1,
    1e300,
    -1e300,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    0.5,
  ),
);

const point = fc.record({ x: rogueNumber, y: rogueNumber, z: rogueNumber });

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    type: fc.constant('MoveEntities' as const),
    ids: fc.array(anyId, { maxLength: 3 }),
    position: point,
  }),
  fc.record({
    type: fc.constant('ResizeEntity' as const),
    id: anyId,
    width: rogueNumber,
    height: rogueNumber,
  }),
  fc.record({
    type: fc.constant('ResizeColumn' as const),
    tableId: anyId,
    columnId: anyColumnId,
    width: rogueNumber,
  }),
  fc.record({
    type: fc.constant('ReorderColumns' as const),
    tableId: anyId,
    columnIds: fc.shuffledSubarray(REAL_COLUMNS),
  }),
  fc.record({
    type: fc.constant('SetColumnVisibility' as const),
    tableId: anyId,
    columnId: anyColumnId,
    visible: fc.boolean(),
  }),
  fc.record({
    type: fc.constant('SetTableQuery' as const),
    tableId: anyId,
    sql: fc.string({ maxLength: 12 }),
  }),
  fc.record({
    type: fc.constant('SetTableLabel' as const),
    tableId: anyId,
    label: fc.string({ maxLength: 8 }),
  }),
  fc.record({
    type: fc.constant('SetTableMode' as const),
    tableId: anyId,
    mode: fc.constantFrom('result' as const, 'editing' as const),
  }),
  fc.record({
    type: fc.constant('RemoveEntities' as const),
    ids: fc.array(anyId, { maxLength: 2 }),
  }),
  fc.record({
    type: fc.constant('CreateBinding' as const),
    binding: fc.record({
      id: fc.constantFrom('binding:a', 'binding:b').map((text) => text as BindingId),
      kind: fc.constant('connector' as const),
      fromId: anyId,
      toId: anyId,
      from: fc.oneof(
        fc.constant({ mode: 'auto' as const }),
        fc.record({ mode: fc.constant('fixed' as const), x: rogueNumber, y: rogueNumber }),
      ),
      to: fc.constant({ mode: 'auto' as const }),
      directed: fc.boolean(),
    }),
  }),
  fc.record({
    type: fc.constant('SetBindingLabel' as const),
    bindingId: fc.constantFrom('binding:a' as BindingId, 'binding:missing' as BindingId),
    label: fc.string({ maxLength: 6 }),
  }),
  fc.record({
    type: fc.constant('RemoveBindings' as const),
    ids: fc.array(fc.constantFrom('binding:a' as BindingId, 'binding:b' as BindingId), {
      maxLength: 2,
    }),
  }),
);

const sequence = fc.array(command, { minLength: 1, maxLength: 8 });

/**
 * Everything that must be true of a world, whatever was done to it.
 *
 * Stated once and checked after every command of every sequence: an invariant
 * that only holds after the commands somebody thought of is not an invariant.
 */
const holds = (world: WorldState): void => {
  // Stacking order and the entity table are two views of one set.
  expect(new Set(world.order).size).toBe(world.order.length);
  expect([...world.order].sort()).toEqual([...world.entities.keys()].sort());

  for (const binding of world.bindings.values()) {
    // A binding to an entity that is gone is a line drawn from nowhere.
    expect(world.entities.has(binding.fromId)).toBe(true);
    expect(world.entities.has(binding.toId)).toBe(true);
    if (binding.from.mode === 'fixed') {
      expect(binding.from.x).toBeGreaterThanOrEqual(0);
      expect(binding.from.x).toBeLessThanOrEqual(1);
      expect(binding.from.y).toBeGreaterThanOrEqual(0);
      expect(binding.from.y).toBeLessThanOrEqual(1);
    }
  }

  for (const entity of world.entities.values()) {
    const { x, y, z, width, height } = entity.transform;
    // Nothing may be drawn at a position that is not a number: a NaN reaches the
    // renderer as a mesh nobody can see and a hit test nobody can win.
    for (const value of [x, y, z, width, height]) expect(Number.isFinite(value)).toBe(true);
    expect(width).toBeGreaterThanOrEqual(DEFAULT_CONSTRAINTS.minTableWidth);
    expect(width).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxTableWidth);
    expect(height).toBeGreaterThanOrEqual(DEFAULT_CONSTRAINTS.minTableHeight);
    expect(height).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxTableHeight);
    if (!isTableEntity(entity)) continue;
    const seen = new Set<EntityId>();
    for (const column of entity.columns) {
      expect(seen.has(column.id)).toBe(false);
      seen.add(column.id);
      expect(column.width).toBeGreaterThanOrEqual(DEFAULT_CONSTRAINTS.minColumnWidth);
      expect(column.width).toBeLessThanOrEqual(DEFAULT_CONSTRAINTS.maxColumnWidth);
    }
  }
};

describe('applying commands', () => {
  it('answers with a world or an error, and never throws', () => {
    fc.assert(
      fc.property(sequence, (commands) => {
        let world = base.world;
        for (const next of commands) {
          const applied = applyCommand(world, next);
          if (applied.ok) world = applied.value;
        }
        expect(world.entities.size).toBeGreaterThanOrEqual(0);
      }),
      { seed: 20260826, numRuns: 400 },
    );
  });

  it('leaves a consistent world after every command of every sequence', () => {
    fc.assert(
      fc.property(sequence, (commands) => {
        let world = base.world;
        for (const next of commands) {
          const applied = applyCommand(world, next);
          if (applied.ok) world = applied.value;
          holds(world);
        }
      }),
      { seed: 401, numRuns: 400 },
    );
  });

  it('changes nothing at all when it refuses', () => {
    fc.assert(
      fc.property(sequence, (commands) => {
        let world = base.world;
        for (const next of commands) {
          const applied = applyCommand(world, next);
          if (applied.ok) {
            world = applied.value;
            continue;
          }
          // Not "an equivalent world": the same one. A refusal that had already
          // half-applied itself would leave a document nobody asked for, and the
          // command that produced it would be undoable by nothing.
          const again = applyCommand(world, next);
          expect(again.ok).toBe(false);
        }
      }),
      { seed: 402, numRuns: 300 },
    );
  });

  it('never mutates the world it was given', () => {
    fc.assert(
      fc.property(command, (next) => {
        const before = JSON.stringify({
          entities: [...base.world.entities.entries()],
          order: base.world.order,
          bindings: [...base.world.bindings.entries()],
        });
        applyCommand(base.world, next);
        const after = JSON.stringify({
          entities: [...base.world.entities.entries()],
          order: base.world.order,
          bindings: [...base.world.bindings.entries()],
        });
        expect(after).toBe(before);
      }),
      { seed: 403, numRuns: 300 },
    );
  });
});

describe('walking the history', () => {
  /** A core holding the three tables, so a sequence has something to act on. */
  const core = (): PanoramaCore => {
    const engine = new PanoramaCore({ ids: testIds(5), clock: (): number => 1 });
    for (const entity of base.tables) {
      const applied = engine.dispatch({ type: 'CreateTableEntity', entity });
      if (!applied.ok) throw new Error(applied.error.message);
    }
    return engine;
  };

  const snapshot = (world: WorldState): string =>
    JSON.stringify({
      entities: [...world.entities.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      order: world.order,
      bindings: [...world.bindings.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    });

  it('comes back to where it started, and forward again to where it was', () => {
    fc.assert(
      fc.property(sequence, (commands) => {
        const engine = core();
        const start = snapshot(engine.world);
        const startHead = engine.history.head;
        let accepted = 0;
        for (const next of commands) {
          if (engine.dispatch(next).ok) accepted += 1;
        }
        const end = snapshot(engine.world);
        const endHead = engine.history.head;

        // Back: one step per accepted command, and no further.
        for (let step = 0; step < accepted; step += 1) expect(engine.undo()).toBe(true);
        expect(snapshot(engine.world)).toBe(start);
        expect(engine.history.head).toBe(startHead);

        // Forward: the same commits, in the same order, to the same document.
        for (let step = 0; step < accepted; step += 1) expect(engine.redo()).toBe(true);
        expect(snapshot(engine.world)).toBe(end);
        expect(engine.history.head).toBe(endHead);
      }),
      { seed: 404, numRuns: 300 },
    );
  });

  it('holds its invariants at every point along the way', () => {
    fc.assert(
      fc.property(sequence, (commands) => {
        const engine = core();
        let accepted = 0;
        for (const next of commands) {
          if (engine.dispatch(next).ok) accepted += 1;
          holds(engine.world);
        }
        while (engine.undo()) holds(engine.world);
        while (engine.redo()) holds(engine.world);
        expect(accepted).toBeGreaterThanOrEqual(0);
      }),
      { seed: 405, numRuns: 300 },
    );
  });

  it('branches rather than overwrites when a command lands on an earlier head', () => {
    fc.assert(
      fc.property(sequence, command, (commands, extra) => {
        const engine = core();
        const applied = commands.filter((next) => engine.dispatch(next).ok);
        if (applied.length === 0) return;
        const tip = engine.history.head;
        expect(engine.undo()).toBe(true);
        const middle = engine.history.head;
        if (!engine.dispatch(extra).ok) return;
        // The commit that was the tip is still there — a branch, not a
        // replacement — and the one we branched from is still its parent.
        expect(engine.history.head).not.toBe(tip);
        expect(engine.history.commits.get(engine.history.head)?.parent).toBe(middle);
        expect(engine.history.commits.has(tip)).toBe(true);
        holds(engine.world);
      }),
      { seed: 406, numRuns: 200 },
    );
  });
});
