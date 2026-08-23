import { applyCommand } from './apply.js';
import type { Command, CommandError } from './commands.js';
import type { WorldConstraints } from './constraints.js';
import { DEFAULT_CONSTRAINTS } from './constraints.js';
import type { Commit, HistoryError, HistoryGraph } from './history.js';
import {
  canRedo,
  canUndo,
  commit as appendCommit,
  createHistory,
  headCommit,
  headWorld,
  redo as redoHistory,
  setHead as setHistoryHead,
  undo as undoHistory,
} from './history.js';
import type { CommitId, IdFactory } from './ids.js';
import { createIdFactory } from './ids.js';
import type { Result } from './result.js';
import { ok } from './result.js';
import type { SessionCommand, SessionState } from './session.js';
import { applySessionCommand, emptySession } from './session.js';
import type { WorldState } from './world.js';
import { emptyWorld } from './world.js';

/**
 * Panorama Core.
 *
 * The single owner of document, history and session state. The renderer, the
 * React shell and (later) an MCP adapter are all projections of this object;
 * none of them may mutate persistent state directly.
 */

export type CoreChange =
  /** A command was applied and a new commit created. */
  | { readonly type: 'document'; readonly commit: Commit }
  /** The active history head moved (undo, redo, or an explicit checkout). */
  | { readonly type: 'history'; readonly head: CommitId }
  /** Session state changed. Never recorded in history. */
  | { readonly type: 'session' };

export type CoreListener = (change: CoreChange, core: PanoramaCore) => void;

export interface PanoramaCoreOptions {
  readonly ids?: IdFactory;
  readonly constraints?: WorldConstraints;
  readonly clock?: () => number;
  readonly initialWorld?: WorldState;
}

export class PanoramaCore {
  readonly #ids: IdFactory;
  readonly #constraints: WorldConstraints;
  readonly #clock: () => number;
  readonly #listeners = new Set<CoreListener>();
  #history: HistoryGraph;
  #session: SessionState = emptySession();

  constructor(options: PanoramaCoreOptions = {}) {
    this.#ids = options.ids ?? createIdFactory();
    this.#constraints = options.constraints ?? DEFAULT_CONSTRAINTS;
    this.#clock = options.clock ?? ((): number => Date.now());
    this.#history = createHistory({
      rootId: this.#ids.commit(),
      world: options.initialWorld ?? emptyWorld(),
      timestamp: this.#clock(),
    });
  }

  get ids(): IdFactory {
    return this.#ids;
  }

  get constraints(): WorldConstraints {
    return this.#constraints;
  }

  get world(): WorldState {
    return headWorld(this.#history);
  }

  get history(): HistoryGraph {
    return this.#history;
  }

  get session(): SessionState {
    return this.#session;
  }

  get canUndo(): boolean {
    return canUndo(this.#history);
  }

  get canRedo(): boolean {
    return canRedo(this.#history);
  }

  subscribe(listener: CoreListener): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Applies a document command. On success a commit is appended to the history
   * graph; committing from a non-tip head creates a branch rather than
   * discarding the previously reachable future.
   */
  dispatch(command: Command): Result<Commit, CommandError> {
    const applied = applyCommand(this.world, command, this.#constraints);
    if (!applied.ok) return applied;
    this.#history = appendCommit(this.#history, {
      id: this.#ids.commit(),
      command,
      world: applied.value,
      timestamp: this.#clock(),
    });
    const created = headCommit(this.#history);
    this.#emit({ type: 'document', commit: created });
    return ok(created);
  }

  /** Applies a session command. Session state is never recorded in history. */
  dispatchSession(command: SessionCommand): SessionState {
    const next = applySessionCommand(this.#session, command);
    if (next === this.#session) return next;
    this.#session = next;
    this.#emit({ type: 'session' });
    return next;
  }

  undo(): boolean {
    const next = undoHistory(this.#history);
    return this.#moveHead(next);
  }

  redo(): boolean {
    const next = redoHistory(this.#history);
    return this.#moveHead(next);
  }

  /** Activates an arbitrary commit — the general form of undo/redo. */
  setHead(id: CommitId): Result<HistoryGraph, HistoryError> {
    const result = setHistoryHead(this.#history, id);
    if (!result.ok) return result;
    this.#moveHead(result.value);
    return result;
  }

  #moveHead(next: HistoryGraph): boolean {
    if (next.head === this.#history.head) return false;
    this.#history = next;
    this.#emit({ type: 'history', head: next.head });
    return true;
  }

  #emit(change: CoreChange): void {
    for (const listener of [...this.#listeners]) {
      listener(change, this);
    }
  }
}
