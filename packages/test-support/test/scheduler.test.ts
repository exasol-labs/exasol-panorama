import { describe, expect, it, vi } from 'vitest';
import {
  ManualScheduler,
  immediateScheduler,
  seededRandom,
  timeoutScheduler,
} from '@panorama/test-support';

describe('seededRandom', () => {
  it('is reproducible and stays in range', () => {
    const first = seededRandom(7);
    const second = seededRandom(7);
    const values = Array.from({ length: 100 }, () => first());
    expect(values).toEqual(Array.from({ length: 100 }, () => second()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(90);
  });

  it('survives a zero seed', () => {
    expect(seededRandom(0)()).toBeGreaterThanOrEqual(0);
  });
});

describe('ManualScheduler', () => {
  it('runs tasks in due-time order', () => {
    const scheduler = new ManualScheduler();
    const order: string[] = [];
    scheduler.schedule(() => order.push('late'), 100);
    scheduler.schedule(() => order.push('early'), 10);
    scheduler.schedule(() => order.push('same'), 10);

    expect(scheduler.pendingCount).toBe(3);
    scheduler.advance(10);
    expect(order).toEqual(['early', 'same']);
    expect(scheduler.now).toBe(10);

    scheduler.advance(200);
    expect(order).toEqual(['early', 'same', 'late']);
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.now).toBe(210);
  });

  it('treats negative delays as immediate', () => {
    const scheduler = new ManualScheduler();
    const seen: number[] = [];
    scheduler.schedule(() => seen.push(1), -5);
    scheduler.advance(0);
    expect(seen).toEqual([1]);
  });

  it('ignores negative advances', () => {
    const scheduler = new ManualScheduler();
    scheduler.advance(-100);
    expect(scheduler.now).toBe(0);
  });

  it('runs tasks scheduled while draining', () => {
    const scheduler = new ManualScheduler();
    const order: string[] = [];
    scheduler.schedule(() => {
      order.push('first');
      scheduler.schedule(() => order.push('second'), 50);
    }, 10);
    scheduler.runAll();
    expect(order).toEqual(['first', 'second']);
    expect(scheduler.now).toBe(60);
  });

  it('guards against a task that reschedules forever', () => {
    const scheduler = new ManualScheduler();
    const loop = (): void => {
      scheduler.schedule(loop, 1);
    };
    loop();
    expect(() => scheduler.runAll()).toThrow(/did not drain/);
  });
});

describe('built-in schedulers', () => {
  it('immediateScheduler defers to a microtask', async () => {
    const seen: string[] = [];
    immediateScheduler(() => seen.push('run'), 1_000);
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual(['run']);
  });

  it('timeoutScheduler defers by the requested delay', () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      timeoutScheduler(() => seen.push('run'), 50);
      vi.advanceTimersByTime(49);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(['run']);
    } finally {
      vi.useRealTimers();
    }
  });
});
