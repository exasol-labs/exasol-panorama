import { describe, expect, it } from 'vitest';
import { EMPTY_COUNTERS, FrameStatsCollector } from '@panorama/renderer';

const counters = { ...EMPTY_COUNTERS, tables: 1, renderedRows: 40, quads: 500 };

describe('FrameStatsCollector', () => {
  it('measures CPU time per frame', () => {
    let now = 0;
    const stats = new FrameStatsCollector({ clock: () => now });
    stats.beginFrame();
    now = 3.5;
    stats.endFrame(counters, 2);

    expect(stats.stats.cpuMs).toBe(3.5);
    expect(stats.stats.averageCpuMs).toBe(3.5);
    expect(stats.stats.worstCpuMs).toBe(3.5);
    expect(stats.stats.frames).toBe(1);
    expect(stats.stats.drawCalls).toBe(2);
    expect(stats.stats.renderedRows).toBe(40);
  });

  it('smooths the average and keeps the worst case', () => {
    let now = 0;
    const stats = new FrameStatsCollector({ clock: () => now });
    for (const duration of [4, 4, 20, 4]) {
      stats.beginFrame();
      now += duration;
      stats.endFrame(counters);
    }
    expect(stats.stats.worstCpuMs).toBe(20);
    expect(stats.stats.averageCpuMs).toBeGreaterThan(4);
    expect(stats.stats.averageCpuMs).toBeLessThan(20);

    stats.resetPeak();
    expect(stats.stats.worstCpuMs).toBe(0);
  });

  it('reports FPS over a window', () => {
    let now = 0;
    const stats = new FrameStatsCollector({ clock: () => now, windowMs: 100 });
    expect(stats.stats.fps).toBe(0);
    for (let frame = 0; frame < 10; frame += 1) {
      stats.beginFrame();
      now += 10;
      stats.endFrame(counters);
    }
    expect(stats.stats.fps).toBe(100);
  });

  it('uses performance.now by default', () => {
    const stats = new FrameStatsCollector();
    stats.beginFrame();
    stats.endFrame(counters);
    expect(stats.stats.cpuMs).toBeGreaterThanOrEqual(0);
  });
});
