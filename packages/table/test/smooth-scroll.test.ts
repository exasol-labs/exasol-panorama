import { describe, expect, it } from 'vitest';
import { SmoothScroll } from '@panorama/table';

describe('SmoothScroll', () => {
  it('eases towards the target and settles exactly on it', () => {
    const scroll = new SmoothScroll({ timeConstantMs: 50 });
    scroll.setBounds(0, 1_000);
    scroll.scrollBy(300);
    expect(scroll.target).toBe(300);
    expect(scroll.current).toBe(0);

    let frames = 0;
    while (!scroll.settled && frames < 200) {
      scroll.update(16);
      frames += 1;
    }
    expect(scroll.current).toBe(300);
    expect(frames).toBeLessThan(30);
  });

  it('is frame-rate independent', () => {
    const at60 = new SmoothScroll({ timeConstantMs: 50, epsilon: 0 });
    const at120 = new SmoothScroll({ timeConstantMs: 50, epsilon: 0 });
    at60.setBounds(0, 1_000);
    at120.setBounds(0, 1_000);
    at60.scrollTo(500);
    at120.scrollTo(500);
    for (let step = 0; step < 6; step += 1) at60.update(16);
    for (let step = 0; step < 12; step += 1) at120.update(8);
    expect(at60.current).toBeCloseTo(at120.current, 6);
  });

  it('clamps to the bounds', () => {
    const scroll = new SmoothScroll();
    scroll.setBounds(0, 100);
    scroll.scrollBy(500);
    expect(scroll.target).toBe(100);
    scroll.scrollBy(-500);
    expect(scroll.target).toBe(0);
  });

  it('re-clamps when the bounds shrink, as when a table is resized', () => {
    const scroll = new SmoothScroll({ initial: 900 });
    scroll.setBounds(0, 1_000);
    scroll.scrollTo(900);
    scroll.setBounds(0, 100);
    expect(scroll.current).toBe(100);
    expect(scroll.target).toBe(100);
  });

  it('inverts nonsensical bounds instead of trapping the scroll', () => {
    const scroll = new SmoothScroll();
    scroll.setBounds(50, 10);
    scroll.scrollTo(1_000);
    expect(scroll.target).toBe(50);
  });

  it('jumps without animating', () => {
    const scroll = new SmoothScroll();
    scroll.setBounds(0, 1_000);
    scroll.jumpTo(400);
    expect(scroll.current).toBe(400);
    expect(scroll.settled).toBe(true);
  });

  it('does nothing for non-positive or settled updates', () => {
    const scroll = new SmoothScroll();
    scroll.setBounds(0, 1_000);
    expect(scroll.update(16)).toBe(0);
    scroll.scrollTo(100);
    expect(scroll.update(0)).toBe(0);
    expect(scroll.update(-5)).toBe(0);
  });
});
