import { describe, expect, it } from 'vitest';
import { VelocityTracker } from '@panorama/table';

describe('VelocityTracker', () => {
  it('starts at rest and ignores the first sample of a gesture', () => {
    const tracker = new VelocityTracker();
    expect(tracker.velocity).toBe(0);
    expect(tracker.sample(100, 1_000)).toBe(0);
  });

  it('builds up a signed velocity while scrolling', () => {
    const tracker = new VelocityTracker();
    tracker.sample(0, 0);
    let velocity = 0;
    for (let time = 16; time <= 320; time += 16) {
      velocity = tracker.sample(50, time);
    }
    // 50 px per 16 ms ≈ 3125 px/s.
    expect(velocity).toBeGreaterThan(2_500);
    expect(velocity).toBeLessThan(3_200);
  });

  it('tracks direction reversal', () => {
    const tracker = new VelocityTracker();
    tracker.sample(0, 0);
    for (let time = 16; time <= 160; time += 16) tracker.sample(50, time);
    expect(tracker.velocity).toBeGreaterThan(0);
    for (let time = 176; time <= 500; time += 16) tracker.sample(-50, time);
    expect(tracker.velocity).toBeLessThan(0);
  });

  it('restarts after a long pause', () => {
    const tracker = new VelocityTracker({ resetAfterMs: 100 });
    tracker.sample(0, 0);
    tracker.sample(50, 16);
    expect(tracker.velocity).not.toBe(0);
    expect(tracker.sample(50, 1_000)).toBe(0);
  });

  it('decays towards zero while idle', () => {
    const tracker = new VelocityTracker({ timeConstantMs: 50, resetAfterMs: 1_000 });
    tracker.sample(0, 0);
    tracker.sample(100, 16);
    const initial = tracker.velocity;
    const decayed = tracker.idle(66);
    expect(Math.abs(decayed)).toBeLessThan(Math.abs(initial));
    expect(tracker.idle(2_000)).toBe(0);
    expect(tracker.velocity).toBe(0);
  });

  it('idles harmlessly before any sample', () => {
    expect(new VelocityTracker().idle(100)).toBe(0);
  });

  it('treats a same-millisecond sample as one millisecond', () => {
    const tracker = new VelocityTracker();
    tracker.sample(0, 500);
    expect(tracker.sample(10, 500)).not.toBeNaN();
  });
});
