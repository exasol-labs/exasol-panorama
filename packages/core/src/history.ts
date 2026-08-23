import type { Command } from './commands.js';
import type { CommitId } from './ids.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import type { WorldState } from './world.js';

/**
 * Panorama has no undo *stack*. It has an immutable history graph.
 *
 * Undo moves the active head to the parent commit; it never destroys commits.
 * Committing while the head has children creates a sibling branch, so both
 * paths remain reachable:
 *
 *     A ── B ── C ── D
 *           \
 *            E ── F
 */

export interface Commit {
  readonly id: CommitId;
  readonly parent: CommitId | null;
  /** `null` only for the root commit, which represents the empty document. */
  readonly command: Command | null;
  readonly timestamp: number;
  readonly world: WorldState;
}

export interface HistoryGraph {
  readonly commits: ReadonlyMap<CommitId, Commit>;
  readonly children: ReadonlyMap<CommitId, readonly CommitId[]>;
  readonly root: CommitId;
  readonly head: CommitId;
}

export interface HistoryError {
  readonly code: 'unknown-commit';
  readonly message: string;
}

export interface CreateHistoryOptions {
  readonly rootId: CommitId;
  readonly world: WorldState;
  readonly timestamp?: number;
}

export const createHistory = (options: CreateHistoryOptions): HistoryGraph => {
  const root: Commit = {
    id: options.rootId,
    parent: null,
    command: null,
    timestamp: options.timestamp ?? 0,
    world: options.world,
  };
  return {
    commits: new Map([[root.id, root]]),
    children: new Map(),
    root: root.id,
    head: root.id,
  };
};

export interface CommitOptions {
  readonly id: CommitId;
  readonly command: Command;
  readonly world: WorldState;
  readonly timestamp?: number;
}

/** Appends a commit as a child of the current head and advances the head. */
export const commit = (history: HistoryGraph, options: CommitOptions): HistoryGraph => {
  const next: Commit = {
    id: options.id,
    parent: history.head,
    command: options.command,
    timestamp: options.timestamp ?? 0,
    world: options.world,
  };
  const commits = new Map(history.commits);
  commits.set(next.id, next);
  const children = new Map(history.children);
  children.set(history.head, [...(history.children.get(history.head) ?? []), next.id]);
  return { commits, children, root: history.root, head: next.id };
};

export const getCommit = (history: HistoryGraph, id: CommitId): Commit | undefined =>
  history.commits.get(id);

export const headCommit = (history: HistoryGraph): Commit =>
  // The head is always a member of the graph by construction.
  history.commits.get(history.head) as Commit;

export const headWorld = (history: HistoryGraph): WorldState => headCommit(history).world;

export const childrenOf = (history: HistoryGraph, id: CommitId): readonly CommitId[] =>
  history.children.get(id) ?? [];

export const canUndo = (history: HistoryGraph): boolean => headCommit(history).parent !== null;

export const canRedo = (history: HistoryGraph): boolean =>
  childrenOf(history, history.head).length > 0;

/** Moves the head to the parent commit. Returns the graph unchanged at the root. */
export const undo = (history: HistoryGraph): HistoryGraph => {
  const parent = headCommit(history).parent;
  if (parent === null) return history;
  return { ...history, head: parent };
};

/**
 * Moves the head to a child commit. With several branches the most recently
 * created one is chosen, which matches the intuition that redo follows the
 * work you did last.
 */
export const redo = (history: HistoryGraph): HistoryGraph => {
  const children = childrenOf(history, history.head);
  const target = children.at(-1);
  if (target === undefined) return history;
  return { ...history, head: target };
};

/** Explicitly activates any commit in the graph — the general form of undo/redo. */
export const setHead = (
  history: HistoryGraph,
  id: CommitId,
): Result<HistoryGraph, HistoryError> => {
  if (!history.commits.has(id)) {
    return err({ code: 'unknown-commit', message: `No commit with id ${id}` });
  }
  return ok({ ...history, head: id });
};

/** The commit chain from `id` back to the root, ordered root-first. */
export const pathToRoot = (history: HistoryGraph, id: CommitId): readonly CommitId[] => {
  const path: CommitId[] = [];
  let current: CommitId | null = id;
  while (current !== null) {
    const found: Commit | undefined = history.commits.get(current);
    if (found === undefined) break;
    path.push(found.id);
    current = found.parent;
  }
  return path.reverse();
};

/** Commits with no children: the tip of every branch. */
export const branchTips = (history: HistoryGraph): readonly CommitId[] =>
  [...history.commits.keys()].filter((id) => childrenOf(history, id).length === 0);
