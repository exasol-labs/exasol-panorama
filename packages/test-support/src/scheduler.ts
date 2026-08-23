/** Deferred execution, injectable so tests can drive time by hand. */
export type Scheduler = (callback: () => void, delayMs: number) => void;

export const immediateScheduler: Scheduler = (callback) => {
  queueMicrotask(callback);
};

export const timeoutScheduler: Scheduler = (callback, delayMs) => {
  setTimeout(callback, delayMs);
};

interface ScheduledTask {
  readonly at: number;
  readonly sequence: number;
  readonly callback: () => void;
}

/**
 * A virtual clock. Tasks fire in due-time order, so simulated latency produces
 * exactly the interleaving a real network would — including responses arriving
 * out of the order they were requested.
 */
export class ManualScheduler {
  #now = 0;
  #sequence = 0;
  #tasks: ScheduledTask[] = [];

  get now(): number {
    return this.#now;
  }

  get pendingCount(): number {
    return this.#tasks.length;
  }

  readonly schedule: Scheduler = (callback, delayMs) => {
    this.#tasks.push({
      at: this.#now + Math.max(0, delayMs),
      sequence: this.#sequence++,
      callback,
    });
  };

  /** Advances virtual time, running everything that becomes due. */
  advance(deltaMs: number): void {
    const target = this.#now + Math.max(0, deltaMs);
    for (;;) {
      const due = this.#nextDue(target);
      if (due === null) break;
      this.#now = due.at;
      this.#tasks = this.#tasks.filter((task) => task !== due);
      due.callback();
    }
    this.#now = target;
  }

  /** Runs every scheduled task, including ones scheduled while draining. */
  runAll(): void {
    let guard = 0;
    while (this.#tasks.length > 0) {
      if (++guard > 100_000) throw new Error('ManualScheduler did not drain');
      const next = this.#tasks.reduce((best, task) =>
        task.at < best.at || (task.at === best.at && task.sequence < best.sequence) ? task : best,
      );
      this.#now = Math.max(this.#now, next.at);
      this.#tasks = this.#tasks.filter((task) => task !== next);
      next.callback();
    }
  }

  #nextDue(target: number): ScheduledTask | null {
    let best: ScheduledTask | null = null;
    for (const task of this.#tasks) {
      if (task.at > target) continue;
      if (
        best === null ||
        task.at < best.at ||
        (task.at === best.at && task.sequence < best.sequence)
      ) {
        best = task;
      }
    }
    return best;
  }
}
