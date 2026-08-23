import { describe, expect, it, vi } from 'vitest';
import type { CommitId, CoreChange } from '@panorama/core';
import { DEFAULT_CONSTRAINTS, PanoramaCore, unwrap } from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

const createCore = (): PanoramaCore => {
  let time = 0;
  return new PanoramaCore({ ids: testIds(), clock: (): number => (time += 1) });
};

describe('PanoramaCore', () => {
  it('starts with an empty world at a root commit', () => {
    const core = createCore();
    expect(core.world.entities.size).toBe(0);
    expect(core.history.head).toBe(core.history.root);
    expect(core.canUndo).toBe(false);
    expect(core.canRedo).toBe(false);
    expect(core.constraints).toBe(DEFAULT_CONSTRAINTS);
    expect(core.ids.entity('table')).toMatch(/^table:/);
  });

  it('uses real defaults when no options are supplied', () => {
    const core = new PanoramaCore();
    expect(core.world.entities.size).toBe(0);
    expect(core.history.root).toMatch(/^commit:/);
  });

  it('accepts an initial world', () => {
    const ids = testIds();
    const table = makeTable(ids);
    const core = new PanoramaCore({
      ids,
      initialWorld: { entities: new Map([[table.id, table]]), order: [table.id] },
    });
    expect(core.world.entities.size).toBe(1);
  });

  it('commits successful commands and notifies subscribers', () => {
    const core = createCore();
    const changes: CoreChange[] = [];
    const unsubscribe = core.subscribe((change) => changes.push(change));

    const table = makeTable(core.ids);
    const created = unwrap(core.dispatch({ type: 'CreateTableEntity', entity: table }));

    expect(core.world.entities.get(table.id)).toBeDefined();
    expect(created.command).toEqual({ type: 'CreateTableEntity', entity: table });
    expect(created.timestamp).toBeGreaterThan(0);
    expect(changes).toEqual([{ type: 'document', commit: created }]);
    expect(core.canUndo).toBe(true);

    unsubscribe();
    core.dispatch({ type: 'MoveEntities', ids: [table.id], position: { x: 1, y: 1, z: 0 } });
    expect(changes).toHaveLength(1);
  });

  it('rejects invalid commands without committing', () => {
    const core = createCore();
    const listener = vi.fn();
    core.subscribe(listener);

    const result = core.dispatch({ type: 'RemoveEntities', ids: [] });
    expect(result.ok).toBe(false);
    expect(core.history.commits.size).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports undo, redo and branching', () => {
    const core = createCore();
    const table = makeTable(core.ids);
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const baseHead = core.history.head;

    core.dispatch({ type: 'MoveEntities', ids: [table.id], position: { x: 100, y: 0, z: 0 } });
    const moveA = core.history.head;
    expect(core.world.entities.get(table.id)?.transform.x).toBe(100);

    expect(core.undo()).toBe(true);
    expect(core.history.head).toBe(baseHead);
    expect(core.world.entities.get(table.id)?.transform.x).toBe(0);

    core.dispatch({ type: 'MoveEntities', ids: [table.id], position: { x: -100, y: 0, z: 0 } });
    const moveB = core.history.head;

    // Both branches survive.
    expect(core.history.commits.get(moveA)?.world.entities.get(table.id)?.transform.x).toBe(100);
    expect(core.history.commits.get(moveB)?.world.entities.get(table.id)?.transform.x).toBe(-100);

    expect(core.undo()).toBe(true);
    expect(core.redo()).toBe(true);
    expect(core.history.head).toBe(moveB);
  });

  it('reports when undo and redo do nothing', () => {
    const core = createCore();
    expect(core.undo()).toBe(false);
    expect(core.redo()).toBe(false);
  });

  it('emits a history change when the head moves', () => {
    const core = createCore();
    const table = makeTable(core.ids);
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const changes: CoreChange[] = [];
    core.subscribe((change) => changes.push(change));
    core.undo();
    expect(changes).toEqual([{ type: 'history', head: core.history.root }]);
  });

  it('checks out arbitrary commits', () => {
    const core = createCore();
    const table = makeTable(core.ids);
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const target = core.history.root;

    const result = core.setHead(target);
    expect(result.ok).toBe(true);
    expect(core.world.entities.size).toBe(0);

    const missing = core.setHead('commit:none' as CommitId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown-commit');

    // Re-activating the current head is a no-op but still succeeds.
    expect(core.setHead(target).ok).toBe(true);
  });

  it('keeps session state out of history', () => {
    const core = createCore();
    const table = makeTable(core.ids);
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const commitsBefore = core.history.commits.size;

    const changes: CoreChange[] = [];
    core.subscribe((change) => changes.push(change));
    const session = core.dispatchSession({ type: 'SetSelection', ids: [table.id] });

    expect(session.selection).toEqual([table.id]);
    expect(core.session.focusedTable).toBe(table.id);
    expect(core.history.commits.size).toBe(commitsBefore);
    expect(changes).toEqual([{ type: 'session' }]);

    // A no-op session command notifies nobody.
    core.dispatchSession({ type: 'SetSelection', ids: [table.id] });
    expect(changes).toHaveLength(1);
  });

  it('tolerates subscribers unsubscribing during a notification', () => {
    const core = createCore();
    const seen: string[] = [];
    const off = core.subscribe(() => {
      seen.push('first');
      off();
    });
    core.subscribe(() => seen.push('second'));
    core.dispatchSession({ type: 'SetHovered', id: 'table:x' as never });
    core.dispatchSession({ type: 'SetHovered', id: 'table:y' as never });
    expect(seen).toEqual(['first', 'second', 'second']);
  });
});
