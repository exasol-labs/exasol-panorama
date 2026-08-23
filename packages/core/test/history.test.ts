import { describe, expect, it } from 'vitest';
import type { Command, CommitId, HistoryGraph } from '@panorama/core';
import {
  branchTips,
  canRedo,
  canUndo,
  childrenOf,
  commit,
  createHistory,
  emptyWorld,
  getCommit,
  headCommit,
  headWorld,
  pathToRoot,
  redo,
  setHead,
  undo,
  withEntity,
} from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

const ids = testIds();
const table = makeTable(ids);
const createCommand: Command = { type: 'CreateTableEntity', entity: table };

const base = (): HistoryGraph =>
  createHistory({ rootId: ids.commit(), world: emptyWorld(), timestamp: 1 });

describe('history graph', () => {
  it('starts at a root commit holding the initial world', () => {
    const history = base();
    expect(history.head).toBe(history.root);
    expect(headCommit(history).command).toBeNull();
    expect(headCommit(history).parent).toBeNull();
    expect(headWorld(history).entities.size).toBe(0);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('appends commits and advances the head', () => {
    const history = base();
    const id = ids.commit();
    const next = commit(history, {
      id,
      command: createCommand,
      world: withEntity(emptyWorld(), table),
      timestamp: 2,
    });
    expect(next.head).toBe(id);
    expect(getCommit(next, id)?.parent).toBe(history.head);
    expect(childrenOf(next, history.root)).toEqual([id]);
    expect(headWorld(next).entities.size).toBe(1);
    // The previous graph is untouched.
    expect(history.commits.size).toBe(1);
  });

  it('defaults the commit timestamp', () => {
    const history = createHistory({ rootId: ids.commit(), world: emptyWorld() });
    expect(headCommit(history).timestamp).toBe(0);
    const next = commit(history, { id: ids.commit(), command: createCommand, world: emptyWorld() });
    expect(headCommit(next).timestamp).toBe(0);
  });

  it('undoes by moving the head without destroying commits', () => {
    const history = base();
    const id = ids.commit();
    const withTable = commit(history, {
      id,
      command: createCommand,
      world: withEntity(emptyWorld(), table),
    });
    const undone = undo(withTable);
    expect(undone.head).toBe(history.root);
    expect(undone.commits.has(id)).toBe(true);
    expect(canRedo(undone)).toBe(true);
    expect(redo(undone).head).toBe(id);
  });

  it('is a no-op to undo at the root or redo at a tip', () => {
    const history = base();
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('branches when committing from a non-tip head', () => {
    //       Move A
    //      /
    // Base
    //      \
    //       Move B
    const root = base();
    const withTable = commit(root, {
      id: ids.commit(),
      command: createCommand,
      world: withEntity(emptyWorld(), table),
    });
    const moveA = ids.commit();
    const branchA = commit(withTable, {
      id: moveA,
      command: { type: 'MoveEntities', ids: [table.id], position: { x: 100, y: 0, z: 0 } },
      world: withEntity(emptyWorld(), {
        ...table,
        transform: { ...table.transform, x: 100 },
      }),
    });
    const rewound = undo(branchA);
    const moveB = ids.commit();
    const branchB = commit(rewound, {
      id: moveB,
      command: { type: 'MoveEntities', ids: [table.id], position: { x: -100, y: 0, z: 0 } },
      world: withEntity(emptyWorld(), {
        ...table,
        transform: { ...table.transform, x: -100 },
      }),
    });

    expect(childrenOf(branchB, withTable.head)).toEqual([moveA, moveB]);
    expect([...branchTips(branchB)].sort()).toEqual([moveA, moveB].sort());
    // Both historical paths remain fully reachable.
    expect(getCommit(branchB, moveA)?.world.entities.get(table.id)?.transform.x).toBe(100);
    expect(getCommit(branchB, moveB)?.world.entities.get(table.id)?.transform.x).toBe(-100);
    // Redo follows the branch created most recently.
    expect(redo(undo(branchB)).head).toBe(moveB);
  });

  it('checks out any commit by id', () => {
    const root = base();
    const id = ids.commit();
    const next = commit(root, { id, command: createCommand, world: emptyWorld() });
    const back = setHead(next, root.root);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.head).toBe(root.root);

    const missing = setHead(next, 'commit:none' as CommitId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown-commit');
  });

  it('reports the path from a commit back to the root', () => {
    const root = base();
    const first = ids.commit();
    const second = ids.commit();
    let history = commit(root, { id: first, command: createCommand, world: emptyWorld() });
    history = commit(history, { id: second, command: createCommand, world: emptyWorld() });
    expect(pathToRoot(history, second)).toEqual([root.root, first, second]);
  });

  it('stops at unknown commits when walking to the root', () => {
    const history = base();
    expect(pathToRoot(history, 'commit:none' as CommitId)).toEqual([]);
  });
});
